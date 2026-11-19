// DAP relay between VS Code and netcoredbg that adds what netcoredbg lacks: logpoints, hit-count breakpoints
// and readable exception filter labels. Kept free of the vscode module so it can be exercised directly against netcoredbg.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SNAPSHOT_LIMITS, SnapshotFrame, snapshotFrames, snapshotLocals } from './exceptionSnapshotCore';
import { breaksOnThrow, ExceptionSettings, exceptionFiltersForDebugger } from './exceptionFilterCore';
import { MAKE_OBJECT_ID_REQUEST, requestWithDebuggerObjectIds, responseWithClientObjectIds } from './objectIds';
import { fetchBytes } from './httpFetch';
import { readPdbInfo } from './pdbDocuments';
import { SourceLinkEntry, parseSourceLink, resolveSourceLink, sourceCachePath } from './sourceLinkCore';
import { ExpressionReader, captureSqlCommand } from './sqlLogCore';
import { findCallTargets } from './stepTargets';
import { pathKey, SourcePathMapper, UnresolvedSource } from './sourceMapCore';
import { APPLY_CHANGES_REQUEST } from './editAndContinueCore';

/* eslint-disable @typescript-eslint/no-explicit-any */
type DapMessage = {
    type: string;
    seq?: number;
    command?: string;
    event?: string;
    request_seq?: number;
    arguments?: any;
    body?: any;
    success?: boolean;
    message?: string;
};

const HEADER_DELIMITER = '\r\n\r\n';
/** Requests the proxy sends itself use seq numbers far above the client's, so their responses can be told apart. */
const OWN_SEQ_BASE = 1_000_000_000;

/** A logpoint whose message starts with this records values for the value trend view instead of printing. */
export const TRACK_PREFIX = '#track:';
/** Custom DAP event carrying the values of a "#track:" logpoint hit. */
export const TRACK_EVENT = 'dotnetX86.trackedValues';
/** Logpoints marking the start / end of a timed section; the elapsed time is reported like a tracked value. */
export const TIMER_START_PREFIX = '#timer-start:';
export const TIMER_END_PREFIX = '#timer-end:';
/** Custom DAP event asking the extension to remove a temporary ("#once") breakpoint that was just hit. */
export const REMOVE_BREAKPOINT_EVENT = 'dotnetX86.removeBreakpoint';
/** Custom DAP event for every exception thrown while the exception log is on. */
export const EXCEPTION_EVENT = 'dotnetX86.exceptionThrown';
/** Custom DAP event for every statement the SQL log reads from a command (see sqlLogCore). */
export const SQL_EVENT = 'dotnetX86.sqlExecuted';
/** Custom DAP request: trace the firing of these event handlers (arguments: handlers [{breakpointName, label, event?, control?}], or clear). */
export const EVENT_TRACE_REQUEST = 'dotnetX86.setEventTrace';
/** Custom DAP event for every firing of a traced event handler. */
export const EVENT_TRACE_EVENT = 'dotnetX86.controlEvent';
/** Frames of the call stack read with each logged statement (the provider's own frame is the first). */
const SQL_STACK_DEPTH = 12;
/** Custom DAP request: pause because this UI thread stopped answering for `ms` (arguments: threadId, ms). */
export const FREEZE_PAUSE_REQUEST = 'dotnetX86.pauseForFreeze';
/** Custom DAP request: the exception types checked in the Exception Settings view changed (arguments: types). */
export const EXCEPTION_TYPES_REQUEST = 'dotnetX86.setExceptionTypes';
/** Custom DAP request (netcoredbg patch 0010): freeze / thaw a thread (arguments: threadId, frozen). */
export const FREEZE_THREAD_REQUEST = 'dotnetX86.freezeThread';

export interface ExceptionFilterText {
    label: string;
    description: string;
    conditionDescription: string;
}

export interface ProxyOptions {
    /** Extra environment variables for netcoredbg (added to this process's environment). */
    env?: Record<string, string>;
    /** Replaces netcoredbg's raw exception filter labels ("all", "user-unhandled"), keyed by filter id. */
    exceptionFilters?: Record<string, ExceptionFilterText>;
    /** Records every thrown exception without stopping, unless the user's own exception settings ask to stop. */
    exceptionLog?: boolean;
    /**
     * Source lines (1-based) that assign to a member / variable with this name. Enables "Break on Value Change",
     * emulated with hidden breakpoints at those lines: netcoredbg has no data breakpoints.
     */
    findWriteSites?: (name: string) => Promise<{ path: string; line: number }[]>;
    /** Localized message shown when "Set Next Statement" is refused. */
    gotoFailedMessage?: string;
    /**
     * Maps the source paths recorded in PDBs to local files (sourceFileMap / sourceSearchPaths). VS Code only ever
     * sees local paths and netcoredbg only PDB paths: messages are rewritten where they enter and leave the relay.
     */
    sourceMapper?: SourcePathMapper;
    /** Assemblies whose PDB documents are learned before the session starts (the launched program's folder). */
    preloadModules?: string[];
    /** Console text when the source of a stop is not on this machine (shown once per file). */
    missingSourceMessage?: (unresolved: UnresolvedSource) => string;
    /** Reason shown for a pause caused by a UI freeze ("UI not responding for 2.3 s"). */
    freezeDescription?: (ms: number) => string;
    /** Exception types to stop on when thrown, as checked in the Exception Settings view when the session starts. */
    breakOnExceptionTypes?: string[];
    /** Record the call stack and locals with each logged exception (default true). */
    exceptionSnapshot?: boolean;
    /**
     * Source Link: download the source of a stop whose file is not on this machine into this cache, when the PDB maps
     * it to a URL. Undefined: off.  replaces the HTTP download (tests).
     */
    sourceLink?: { cacheRoot: string; fetch?: (url: string) => Promise<Buffer> };
    /** Folders with symbols by MVID (downloaded / decompiled, see netcoredbg patch 0009), to read their PDBs too. */
    symbolDirs?: string[];
    /**
     * SQL log: the provider methods ("Namespace.Type.Method") that run a command. The proxy stops at them without the
     * client noticing, reads the command (SQL_EVENT) and resumes. Needs netcoredbg patch 0013 ("anyCode" function
     * breakpoints, which bind in code without symbols).
     */
    sqlMethods?: string[];
}

interface WriteSite {
    /** normalized path */
    path: string;
    /** path as given, sent back to netcoredbg */
    rawPath: string;
    line: number;
}

/**
 * Visual Studio 2022 breakpoint options, written in the breakpoint's condition (netcoredbg never sees them):
 * `#once` (temporary: removed after the first stop), `#after File.cs:12` (dependent: active only after that
 * breakpoint was reached) and `#changed expr` (stops only when the expression's value changed since the last pass).
 * Not in Visual Studio: `#caller A, B` (stops only when one of these methods is on the call stack; `#caller !A`
 * stops unless it is).
 */
export type BreakpointMarker =
    | { kind: 'once' }
    | { kind: 'after'; target: string }
    | { kind: 'changed'; expression: string }
    | { kind: 'caller'; methods: string[]; negate: boolean };

/** How many callers "#caller" looks at: deep enough for UI event chains, bounded for deep recursion. */
const CALLER_SEARCH_DEPTH = 100;

interface BreakpointSpec {
    logMessage?: string;
    hitCondition?: string;
    marker?: BreakpointMarker;
}

/** A breakpoint the proxy handles itself: it has a log message, a hit condition and/or a marker. */
interface SpecialBreakpoint {
    path: string;
    line: number;
    logMessage?: string;
    hitCondition?: (hits: number) => boolean;
    marker?: BreakpointMarker;
}

export class DapProxy {
    private readonly child: cp.ChildProcessWithoutNullStreams;
    private buffer = Buffer.alloc(0);
    private ownSeq = OWN_SEQ_BASE;
    private readonly ownPending = new Map<number, (m: DapMessage) => void>();
    private nextEventSeq = 1;
    private exited = false;
    private queue: Promise<void> = Promise.resolve();

    /**
     * setBreakpoints requests waiting for their response, to learn which breakpoint ids need special handling.
     * `userCount` is set when hidden write-site breakpoints were appended: only that many go back to VS Code.
     */
    private readonly pendingSetBreakpoints = new Map<number, { path: string; specs: BreakpointSpec[]; userCount?: number }>();
    /** "Break on Value Change" watches by name. */
    private readonly dataWatches = new Map<string, WriteSite[]>();
    /** The latest setBreakpoints arguments VS Code sent per source, to merge the hidden write-site breakpoints into. */
    private readonly userBreakpoints = new Map<string, any>();
    /** Hidden write-site lines per source, sent to netcoredbg together with the user's breakpoints. */
    private hiddenLines = new Map<string, { rawPath: string; lines: Set<number> }>();
    /** Breakpoint locations ("path:line") where execution stopped so far, for dependent ("#after") breakpoints. */
    private readonly reachedLocations = new Set<string>();
    private lastStopLocation: string | undefined;
    /** Temporary ("#once") breakpoints that already stopped once. */
    private readonly firedOnce = new Set<string>();
    /** Last value of each "#changed" breakpoint's expression, by "path:line". */
    private readonly lastChangedValues = new Map<string, string>();
    /** "goto" (Set Next Statement) requests by seq -> thread id, to report the new position when they succeed. */
    private readonly pendingGotos = new Map<number, number>();
    /** Handlers that consume a message from netcoredbg before it is queued (used while the proxy itself steps). */
    private readonly eventWaiters: ((m: DapMessage) => boolean)[] = [];
    private readonly specialIdsByPath = new Map<string, number[]>();
    private readonly specials = new Map<number, SpecialBreakpoint>();
    /**
     * Hit counts by "path:line". VS Code re-sends every breakpoint of a file when one of them changes,
     * so counting by location (not by breakpoint id) keeps the counts across those updates.
     */
    private readonly hits = new Map<string, number>();
    /**
     * How many upcoming "continued" events the proxy caused itself (resuming after a hidden stop, or stepping over a
     * write site); they are hidden because the client never saw the stop. A count, not a flag: the "continued" of a
     * step can still be queued while the proxy already resumes again.
     */
    private hiddenContinuedCount = 0;
    /** Start times of running timers, by "timer name:thread id". */
    private readonly timerStarts = new Map<string, number>();
    /** The exception settings the user chose; with the exception log on, netcoredbg always gets "all" on top. */
    private userExceptionSettings: ExceptionSettings = { filters: [], filterOptions: [] };
    /** The last setExceptionBreakpoints arguments from VS Code (sent again when the checked types change). */
    private userExceptionArgs: any = {};
    /** Exception types checked in the Exception Settings view: stop when one of them is thrown. */
    private checkedExceptionTypes: string[];
    /** Exception snapshots taken in this session (bounded by SNAPSHOT_LIMITS.perSession). */
    private snapshotsTaken = 0;
    /** Source Link maps of the modules loaded so far. */
    private sourceLinks: SourceLinkEntry[] = [];
    /** Source Link downloads by URL (each file is downloaded once; a failed URL is not tried again). */
    private readonly downloads = new Map<string, Promise<string | undefined>>();
    /** Threads frozen with FREEZE_THREAD_REQUEST, and such requests waiting for their response. */
    private readonly frozenThreads = new Set<number>();
    private readonly pendingFreezeRequests = new Map<number, { threadId: number; frozen: boolean }>();
    private readonly mapper: SourcePathMapper;
    /** Assemblies whose PDB documents were already given to the mapper (pathKey). */
    private readonly scannedModules = new Set<string>();
    /** Local files whose missing source was already reported (pathKey). */
    private readonly reportedMissing = new Set<string>();
    /** Client stackTrace requests by seq, to check the source of the top frame in their response. */
    private readonly pendingStackTraces = new Set<number>();
    /** Breakpoint ids VS Code got for each source (in order), so breakpoints the proxy sends again keep those ids. */
    private readonly clientIdsByPath = new Map<string, number[]>();
    /** netcoredbg breakpoint id -> the id VS Code knows, for breakpoints the proxy sent again. */
    private readonly idAliases = new Map<number, number>();
    /** A pause asked for because of a UI freeze: its stop is reported as such, on the frozen thread. */
    private pendingFreeze: { threadId: number; ms: number } | undefined;
    /** Where each frame VS Code was shown at this stop is (PDB path, line), for "Step Into Target". */
    private readonly frameLocations = new Map<number, { path: string; line: number }>();
    /** Targets offered by the last stepInTargets request, by id. */
    private stepTargets = new Map<number, string>();
    /** The user's function breakpoints, sent again (without the step target) once a "Step Into Target" ends. */
    private userFunctionBreakpoints: any[] = [];
    /** A "Step Into Target" in progress: a step over the line with a function breakpoint on the target. */
    private pendingTargetStep: { method: string } | undefined;
    /** The SQL log's provider methods. Their breakpoints are the proxy's: VS Code never sees them. */
    private readonly sqlMethods: string[];
    /** Whether a setFunctionBreakpoints (VS Code's, or the proxy's own for the SQL log) reached netcoredbg. */
    private functionBreakpointsSent = false;
    /** VS Code's setFunctionBreakpoints requests by seq -> how many of the breakpoints in the response are VS Code's. */
    private readonly pendingFunctionBreakpoints = new Map<number, number>();
    /** Event handlers whose firing is traced, by function breakpoint name. Their breakpoints are the proxy's too. */
    private readonly eventTraces = new Map<string, { breakpointName: string; labels: Set<string>; events: Set<string>; controls: Set<string> }>();
    /** Ids of the SQL log's and the event trace's breakpoints: their responses and events are not passed on. */
    private readonly hiddenBreakpointIds = new Set<number>();

    constructor(
        executable: string,
        args: string[],
        cwd: string,
        private readonly sink: (message: DapMessage) => void,
        private readonly log: (line: string) => void,
        private readonly options: ProxyOptions = {},
    ) {
        this.mapper = options.sourceMapper ?? new SourcePathMapper();
        this.checkedExceptionTypes = options.breakOnExceptionTypes ?? [];
        this.sqlMethods = options.sqlMethods ?? [];
        // Before any message: VS Code sends the breakpoints right after initialize, and they must already carry PDB paths.
        if (this.mapper.enabled) {
            for (const module of options.preloadModules ?? []) {
                this.learnModule(module);
            }
        }
        this.child = cp.spawn(executable, args, { cwd, windowsHide: true, env: options.env ? { ...process.env, ...options.env } : process.env });
        this.child.stdout.on('data', (d: Buffer) => this.onData(d));
        this.child.stderr.on('data', (d: Buffer) => this.log(`[netcoredbg] ${d.toString()}`));
        this.child.on('error', (e) => this.fail(`Failed to start netcoredbg: ${e.message}`));
        this.child.on('exit', (code) => {
            this.exited = true;
            this.log(`[netcoredbg] exited with code ${code}`);
            // Make sure the session ends even if netcoredbg died without sending "terminated".
            this.emitEvent('terminated');
        });
    }

    /** Message from VS Code. */
    fromClient(message: DapMessage): void {
        if (message.type === 'request' && this.mapper.enabled && message.arguments) {
            message = { ...message, arguments: mapSourcePaths(message.arguments, (p) => this.mapper.toDebugger(p)) };
            // The files of dotnetX86.applyChanges are plain paths (not DAP sources): the engine knows the PDB's paths.
            if (message.command === APPLY_CHANGES_REQUEST && Array.isArray(message.arguments.files)) {
                message = { ...message, arguments: { ...message.arguments, files: message.arguments.files.map((f: unknown) => (typeof f === 'string' ? this.mapper.toDebugger(f) : f)) } };
            }
        }
        if (message.type === 'request' && message.command === 'stackTrace' && message.seq !== undefined && !message.arguments?.startFrame) {
            this.pendingStackTraces.add(message.seq);
        }
        if (message.type === 'request' && message.command === 'setExceptionBreakpoints') {
            const args = message.arguments ?? {};
            this.userExceptionArgs = args;
            this.userExceptionSettings = {
                filters: Array.isArray(args.filters) ? args.filters : [],
                filterOptions: Array.isArray(args.filterOptions) ? args.filterOptions : [],
            };
            message = { ...message, arguments: this.exceptionArgsForDebugger() };
        }
        if (message.type === 'request' && message.command === FREEZE_THREAD_REQUEST && message.seq !== undefined) {
            this.pendingFreezeRequests.set(message.seq, { threadId: Number(message.arguments?.threadId), frozen: message.arguments?.frozen !== false });
        }
        if (message.type === 'request' && message.command === EXCEPTION_TYPES_REQUEST) {
            void this.setCheckedExceptionTypes(message);
            return;
        }
        if (message.type === 'request' && message.command === FREEZE_PAUSE_REQUEST) {
            void this.pauseForFreeze(message);
            return;
        }
        if (message.type === 'request' && message.command === 'stepInTargets') {
            this.respond(message, { targets: this.stepInTargets(Number(message.arguments?.frameId)) });
            return;
        }
        if (message.type === 'request' && message.command === 'stepIn' && message.arguments?.targetId !== undefined) {
            void this.stepIntoTarget(message);
            return;
        }
        if (message.type === 'request' && message.command === 'setFunctionBreakpoints') {
            this.userFunctionBreakpoints = message.arguments?.breakpoints ?? [];
            if ((this.sqlMethods.length || this.eventTraces.size) && message.seq !== undefined) {
                // The SQL log's and the event trace's breakpoints go along; the response is cut back to VS Code's own.
                this.functionBreakpointsSent = true;
                this.pendingFunctionBreakpoints.set(message.seq, this.userFunctionBreakpoints.length);
                message = { ...message, arguments: { ...message.arguments, breakpoints: this.functionBreakpointsForDebugger() } };
            }
        }
        if (message.type === 'request' && message.command === EVENT_TRACE_REQUEST) {
            void this.setEventTrace(message);
            return;
        }
        if (message.type === 'request' && message.command === 'configurationDone' && this.sqlMethods.length && !this.functionBreakpointsSent) {
            // VS Code sent no function breakpoints (it has none): the SQL log's still have to be set before the program runs.
            void this.setSqlBreakpointsThen(message);
            return;
        }
        if (message.type === 'request' && message.command === 'dataBreakpointInfo') {
            this.respond(message, this.dataBreakpointInfo(message.arguments ?? {}));
            return;
        }
        if (message.type === 'request' && message.command === 'goto' && message.seq !== undefined) {
            this.pendingGotos.set(message.seq, message.arguments?.threadId);
        }
        if (message.type === 'request' && message.command === 'setDataBreakpoints') {
            void this.setDataBreakpoints(message);
            return;
        }
        if (message.type === 'request' && message.command === 'setBreakpoints' && message.seq !== undefined) {
            const args = message.arguments ?? {};
            const path = normalizePath(args.source?.path ?? '');
            const userBreakpoints: any[] = args.breakpoints ?? [];
            this.userBreakpoints.set(path, args);
            const hidden = this.hiddenLines.get(path);
            this.pendingSetBreakpoints.set(message.seq, {
                path,
                specs: userBreakpoints.map(toSpec),
                userCount: hidden ? userBreakpoints.length : undefined,
            });
            const hiddenBreakpoints = hidden ? [...hidden.lines].map((line) => ({ line })) : [];
            message = { ...message, arguments: { ...args, breakpoints: [...userBreakpoints.map(forDebugger), ...hiddenBreakpoints] } };
        }
        this.write(message);
    }

    dispose(): void {
        if (!this.exited) {
            this.child.kill();
        }
    }

    /** Resolves once netcoredbg has exited (its files, e.g. loaded PDBs, are released then). */
    whenExited(): Promise<void> {
        if (this.exited) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.child.once('exit', () => resolve()));
    }

    private async fromDebugger(message: DapMessage): Promise<void> {
        if (message.type === 'response' && message.command === 'initialize' && message.success) {
            message.body = this.extendCapabilities(message.body ?? {});
        }
        if (message.type === 'response' && message.command === 'goto' && message.request_seq !== undefined) {
            this.finishGoto(message);
            return;
        }
        if (message.type === 'response' && message.command === 'setBreakpoints' && message.request_seq !== undefined) {
            this.recordSpecialBreakpoints(message);
        }
        if (message.type === 'response' && message.command === 'setFunctionBreakpoints' && message.request_seq !== undefined) {
            const userCount = this.pendingFunctionBreakpoints.get(message.request_seq);
            if (userCount !== undefined) {
                this.pendingFunctionBreakpoints.delete(message.request_seq);
                this.recordHiddenBreakpoints(message, userCount);
                message = { ...message, body: { ...message.body, breakpoints: (message.body?.breakpoints ?? []).slice(0, userCount) } };
            }
        }
        if (message.type === 'event' && message.event === 'breakpoint' && this.hiddenBreakpointIds.has(message.body?.breakpoint?.id)) {
            return; // a SQL log breakpoint (bound / not bound): not the user's
        }
        if (message.type === 'event' && message.event === 'module' && message.body?.reason === 'new' && (this.mapper.enabled || this.options.sourceLink)) {
            // A module loaded after the session started (attach, or loaded on demand): learn its documents and
            // move breakpoints set under a path it records differently.
            const modulePath = message.body.module?.path;
            if (typeof modulePath === 'string') {
                for (const remapped of this.learnModule(modulePath)) {
                    await this.moveBreakpoints(remapped.previous, remapped.pdbPath);
                }
            }
        }
        if (message.type === 'event' && message.event === 'breakpoint') {
            // Breakpoints bind to their final line once the module loads.
            const bp = message.body?.breakpoint;
            const special = bp && this.specials.get(bp.id);
            if (special && typeof bp.line === 'number') {
                special.line = bp.line;
            }
        }
        if (message.type === 'response' && message.command === FREEZE_THREAD_REQUEST && message.request_seq !== undefined) {
            const pending = this.pendingFreezeRequests.get(message.request_seq);
            this.pendingFreezeRequests.delete(message.request_seq);
            if (pending && message.success) {
                if (pending.frozen) {
                    this.frozenThreads.add(pending.threadId);
                } else {
                    this.frozenThreads.delete(pending.threadId);
                }
            }
        }
        if (message.type === 'response' && message.command === 'threads' && message.success && this.frozenThreads.size) {
            // Frozen threads stay suspended when the program continues: say so in the Call Stack view.
            const threads = (message.body?.threads ?? []).map((t: any) => (this.frozenThreads.has(t.id) ? { ...t, name: `${t.name} [frozen]` } : t));
            message = { ...message, body: { ...message.body, threads } };
        }
        if (message.type === 'response' && message.command === 'stackTrace' && message.success) {
            await this.fetchSourceLinkFiles(message);
            for (const frame of message.body?.stackFrames ?? []) {
                if (typeof frame.id === 'number' && frame.source?.path && typeof frame.line === 'number') {
                    this.frameLocations.set(frame.id, { path: frame.source.path, line: frame.line });
                }
            }
        }
        if (message.type === 'event' && message.event === 'stopped') {
            this.frameLocations.clear(); // frame ids are handed out anew at every stop
            if (this.pendingTargetStep) {
                message = await this.finishTargetStep(message);
            }
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'pause' && this.pendingFreeze) {
            // netcoredbg stops every thread and names some thread; show the frozen UI thread and why.
            const { threadId, ms } = this.pendingFreeze;
            this.pendingFreeze = undefined;
            const description = this.options.freezeDescription?.(ms) ?? `UI not responding for ${(ms / 1000).toFixed(1)} s`;
            message = { ...message, body: { ...message.body, threadId, description, text: description, allThreadsStopped: true } };
            this.emitEvent('output', { category: 'console', output: `${description}\n` });
        }
        if (message.type === 'event' && message.event === 'continued' && this.hiddenContinuedCount > 0) {
            this.hiddenContinuedCount--;
            return;
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'breakpoint' && (this.sqlMethods.length || this.eventTraces.size)) {
            if (await this.handleHookStop(message.body.threadId)) {
                return;
            }
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'exception' && this.options.exceptionLog) {
            if (await this.handleExceptionStop(message.body.threadId)) {
                return;
            }
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'breakpoint' && (this.specials.size > 0 || this.hiddenLines.size > 0)) {
            this.lastStopLocation = undefined;
            if (await this.handleSpecialStop(message.body.threadId)) {
                return;
            }
            if (this.lastStopLocation) {
                this.reachedLocations.add(this.lastStopLocation);
            }
        }
        this.toClient(message);
    }

    private extendCapabilities(body: any): any {
        const labels = this.options.exceptionFilters ?? {};
        const filters = (body.exceptionBreakpointFilters ?? []).map((f: any) => ({
            ...f,
            ...(labels[f.filter] ?? {}),
            // netcoredbg filters by exception type names ("A, B", or "!A" to exclude).
            supportsCondition: true,
        }));
        return {
            ...body,
            exceptionBreakpointFilters: filters,
            supportsLogPoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsDataBreakpoints: Boolean(this.options.findWriteSites),
            supportsStepInTargetsRequest: true,
        };
    }

    private recordSpecialBreakpoints(response: DapMessage): void {
        const pending = this.pendingSetBreakpoints.get(response.request_seq!);
        this.pendingSetBreakpoints.delete(response.request_seq!);
        if (!pending) {
            return;
        }
        const breakpoints: any[] = response.body?.breakpoints ?? [];
        this.recordSpecials(pending.path, pending.specs, breakpoints);
        if (pending.userCount !== undefined) {
            // The hidden write-site breakpoints at the end are not VS Code's.
            response.body = { ...response.body, breakpoints: breakpoints.slice(0, pending.userCount) };
        }
        // VS Code now knows these ids; aliases from earlier re-sends of this source are void.
        const ids = (response.body?.breakpoints ?? []).map((bp: any) => bp.id);
        for (const [alias, id] of this.idAliases) {
            if ((this.clientIdsByPath.get(pending.path) ?? []).includes(id)) {
                this.idAliases.delete(alias);
            }
        }
        this.clientIdsByPath.set(pending.path, ids);
    }

    /** Learns the PDB documents of an assembly once; returns the local files that now map to another PDB path. */
    private learnModule(modulePath: string) {
        const key = pathKey(modulePath);
        if (this.scannedModules.has(key)) {
            return [];
        }
        this.scannedModules.add(key);
        const info = readPdbInfo(modulePath, this.options.symbolDirs);
        if (info.sourceLink) {
            this.sourceLinks.push(...parseSourceLink(info.sourceLink));
        }
        return this.mapper.addDocuments(info.documents);
    }

    /**
     * Frames whose file is not on this machine but has a Source Link URL: downloads the file into the cache (once) and
     * maps the PDB path to it, so VS Code opens it like a local file and breakpoints in it work.
     */
    private async fetchSourceLinkFiles(response: DapMessage): Promise<void> {
        if (!this.options.sourceLink || this.sourceLinks.length === 0) {
            return;
        }
        const pending: Promise<void>[] = [];
        for (const frame of response.body?.stackFrames ?? []) {
            const pdbPath: unknown = frame.source?.path;
            if (typeof pdbPath !== 'string' || fs.existsSync(this.mapper.toLocal(pdbPath))) {
                continue;
            }
            const url = resolveSourceLink(this.sourceLinks, pdbPath);
            if (url) {
                pending.push(this.download(url).then((file) => {
                    if (file) {
                        this.mapper.addFilePairs([{ pdbPath, local: file }]);
                    }
                }));
            }
        }
        await Promise.all(pending);
    }

    private download(url: string): Promise<string | undefined> {
        let download = this.downloads.get(url);
        if (!download) {
            const { cacheRoot, fetch } = this.options.sourceLink!;
            const file = sourceCachePath(cacheRoot, url);
            download = (async () => {
                if (fs.existsSync(file)) {
                    return file;
                }
                try {
                    const bytes = await (fetch ?? fetchBytes)(url);
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, bytes);
                    this.log(`[source link] ${url}`);
                    return file;
                } catch (e) {
                    this.log(`[source link] could not download ${url}: ${e instanceof Error ? e.message : String(e)}`);
                    return undefined;
                }
            })();
            this.downloads.set(url, download);
        }
        return download;
    }

    /** Sends the breakpoints given for `fromPath` again under `toPath` (removing them from the old path). */
    private async moveBreakpoints(fromPath: string, toPath: string): Promise<void> {
        const from = normalizePath(fromPath);
        const to = normalizePath(toPath);
        const args = this.userBreakpoints.get(from);
        if (!args || from === to) {
            return;
        }
        this.log(`[source map] breakpoints moved: ${fromPath} -> ${toPath}`);
        await this.request('setBreakpoints', { ...args, breakpoints: [] });
        this.recordSpecials(from, [], []);
        this.userBreakpoints.delete(from);
        this.userBreakpoints.set(to, { ...args, source: { ...args.source, path: toPath } });
        this.clientIdsByPath.set(to, this.clientIdsByPath.get(from) ?? []);
        this.clientIdsByPath.delete(from);
        await this.resendBreakpoints(to, toPath);
    }

    private recordSpecials(path: string, specs: BreakpointSpec[], breakpoints: any[]): void {
        // setBreakpoints replaces every breakpoint of the source.
        for (const id of this.specialIdsByPath.get(path) ?? []) {
            this.specials.delete(id);
        }
        const ids: number[] = [];
        breakpoints.forEach((bp, i) => {
            const spec = specs[i];
            if (!spec || typeof bp.id !== 'number' || (spec.logMessage === undefined && spec.hitCondition === undefined && !spec.marker)) {
                return;
            }
            const hitCondition = spec.hitCondition !== undefined ? parseHitCondition(spec.hitCondition) : undefined;
            if (spec.hitCondition !== undefined && !hitCondition) {
                this.emitEvent('output', {
                    category: 'console',
                    output: `Ignored hit count condition "${spec.hitCondition}": use N, ==N, >=N, >N or %N.\n`,
                });
            }
            this.specials.set(bp.id, { path, line: bp.line, logMessage: spec.logMessage, hitCondition, marker: spec.marker });
            ids.push(bp.id);
        });
        this.specialIdsByPath.set(path, ids);
    }

    /** Returns true when the stop was handled here (hit count not reached, or a logpoint) and execution resumed. */
    private async handleSpecialStop(threadId: number): Promise<boolean> {
        try {
            const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
            const frame = stack.body?.stackFrames?.[0];
            if (!frame?.source?.path) {
                return false;
            }
            const path = normalizePath(frame.source.path);
            // Added to reachedLocations by fromDebugger only if this stop is shown (a dependent breakpoint waits for a real stop).
            this.lastStopLocation = `${path}:${frame.line}`;
            const special = [...this.specials.values()].find((s) => s.path === path && s.line === frame.line);
            if (!special) {
                // A hidden write-site breakpoint (and not also one of the user's): check whether the value changes.
                const isHidden = this.hiddenLines.get(path)?.lines.has(frame.line) ?? false;
                const isUsers = (this.userBreakpoints.get(path)?.breakpoints ?? []).some((b: any) => b.line === frame.line);
                return isHidden && !isUsers ? this.handleDataWatchStop(threadId, frame, path) : false;
            }

            if (special.hitCondition) {
                const key = `${path}:${frame.line}`;
                const count = (this.hits.get(key) ?? 0) + 1;
                this.hits.set(key, count);
                if (!special.hitCondition(count)) {
                    await this.resume(threadId);
                    return true;
                }
            }
            if (special.marker && !(await this.markerAllowsStop(special.marker, path, frame, threadId))) {
                await this.resume(threadId);
                return true;
            }
            if (special.marker?.kind === 'once') {
                const key = `${path}:${frame.line}`;
                if (this.firedOnce.has(key)) {
                    // Hit again before VS Code removed it.
                    await this.resume(threadId);
                    return true;
                }
                this.firedOnce.add(key);
                // VS Code owns the breakpoint list, so the extension removes the temporary breakpoint there.
                this.emitEvent(REMOVE_BREAKPOINT_EVENT, { source: frame.source, line: frame.line });
            }
            if (special.logMessage === undefined) {
                return false; // A plain breakpoint whose hit condition is met: show the stop.
            }
            if (special.logMessage.startsWith(TIMER_START_PREFIX) || special.logMessage.startsWith(TIMER_END_PREFIX)) {
                this.handleTimer(special.logMessage, threadId, frame);
                await this.resume(threadId);
                return true;
            }
            if (special.logMessage.startsWith(TRACK_PREFIX)) {
                await this.emitTrackedValues(special.logMessage.slice(TRACK_PREFIX.length), frame);
                await this.resume(threadId);
                return true;
            }
            const text = await this.formatMessage(special.logMessage, frame.id, frame.name, threadId);
            this.emitEvent('output', { category: 'console', output: `${text}\n`, source: frame.source, line: frame.line });
            await this.resume(threadId);
            return true;
        } catch (e) {
            this.log(`[proxy] ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * "#after": the target was reached; "#changed": the value differs from the last pass (never on the first pass);
     * "#caller": one of the methods is a caller (the stopped method itself does not count).
     */
    private async markerAllowsStop(marker: BreakpointMarker, path: string, frame: any, threadId: number): Promise<boolean> {
        if (marker.kind === 'caller') {
            const stack = await this.request('stackTrace', { threadId, startFrame: 1, levels: CALLER_SEARCH_DEPTH });
            const callers: string[] = (stack.body?.stackFrames ?? []).map((f: any) => String(f.name ?? ''));
            const called = callers.some((name) => marker.methods.some((m) => frameIsMethod(name, m)));
            return called !== marker.negate;
        }
        if (marker.kind === 'after') {
            const separator = marker.target.lastIndexOf(':');
            const target = marker.target.slice(0, separator);
            // A bare file name matches anywhere; a full path is the user's (local) one, while locations here are PDB paths.
            const file = normalizePath(/[\\/]/.test(target) ? this.mapper.toDebugger(target) : target);
            const line = marker.target.slice(separator + 1);
            return [...this.reachedLocations].some((key) => {
                const at = key.lastIndexOf(':');
                return key.slice(at + 1) === line && (key.slice(0, at) === file || key.slice(0, at).endsWith('\\' + file));
            });
        }
        if (marker.kind === 'changed') {
            const r = await this.request('evaluate', { expression: marker.expression, frameId: frame.id, context: 'watch' });
            const value = r.success ? r.body.result : `<error: ${r.message ?? 'evaluation failed'}>`;
            const key = `${path}:${frame.line}`;
            const previous = this.lastChangedValues.get(key);
            this.lastChangedValues.set(key, value);
            if (previous === undefined || previous === value) {
                return false;
            }
            this.emitEvent('output', { category: 'console', output: `${marker.expression}: ${previous} → ${value}\n`, source: frame.source, line: frame.line });
        }
        return true;
    }

    /**
     * The user's exception breakpoints merged with the types checked in the Exception Settings view. With the exception
     * log on, netcoredbg reports every thrown exception and handleExceptionStop decides whether to stop.
     */
    private exceptionArgsForDebugger(): any {
        const merged = exceptionFiltersForDebugger(this.userExceptionSettings, this.checkedExceptionTypes, Boolean(this.options.exceptionLog));
        return { ...this.userExceptionArgs, ...merged };
    }

    /** The Exception Settings view changed: takes effect at once, also while the program runs. */
    private async setCheckedExceptionTypes(message: DapMessage): Promise<void> {
        const types = message.arguments?.types;
        this.checkedExceptionTypes = Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string') : [];
        if (!this.options.exceptionLog) {
            await this.request('setExceptionBreakpoints', this.exceptionArgsForDebugger());
        }
        this.respond(message, {});
    }

    /** Logs the exception; returns true when the stop was only for the log and execution resumed. */
    /**
     * The call stack and the locals of the first frames of the user's code, while the program is stopped at the throw:
     * the exception log keeps them, so values can be looked at later although the program did not stop.
     */
    private async exceptionSnapshot(stackFrames: any[], stackTrace: unknown): Promise<{ frames: SnapshotFrame[]; stackTrace?: string } | undefined> {
        if (this.options.exceptionSnapshot === false || this.snapshotsTaken >= SNAPSHOT_LIMITS.perSession) {
            return undefined;
        }
        this.snapshotsTaken++;
        const frames = snapshotFrames(stackFrames);
        for (const frame of frames.filter((f) => f.readLocals)) {
            try {
                const scopes = (await this.request('scopes', { frameId: frame.frameId })).body?.scopes ?? [];
                const locals = scopes[0]?.variablesReference ? (await this.request('variables', { variablesReference: scopes[0].variablesReference })).body?.variables ?? [] : [];
                frame.locals = snapshotLocals(locals);
            } catch {
                frame.locals = []; // a frame whose locals cannot be read (e.g. optimized code) still shows in the stack
            }
        }
        return { frames, stackTrace: typeof stackTrace === 'string' ? stackTrace : undefined };
    }

    private async handleExceptionStop(threadId: number): Promise<boolean> {
        try {
            const info = await this.request('exceptionInfo', { threadId });
            const typeName: string = info.body?.details?.fullTypeName ?? info.body?.exceptionId ?? '?';
            const breakMode: string = info.body?.breakMode ?? 'always';
            const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: SNAPSHOT_LIMITS.frames });
            const stackFrames: any[] = stack.body?.stackFrames ?? [];
            // Exceptions thrown inside the framework have no source on the top frame: report the first user frame.
            const frame = stackFrames.find((f: any) => f.source?.path);
            const stops = breakMode !== 'always' || breaksOnThrow(this.userExceptionSettings, this.checkedExceptionTypes, typeName);
            this.emitEvent(EXCEPTION_EVENT, {
                time: Date.now(),
                typeName,
                message: info.body?.details?.message ?? '',
                breakMode,
                stopped: stops,
                functionName: frame?.name,
                source: frame?.source,
                line: frame?.line,
                snapshot: await this.exceptionSnapshot(stackFrames, info.body?.details?.stackTrace),
            });
            const where = frame?.source?.path ? ` at ${frame.source.path.split(/[\\/]/).pop()}:${frame.line}` : '';
            this.emitEvent('output', { category: 'console', output: `${info.body?.description ?? typeName}${where}\n`, source: frame?.source, line: frame?.line });
            if (stops) {
                return false;
            }
            await this.resume(threadId);
            return true;
        } catch (e) {
            this.log(`[proxy] ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * Set Next Statement: on success a "goto" stop makes VS Code fetch the new position; netcoredbg's bare HRESULT
     * on failure is replaced with the reasons it can be refused.
     */
    private finishGoto(response: DapMessage): void {
        const threadId = this.pendingGotos.get(response.request_seq!);
        this.pendingGotos.delete(response.request_seq!);
        if (!response.success) {
            this.toClient({
                ...response,
                message: this.options.gotoFailedMessage ??
                    'The next statement can only be set to a line in the method that is executing, and not into or out of a catch / finally block.',
            });
            return;
        }
        this.toClient(response);
        if (threadId !== undefined) {
            this.emitEvent('stopped', { reason: 'goto', threadId, allThreadsStopped: true });
        }
    }

    /** Only plain names can be found at their write sites (fields, properties, locals); `a.b` or `[0]` cannot. */
    private dataBreakpointInfo(args: any): any {
        const name = String(args.name ?? '');
        if (!this.options.findWriteSites || !/^[A-Za-z_]\w*$/.test(name)) {
            return { dataId: null, description: 'Break on Value Change works for fields, properties and local variables with a plain name.' };
        }
        return { dataId: name, description: name, accessTypes: ['write'], canPersist: false };
    }

    /** Replaces the value-change watches: finds their write sites and (re)sends the affected sources' breakpoints. */
    private async setDataBreakpoints(message: DapMessage): Promise<void> {
        const results: { verified: boolean; message?: string }[] = [];
        this.dataWatches.clear();
        for (const bp of message.arguments?.breakpoints ?? []) {
            const name = String(bp.dataId ?? '');
            const sites = name && this.options.findWriteSites ? await this.options.findWriteSites(name) : [];
            if (sites.length) {
                // Write sites are workspace (local) files; breakpoints go to netcoredbg under the PDB's paths.
                this.dataWatches.set(name, sites.map((s) => {
                    const rawPath = this.mapper.toDebugger(s.path);
                    return { path: normalizePath(rawPath), rawPath, line: s.line };
                }));
                results.push({ verified: true, message: `${name}: ${sites.length} assignment(s) watched` });
            } else {
                results.push({ verified: false, message: `No assignment to ${name} was found in the workspace's C# files.` });
            }
        }

        const previous = this.hiddenLines;
        this.hiddenLines = new Map();
        for (const site of [...this.dataWatches.values()].flat()) {
            const entry = this.hiddenLines.get(site.path) ?? { rawPath: site.rawPath, lines: new Set<number>() };
            entry.lines.add(site.line);
            this.hiddenLines.set(site.path, entry);
        }
        const affected = new Map<string, string>();
        for (const [path, entry] of [...previous, ...this.hiddenLines]) {
            affected.set(path, entry.rawPath);
        }
        for (const [path, rawPath] of affected) {
            await this.resendBreakpoints(path, rawPath);
        }
        this.respond(message, { breakpoints: results });
    }

    /** Sends a source's breakpoints again: the user's (as last sent by VS Code) plus the hidden write sites. */
    private async resendBreakpoints(path: string, rawPath: string): Promise<void> {
        const args = this.userBreakpoints.get(path) ?? { source: { path: rawPath }, breakpoints: [] };
        const user: any[] = args.breakpoints ?? [];
        const hidden = [...(this.hiddenLines.get(path)?.lines ?? [])].map((line) => ({ line }));
        const response = await this.request('setBreakpoints', { ...args, breakpoints: [...user.map(forDebugger), ...hidden] });
        // netcoredbg recreates every breakpoint of the source, so the user's logpoints / hit counts get new ids.
        const recreated: any[] = (response.body?.breakpoints ?? []).slice(0, user.length);
        this.recordSpecials(path, user.map(toSpec), recreated);
        // VS Code still holds the old ids: report the new state under those, and translate later events.
        const clientIds = this.clientIdsByPath.get(path) ?? [];
        recreated.forEach((bp, i) => {
            const clientId = clientIds[i];
            if (typeof bp.id !== 'number' || clientId === undefined) {
                return;
            }
            if (bp.id !== clientId) {
                this.idAliases.set(bp.id, clientId);
            }
            this.emitEvent('breakpoint', { reason: 'changed', breakpoint: { ...bp, id: clientId } });
        });
    }

    /**
     * Stopped at a line that writes a watched name: reads the value, steps over the line and reads it again.
     * Shows a "data breakpoint" stop when it changed; otherwise resumes as if nothing happened.
     */
    private async handleDataWatchStop(threadId: number, frame: any, path: string): Promise<boolean> {
        const names = [...this.dataWatches].filter(([, sites]) => sites.some((s) => s.path === path && s.line === frame.line)).map(([name]) => name);
        const before = new Map<string, string>();
        for (const name of names) {
            const r = await this.request('evaluate', { expression: name, frameId: frame.id, context: 'watch' });
            if (r.success) {
                before.set(name, r.body.result);
            }
        }
        if (before.size === 0) {
            await this.resume(threadId);
            return true;
        }

        const stepped = this.waitForEvent((m) => m.type === 'event' && m.event === 'stopped' && m.body?.threadId === threadId);
        this.hiddenContinuedCount++;
        await this.request('next', { threadId });
        const stop = await stepped;
        if (stop.body?.reason !== 'step') {
            // Stopped somewhere else while stepping over (e.g. a breakpoint in a called method): handle that stop normally.
            await this.fromDebugger(stop);
            return true;
        }
        const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
        const after = stack.body?.stackFrames?.[0];
        const changes: string[] = [];
        for (const [name, old] of before) {
            const r = after ? await this.request('evaluate', { expression: name, frameId: after.id, context: 'watch' }) : undefined;
            if (r?.success && r.body.result !== old) {
                changes.push(`${name}: ${old} → ${r.body.result}`);
            }
        }
        if (changes.length === 0) {
            await this.resume(threadId);
            return true;
        }
        const text = changes.join(', ');
        this.emitEvent('stopped', { reason: 'data breakpoint', description: text, text, threadId, allThreadsStopped: true });
        return true;
    }

    /** Resolves with the next message from netcoredbg that matches, taking it out of the normal flow. */
    private waitForEvent(match: (m: DapMessage) => boolean): Promise<DapMessage> {
        return new Promise((resolve) => {
            this.eventWaiters.push((m) => {
                if (!match(m)) {
                    return false;
                }
                resolve(m);
                return true;
            });
        });
    }

    /** The calls of the frame's current statement, read from its source file (empty when there is none). */
    private stepInTargets(frameId: number): { id: number; label: string; line: number; column: number }[] {
        const location = this.frameLocations.get(frameId);
        this.stepTargets = new Map();
        if (!location) {
            return [];
        }
        let lines: string[];
        try {
            lines = fs.readFileSync(this.mapper.toLocal(location.path), 'utf8').split(/\r?\n/);
        } catch {
            return [];
        }
        return findCallTargets(lines, location.line - 1).map((target, i) => {
            this.stepTargets.set(i + 1, target.method);
            return { id: i + 1, label: target.label, line: location.line + target.lineOffset, column: target.column };
        });
    }

    /**
     * netcoredbg has no step-in targets: steps over the line with a function breakpoint on the target method, so the
     * step ends inside the target if the line calls it, or on the next line if it does not.
     */
    private async stepIntoTarget(message: DapMessage): Promise<void> {
        const threadId = message.arguments?.threadId;
        const method = this.stepTargets.get(Number(message.arguments?.targetId));
        if (!method) {
            const { targetId: _unknown, ...args } = message.arguments ?? {};
            this.write({ ...message, arguments: args });
            return;
        }
        await this.request('setFunctionBreakpoints', { breakpoints: this.functionBreakpointsForDebugger([{ name: method }]) });
        this.pendingTargetStep = { method };
        const r = await this.request('next', { threadId });
        if (!r.success) {
            this.pendingTargetStep = undefined;
            await this.request('setFunctionBreakpoints', { breakpoints: this.functionBreakpointsForDebugger() });
        }
        this.toClient({ type: 'response', seq: this.nextEventSeq++, request_seq: message.seq, command: 'stepIn', success: r.success, message: r.message, body: {} });
    }

    /** The stop that ends a "Step Into Target": the target's breakpoint goes, and arriving in the target is a step. */
    private async finishTargetStep(stop: DapMessage): Promise<DapMessage> {
        const { method } = this.pendingTargetStep!;
        this.pendingTargetStep = undefined;
        await this.request('setFunctionBreakpoints', { breakpoints: this.functionBreakpointsForDebugger() });
        if (stop.body?.reason !== 'breakpoint') {
            return stop;
        }
        // A stop in the target is the step arriving; any other breakpoint on the way is a real breakpoint stop.
        const top = await this.request('stackTrace', { threadId: stop.body.threadId, startFrame: 0, levels: 1 });
        const name = String(top.body?.stackFrames?.[0]?.name ?? '');
        return frameIsMethod(name, method) ? { ...stop, body: { ...stop.body, reason: 'step' } } : stop;
    }

    /** The function breakpoints netcoredbg gets: VS Code's, `extra`, and the SQL log's (which also bind without symbols). */
    private functionBreakpointsForDebugger(extra: any[] = []): any[] {
        const userNames = new Set(this.userFunctionBreakpoints.map((b) => String(b.name)));
        // Handlers are code with symbols, so they need no "anyCode"; one the user also has a breakpoint on is that one.
        const traced = [...this.eventTraces.keys()].filter((name) => !userNames.has(name)).map((name) => ({ name }));
        return [...this.userFunctionBreakpoints, ...extra, ...this.sqlMethods.map((name) => ({ name, anyCode: true })), ...traced];
    }

    /** "Trace Events": records the handlers to trace (or forgets them all) and sets their breakpoints. */
    private async setEventTrace(message: DapMessage): Promise<void> {
        const args = message.arguments ?? {};
        if (args.clear) {
            this.eventTraces.clear();
        }
        for (const h of Array.isArray(args.handlers) ? args.handlers : []) {
            if (typeof h?.breakpointName !== 'string') {
                continue;
            }
            const entry = this.eventTraces.get(h.breakpointName) ?? { breakpointName: h.breakpointName, labels: new Set<string>(), events: new Set<string>(), controls: new Set<string>() };
            if (h.label) { entry.labels.add(String(h.label)); }
            if (h.event) { entry.events.add(String(h.event)); }
            if (h.control) { entry.controls.add(String(h.control)); }
            this.eventTraces.set(h.breakpointName, entry);
        }
        this.functionBreakpointsSent = true;
        const r = await this.request('setFunctionBreakpoints', { breakpoints: this.functionBreakpointsForDebugger() });
        this.recordHiddenBreakpoints(r, this.userFunctionBreakpoints.length);
        this.respond(message, { count: this.eventTraces.size });
    }

    private recordHiddenBreakpoints(response: DapMessage, userCount: number): void {
        for (const bp of (response.body?.breakpoints ?? []).slice(userCount)) {
            if (typeof bp.id === 'number') {
                this.hiddenBreakpointIds.add(bp.id);
            }
        }
    }

    /** VS Code has no function breakpoints: sets the SQL log's, then passes the held request (configurationDone) on. */
    private async setSqlBreakpointsThen(held: DapMessage): Promise<void> {
        this.functionBreakpointsSent = true;
        const r = await this.request('setFunctionBreakpoints', { breakpoints: this.functionBreakpointsForDebugger() });
        this.recordHiddenBreakpoints(r, this.userFunctionBreakpoints.length);
        this.write(held);
    }

    /**
     * The program stopped at a function breakpoint. At one of the SQL log's provider methods or a traced event
     * handler: reads what is needed, reports it and resumes, so VS Code never sees the stop (a step that was running
     * goes on). Returns false for any other stop, and for a handler the user also has a breakpoint on.
     */
    private async handleHookStop(threadId: number): Promise<boolean> {
        let keepStop = false;
        try {
            const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: SQL_STACK_DEPTH });
            const frames: any[] = stack.body?.stackFrames ?? [];
            const nameOf = (frame: any) => String(frame?.name ?? '');
            const isHook = (frame: any) => this.sqlMethods.find((m) => frameIsMethod(nameOf(frame), m));
            const method = isHook(frames[0]);
            if (method) {
                // ExecuteReader() often calls ExecuteReader(behavior): the inner call is the same statement.
                if (!isHook(frames[1])) {
                    await this.reportSql(method, threadId, frames);
                }
            } else {
                const traced = [...this.eventTraces.values()].find((t) => frameIsMethod(nameOf(frames[0]), t.breakpointName));
                if (!traced) {
                    return false;
                }
                await this.reportControlEvent(traced, threadId, frames[0]);
                keepStop = this.userFunctionBreakpoints.some((b) => frameIsMethod(nameOf(frames[0]), String(b.name)));
            }
        } catch (e) {
            this.log(`[proxy] hook stop: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (keepStop) {
            return false;
        }
        await this.resume(threadId);
        return true;
    }

    /** A traced handler was entered: who fired it (the `sender` argument's name, when the handler has one). */
    private async reportControlEvent(traced: { labels: Set<string>; events: Set<string>; controls: Set<string> }, threadId: number, frame: any): Promise<void> {
        const text = async (expression: string): Promise<string | undefined> => {
            const r = await this.request('evaluate', { expression, frameId: frame.id, context: 'watch' });
            return r.success ? String(r.body?.result ?? '').replace(/^"|"$/g, '') : undefined;
        };
        let sender = await text('sender.Name');
        if (!sender) {
            const type = await text('sender.GetType().Name');
            sender = type ? `(${type})` : undefined;
        }
        this.emitEvent(EVENT_TRACE_EVENT, {
            time: Date.now(),
            threadId,
            events: [...traced.events],
            labels: [...traced.labels],
            controls: [...traced.controls],
            sender,
            handler: String(frame.name ?? ''),
            source: frame.source,
            line: frame.line,
        });
    }

    private async reportSql(method: string, threadId: number, frames: any[]): Promise<void> {
        const frameId = frames[0].id;
        const reader: ExpressionReader = {
            evaluate: async (expression) => {
                const r = await this.request('evaluate', { expression, frameId, context: 'watch' });
                return r.success
                    ? { ok: true, result: String(r.body?.result ?? ''), type: r.body?.type, variablesReference: r.body?.variablesReference }
                    : { ok: false, result: '' };
            },
            variables: async (variablesReference) => (await this.request('variables', { variablesReference })).body?.variables ?? [],
        };
        const typeName = method.slice(0, method.lastIndexOf('.'));
        const command = await captureSqlCommand(reader, typeName);
        if (!command) {
            return;
        }
        this.emitEvent(SQL_EVENT, {
            time: Date.now(),
            threadId,
            method,
            typeName,
            ...command,
            // The frames above the provider's: who ran the statement.
            frames: frames.slice(1).map((f) => ({ name: String(f.name ?? ''), source: f.source, line: f.line })),
        });
    }

    /** Pauses the program for a UI freeze; the stop that follows is reported on the frozen thread. */
    private async pauseForFreeze(message: DapMessage): Promise<void> {
        const threadId = Number(message.arguments?.threadId);
        const ms = Number(message.arguments?.ms) || 0;
        this.pendingFreeze = { threadId, ms };
        const r = await this.request('pause', { threadId });
        if (!r.success) {
            this.pendingFreeze = undefined;
        }
        this.toClient({ type: 'response', seq: this.nextEventSeq++, request_seq: message.seq, command: message.command, success: r.success, message: r.message, body: {} });
    }

    /** Answers a request from VS Code directly, without netcoredbg. */
    private respond(request: DapMessage, body: unknown): void {
        this.toClient({ type: 'response', seq: this.nextEventSeq++, request_seq: request.seq, command: request.command, success: true, body });
    }

    private async resume(threadId: number): Promise<void> {
        this.hiddenContinuedCount++;
        await this.request('continue', { threadId });
    }

    /** Records a timer start, or reports the time since the matching start on the same thread. */
    private handleTimer(logMessage: string, threadId: number, frame: any): void {
        const isStart = logMessage.startsWith(TIMER_START_PREFIX);
        const name = logMessage.slice((isStart ? TIMER_START_PREFIX : TIMER_END_PREFIX).length).trim() || 'timer';
        const key = `${name}:${threadId}`;
        if (isStart) {
            this.timerStarts.set(key, Date.now());
            return;
        }
        const startedAt = this.timerStarts.get(key);
        if (startedAt === undefined) {
            return; // the end was reached without passing the start (e.g. the start is in another branch)
        }
        this.timerStarts.delete(key);
        const ms = Date.now() - startedAt;
        // Every pass also includes the debugger's own pause / resume time, hence "≤".
        this.emitEvent(TRACK_EVENT, { source: frame.source, line: frame.line, time: Date.now(), values: [{ expression: `⏱ ${name} (ms)`, value: String(ms), type: 'int' }] });
        this.emitEvent('output', { category: 'console', output: `⏱ ${name}: ≤ ${ms} ms\n`, source: frame.source, line: frame.line });
    }

    /** Evaluates the `;`-separated expressions of a "#track:" logpoint and reports them as a custom event (no console output). */
    private async emitTrackedValues(expressionList: string, frame: any): Promise<void> {
        const values: { expression: string; value: string; type?: string; error?: string }[] = [];
        for (const expression of expressionList.split(';').map((e) => e.trim()).filter(Boolean)) {
            const r = await this.request('evaluate', { expression, frameId: frame.id, context: 'watch' });
            values.push(r.success ? { expression, value: r.body.result, type: r.body.type } : { expression, value: '', error: r.message ?? 'evaluation failed' });
        }
        this.emitEvent(TRACK_EVENT, { source: frame.source, line: frame.line, time: Date.now(), values });
    }

    /** Expands `{expression}` (evaluated in the stopped frame) plus $FUNCTION and $TID, like Visual Studio tracepoints. */
    private async formatMessage(template: string, frameId: number, functionName: string, threadId: number): Promise<string> {
        const parts = template.split(/(\{[^{}]+\})/);
        let result = '';
        for (const part of parts) {
            if (part.startsWith('{') && part.endsWith('}')) {
                const expression = part.slice(1, -1).trim();
                const r = await this.request('evaluate', { expression, frameId, context: 'watch' });
                result += r.success ? r.body.result : `<error: ${r.message ?? 'evaluation failed'}>`;
            } else {
                result += part.replace(/\$FUNCTION/g, functionName).replace(/\$TID/g, String(threadId));
            }
        }
        return result;
    }

    private request(command: string, args: Record<string, unknown>): Promise<DapMessage & { message?: string }> {
        const seq = ++this.ownSeq;
        return new Promise((resolve) => {
            this.ownPending.set(seq, resolve);
            this.write({ seq, type: 'request', command, arguments: args });
        });
    }

    private write(message: DapMessage): void {
        if (this.exited) {
            return;
        }
        // Every expression that reaches netcoredbg, from VS Code or from the proxy itself (logpoints, "#changed"),
        // may use object IDs.
        if (message.type === 'request' && message.arguments) {
            message = { ...message, arguments: requestWithDebuggerObjectIds(message.command, message.arguments) };
        }
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        this.child.stdin.write(`Content-Length: ${body.length}${HEADER_DELIMITER}`);
        this.child.stdin.write(body);
    }

    private onData(data: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, data]);
        for (;;) {
            const headerEnd = this.buffer.indexOf(HEADER_DELIMITER);
            if (headerEnd < 0) {
                return;
            }
            const header = this.buffer.subarray(0, headerEnd).toString('ascii');
            const match = /Content-Length:\s*(\d+)/i.exec(header);
            if (!match) {
                this.log(`[proxy] invalid header dropped: ${header}`);
                this.buffer = this.buffer.subarray(headerEnd + HEADER_DELIMITER.length);
                continue;
            }
            const start = headerEnd + HEADER_DELIMITER.length;
            const end = start + Number(match[1]);
            if (this.buffer.length < end) {
                return;
            }
            const json = this.buffer.subarray(start, end).toString('utf8');
            this.buffer = this.buffer.subarray(end);
            let message: DapMessage;
            try {
                message = JSON.parse(json);
            } catch {
                this.log(`[proxy] invalid JSON from netcoredbg: ${json}`);
                continue;
            }
            // Responses to the proxy's own requests resolve immediately: the queued handler may be waiting for them.
            if (message.type === 'response' && message.request_seq !== undefined && message.request_seq >= OWN_SEQ_BASE) {
                this.ownPending.get(message.request_seq)?.(message);
                this.ownPending.delete(message.request_seq);
                continue;
            }
            // A message the proxy itself is waiting for (the stop after its own step) skips the queue: the queued
            // handler that waits for it would otherwise never get it.
            const waiter = this.eventWaiters.findIndex((w) => w(message));
            if (waiter >= 0) {
                this.eventWaiters.splice(waiter, 1);
                continue;
            }
            // Other messages are handled in order: a stop being checked here must not overtake later events.
            this.queue = this.queue.then(() => this.fromDebugger(message)).catch((e) => this.log(`[proxy] ${e}`));
        }
    }

    private fail(message: string): void {
        this.log(`[proxy] ${message}`);
        this.emitEvent('output', { category: 'stderr', output: `${message}\n` });
    }

    /** Every message to VS Code goes through here: PDB paths become local ones and re-sent breakpoints keep their ids. */
    private toClient(message: DapMessage): void {
        let out = responseWithClientObjectIds(message);
        if (out.type === 'response' && out.command === MAKE_OBJECT_ID_REQUEST && out.success) {
            // Values shown so far do not carry the "{$N}" mark yet: have VS Code read them again.
            this.sink(out);
            this.emitEvent('invalidated', { areas: ['variables'] });
            return;
        }
        if (this.mapper.enabled && out.body) {
            out = { ...out, body: mapSourcePaths(out.body, (p) => this.mapper.toLocal(p)) };
            const details = out.body?.details;
            if (out.type === 'response' && out.command === 'exceptionInfo' && typeof details?.stackTrace === 'string') {
                out.body = { ...out.body, details: { ...details, stackTrace: this.mapper.rewriteText(details.stackTrace) } };
            }
        }
        if (out.type === 'event' && out.event === 'breakpoint' && this.idAliases.has(out.body?.breakpoint?.id)) {
            out = { ...out, body: { ...out.body, breakpoint: { ...out.body.breakpoint, id: this.idAliases.get(out.body.breakpoint.id) } } };
        }
        if (out.type === 'response' && out.command === 'stackTrace' && out.request_seq !== undefined && this.pendingStackTraces.delete(out.request_seq)) {
            this.sink(out);
            this.reportMissingSource(message.body?.stackFrames?.[0]?.source?.path, out.body?.stackFrames?.[0]?.source?.path);
            return;
        }
        this.sink(out);
    }

    /**
     * Says once per file how to make the source of a stop show up, when its file is not on this machine
     * (typically a referenced assembly built elsewhere).
     */
    private reportMissingSource(pdbPath: unknown, localPath: unknown): void {
        if (typeof pdbPath !== 'string' || typeof localPath !== 'string' || !this.options.missingSourceMessage) {
            return;
        }
        const key = pathKey(localPath);
        if (this.reportedMissing.has(key)) {
            return;
        }
        this.reportedMissing.add(key);
        if (fs.existsSync(localPath)) {
            return;
        }
        const unresolved = this.mapper.unresolved(pdbPath) ?? { pdbPath, candidates: [] };
        this.emitEvent('output', { category: 'console', output: `${this.options.missingSourceMessage(unresolved)}\n` });
    }

    private emitEvent(event: string, body?: unknown): void {
        this.toClient({ type: 'event', seq: this.nextEventSeq++, event, body });
    }
}

/**
 * Hit count conditions, as in Visual Studio: "N" or "==N" (the N-th hit), ">=N", ">N" (from the N-th hit on)
 * and "%N" (every N-th hit). Returns undefined for anything else.
 */
export function parseHitCondition(text: string): ((hits: number) => boolean) | undefined {
    const match = /^\s*(==|>=|>|%)?\s*(\d+)\s*$/.exec(text);
    if (!match) {
        return undefined;
    }
    const n = Number(match[2]);
    switch (match[1]) {
        case '>=':
            return (hits) => hits >= n;
        case '>':
            return (hits) => hits > n;
        case '%':
            return n > 0 ? (hits) => hits % n === 0 : undefined;
        default:
            return (hits) => hits === n;
    }
}

function toSpec(b: any): BreakpointSpec {
    return {
        logMessage: typeof b.logMessage === 'string' ? b.logMessage : undefined,
        hitCondition: typeof b.hitCondition === 'string' && b.hitCondition.trim() ? b.hitCondition : undefined,
        marker: parseMarker(b.condition),
    };
}

export function parseMarker(condition: unknown): BreakpointMarker | undefined {
    if (typeof condition !== 'string') {
        return undefined;
    }
    const text = condition.trim();
    if (text === '#once') {
        return { kind: 'once' };
    }
    const after = /^#after\s+(.+:\d+)\s*$/.exec(text);
    if (after) {
        return { kind: 'after', target: after[1] };
    }
    const caller = /^#caller\s+(!?)\s*(.+)$/.exec(text);
    if (caller) {
        const methods = caller[2].split(/[\s,]+/).filter(Boolean);
        return methods.length ? { kind: 'caller', methods, negate: caller[1] === '!' } : undefined;
    }
    const changed = /^#changed\s+(.+)$/.exec(text);
    return changed ? { kind: 'changed', expression: changed[1].trim() } : undefined;
}

/**
 * Whether a stack frame name from netcoredbg ("MyLib.Orders.Save()") is the method `method` names, matched on whole
 * dot-separated parts from the end, ignoring case: "Save", "Orders.Save" and "MyLib.Orders.Save" all match,
 * "SaveAll" does not.
 */
export function frameIsMethod(frameName: string, method: string): boolean {
    const name = frameName.replace(/\(.*$/, '').toLowerCase();
    const wanted = method.replace(/\(.*$/, '').toLowerCase();
    return wanted !== '' && (name === wanted || name.endsWith('.' + wanted));
}

/** The breakpoint as netcoredbg gets it: a marker in the condition is the proxy's, not a C# expression. */
function forDebugger(b: any): any {
    if (!parseMarker(b.condition)) {
        return b;
    }
    const { condition: _marker, ...rest } = b;
    return rest;
}

/**
 * Rewrites the path of every DAP Source object (`source: {path}` and `sources: [{path}]`) anywhere in a message,
 * copying only what changes: the message objects may still be in use by VS Code or by the proxy's own state.
 */
export function mapSourcePaths(value: any, map: (path: string) => string, depth = 0): any {
    if (value === null || typeof value !== 'object' || depth > 16) {
        return value;
    }
    if (Array.isArray(value)) {
        let changed = false;
        const mapped = value.map((v) => {
            const r = mapSourcePaths(v, map, depth + 1);
            changed ||= r !== v;
            return r;
        });
        return changed ? mapped : value;
    }
    let out = value;
    for (const [key, v] of Object.entries(value)) {
        let r = v;
        if (key === 'source' && v && typeof v === 'object' && typeof (v as any).path === 'string') {
            r = mapSource(v, map);
        } else if (key === 'sources' && Array.isArray(v)) {
            r = v.map((s) => (s && typeof s === 'object' && typeof s.path === 'string' ? mapSource(s, map) : s));
        } else if (v && typeof v === 'object') {
            r = mapSourcePaths(v, map, depth + 1);
        }
        if (r !== v) {
            if (out === value) {
                out = { ...value };
            }
            out[key] = r;
        }
    }
    return out;
}

function mapSource(source: any, map: (path: string) => string): any {
    const path = map(source.path);
    return path === source.path ? source : { ...source, path };
}

function normalizePath(p: string): string {
    return p.replace(/\//g, '\\').toLowerCase();
}
