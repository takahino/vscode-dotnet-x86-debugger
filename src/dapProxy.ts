// DAP relay between VS Code and the bundled debug engine (netdbg). The engine does the debugging itself (logpoints,
// hit counts, breakpoint markers, Step Into Target, the SQL / exception logs, the event trace, value watches, the UI
// freeze watch); the relay adds what needs the workspace or the user's machine: readable exception filter labels, the
// Exception Settings view's types, path mapping (sourceFileMap / sourceSearchPaths), Source Link downloads, object IDs,
// Break on Value Change's write sites, and the extension's settings as launch arguments.
// Kept free of the vscode module so it can be exercised directly against the engine.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExceptionSettings, exceptionFiltersForDebugger } from './exceptionFilterCore';
import { MAKE_OBJECT_ID_REQUEST, requestWithDebuggerObjectIds, responseWithClientObjectIds } from './objectIds';
import { fetchBytes } from './httpFetch';
import { readPdbInfo } from './pdbDocuments';
import { SourceLinkEntry, parseSourceLink, resolveSourceLink, sourceCachePath } from './sourceLinkCore';
import { pathKey, SourcePathMapper, UnresolvedSource } from './sourceMapCore';
import { APPLY_CHANGES_REQUEST } from './editAndContinueCore';
import { isBenignEvaluateError, shouldQuietAutomaticEvaluateError } from './evaluateErrorCore';

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

/** A logpoint whose message starts with this records values for the value trend view instead of printing (the engine reads it). */
export const TRACK_PREFIX = '#track:';
/** Custom DAP event carrying the values of a "#track:" logpoint hit. */
export const TRACK_EVENT = 'netdbg.trackedValues';
/** Logpoints marking the start / end of a timed section; the elapsed time is reported like a tracked value. */
export const TIMER_START_PREFIX = '#timer-start:';
export const TIMER_END_PREFIX = '#timer-end:';
/** Custom DAP event asking the extension to remove a temporary ("#once") breakpoint that was just hit. */
export const REMOVE_BREAKPOINT_EVENT = 'netdbg.removeBreakpoint';
/** Custom DAP event for every exception thrown while the exception log is on. */
export const EXCEPTION_EVENT = 'netdbg.exceptionThrown';
/** Custom DAP event for every statement the SQL log reads from a command. */
export const SQL_EVENT = 'netdbg.sqlExecuted';
/** Custom DAP request: trace the firing of these event handlers (arguments: handlers [{breakpointName, label, event?, control?}], or clear). */
export const EVENT_TRACE_REQUEST = 'netdbg.setEventTrace';
/** Custom DAP event for every firing of a traced event handler. */
export const EVENT_TRACE_EVENT = 'netdbg.controlEvent';
/** Custom DAP request: the exception types checked in the Exception Settings view changed (arguments: types). */
export const EXCEPTION_TYPES_REQUEST = 'netdbg.setExceptionTypes';
/** Custom DAP request: freeze / thaw a thread (arguments: threadId, frozen). */
export const FREEZE_THREAD_REQUEST = 'netdbg.freezeThread';
/** Custom DAP request of the engine: the write sites of the watched names (arguments: watches [{name, sites [{path, line}]}]). */
export const VALUE_WATCHES_REQUEST = 'netdbg.setValueWatches';
/** Custom DAP event of the engine, sent just before it pauses on a frozen UI thread (body: threadId, ms). */
export const UI_FROZEN_EVENT = 'netdbg.uiFrozen';
/** Custom DAP request of the engine: the process's memory, CPU, GDI / USER objects, handles and address space. */
export const PROCESS_USAGE_REQUEST = 'netdbg.processUsage';

/** What only the bundled engine says in its initialize capabilities (another debugger, e.g. netcoredbg, is not supported). */
function isBundledEngine(capabilities: any): boolean {
    return capabilities.netdbgSupportsJournal === true && capabilities.supportsLogPoints === true;
}

export interface ExceptionFilterText {
    label: string;
    description: string;
    conditionDescription: string;
}

export interface ProxyOptions {
    /** Extra environment variables for the engine (added to this process's environment), e.g. the symbol folders. */
    env?: Record<string, string>;
    /** Replaces the engine's raw exception filter labels ("all", "user-unhandled"), keyed by filter id. */
    exceptionFilters?: Record<string, ExceptionFilterText>;
    /** Records every thrown exception without stopping (launch argument exceptionLog). */
    exceptionLog?: boolean;
    /** Source lines (1-based) that assign to a member / variable with this name: "Break on Value Change" watches them. */
    findWriteSites?: (name: string) => Promise<{ path: string; line: number }[]>;
    /** Localized message shown when "Set Next Statement" is refused. */
    gotoFailedMessage?: string;
    /**
     * Maps the source paths recorded in PDBs to local files (sourceFileMap / sourceSearchPaths). VS Code only ever
     * sees local paths and the engine only PDB paths: messages are rewritten where they enter and leave the relay.
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
     * it to a URL. Undefined: off. `fetch` replaces the HTTP download (tests).
     */
    sourceLink?: { cacheRoot: string; fetch?: (url: string) => Promise<Buffer> };
    /** Folders with symbols by MVID (downloaded / decompiled), to read their PDBs too. */
    symbolDirs?: string[];
    /** SQL log: the provider methods ("Namespace.Type.Method") that run a command (launch argument sqlLog). Empty: off. */
    sqlMethods?: string[];
    /** The UI freeze watch (launch argument uiFreeze). */
    uiFreeze?: { enabled: boolean; thresholdMs: number };
    /** Console text when the debugger is not the bundled engine (netdbg.debuggerPath pointing at another one). */
    unsupportedEngineMessage?: string;
}

/**
 * Visual Studio 2022 breakpoint options, written in the breakpoint's condition (the engine judges them):
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

export class DapProxy {
    private readonly child: cp.ChildProcessWithoutNullStreams;
    private buffer = Buffer.alloc(0);
    private ownSeq = OWN_SEQ_BASE;
    private readonly ownPending = new Map<number, (m: DapMessage) => void>();
    private nextEventSeq = 1;
    private exited = false;
    private queue: Promise<void> = Promise.resolve();

    /** "goto" (Set Next Statement) requests by seq -> thread id, to report the new position when they succeed. */
    private readonly pendingGotos = new Map<number, number>();
    /** The exception settings the user chose. */
    private userExceptionSettings: ExceptionSettings = { filters: [], filterOptions: [] };
    /** The last setExceptionBreakpoints arguments from VS Code (sent again when the checked types change). */
    private userExceptionArgs: any = {};
    /** Exception types checked in the Exception Settings view: stop when one of them is thrown. */
    private checkedExceptionTypes: string[];
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
    /** The engine pauses because of a UI freeze: its stop is reported as such, on the frozen thread. */
    private pendingFreeze: { threadId: number; ms: number } | undefined;
    /** evaluate request seq -> context, so benign type-name failures do not toast during inline values. */
    private readonly evaluateContexts = new Map<number, string>();

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
        // Before any message: VS Code sends the breakpoints right after initialize, and they must already carry PDB paths.
        if (this.mapper.enabled) {
            for (const module of options.preloadModules ?? []) {
                this.learnModule(module);
            }
        }
        this.child = cp.spawn(executable, args, { cwd, windowsHide: true, env: options.env ? { ...process.env, ...options.env } : process.env });
        this.child.stdout.on('data', (d: Buffer) => this.onData(d));
        this.child.stderr.on('data', (d: Buffer) => this.log(`[engine] ${d.toString()}`));
        this.child.on('error', (e) => this.fail(`Failed to start the debug engine: ${e.message}`));
        this.child.on('exit', (code) => {
            this.exited = true;
            this.log(`[engine] exited with code ${code}`);
            // Make sure the session ends even if the engine died without sending "terminated".
            this.emitEvent('terminated');
        });
    }

    /** Message from VS Code. */
    fromClient(message: DapMessage): void {
        if (message.type === 'request' && this.mapper.enabled && message.arguments) {
            message = { ...message, arguments: mapSourcePaths(message.arguments, (p) => this.mapper.toDebugger(p)) };
            // The files of netdbg.applyChanges are plain paths (not DAP sources): the engine knows the PDB's paths.
            if (message.command === APPLY_CHANGES_REQUEST && Array.isArray(message.arguments.files)) {
                message = { ...message, arguments: { ...message.arguments, files: message.arguments.files.map((f: unknown) => (typeof f === 'string' ? this.mapper.toDebugger(f) : f)) } };
            }
        }
        if (message.type === 'request' && message.command === 'stackTrace' && message.seq !== undefined && !message.arguments?.startFrame) {
            this.pendingStackTraces.add(message.seq);
        }
        if (message.type === 'request' && (message.command === 'launch' || message.command === 'attach')) {
            message = { ...message, arguments: this.withEngineSettings(message.arguments ?? {}) };
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
        if (message.type === 'request' && message.command === 'dataBreakpointInfo') {
            this.respond(message, this.dataBreakpointInfo(message.arguments ?? {}));
            return;
        }
        if (message.type === 'request' && message.command === 'goto' && message.seq !== undefined) {
            this.pendingGotos.set(message.seq, message.arguments?.threadId);
        }
        if (message.type === 'request' && message.command === 'setDataBreakpoints') {
            void this.setValueWatches(message);
            return;
        }
        if (message.type === 'request' && message.command === 'evaluate' && message.seq !== undefined) {
            this.evaluateContexts.set(message.seq, String(message.arguments?.context ?? ''));
        }
        this.write(message);
    }

    dispose(): void {
        if (!this.exited) {
            this.child.kill();
        }
    }

    /** Resolves once the engine has exited (its files, e.g. loaded PDBs, are released then). */
    whenExited(): Promise<void> {
        if (this.exited) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.child.once('exit', () => resolve()));
    }

    private async fromDebugger(message: DapMessage): Promise<void> {
        if (message.type === 'response' && message.command === 'initialize' && message.success) {
            if (!isBundledEngine(message.body ?? {})) {
                this.fail(this.options.unsupportedEngineMessage ?? 'This debugger is not the bundled engine (netdbg). Clear the setting netdbg.debuggerPath.');
            }
            message.body = this.extendCapabilities(message.body ?? {});
        }
        if (message.type === 'event' && message.event === UI_FROZEN_EVENT) {
            // The engine pauses on the frozen UI thread next: its stop gets the localized reason below.
            this.pendingFreeze = { threadId: Number(message.body?.threadId), ms: Number(message.body?.ms) || 0 };
            return;
        }
        if (message.type === 'event' && message.event === 'output' && this.pendingFreeze && String(message.body?.output ?? '').startsWith('UI not responding for ')) {
            return; // the engine's English line: the localized one is written with the stop
        }
        if (message.type === 'response' && message.command === 'goto' && message.request_seq !== undefined) {
            this.finishGoto(message);
            return;
        }
        if (message.type === 'event' && message.event === 'module' && message.body?.reason === 'new' && (this.mapper.enabled || this.options.sourceLink)) {
            // A module loaded after the session started (attach, or loaded on demand): learn its documents.
            const modulePath = message.body.module?.path;
            if (typeof modulePath === 'string') {
                this.learnModule(modulePath);
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
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'pause' && this.pendingFreeze) {
            // Show the frozen UI thread and why.
            const { threadId, ms } = this.pendingFreeze;
            this.pendingFreeze = undefined;
            const description = this.options.freezeDescription?.(ms) ?? `UI not responding for ${(ms / 1000).toFixed(1)} s`;
            message = { ...message, body: { ...message.body, threadId, description, text: description, allThreadsStopped: true } };
            this.emitEvent('output', { category: 'console', output: `${description}\n` });
        }
        if (message.type === 'response' && message.command === 'evaluate' && message.request_seq !== undefined) {
            const ctx = this.evaluateContexts.get(message.request_seq);
            this.evaluateContexts.delete(message.request_seq);
            if (!message.success && shouldQuietAutomaticEvaluateError(ctx) && isBenignEvaluateError(message.message)) {
                message = {
                    ...message,
                    success: true,
                    message: undefined,
                    body: { result: '', variablesReference: 0, presentationHint: { attributes: ['rawString'] } },
                };
            }
        }
        this.toClient(message);
    }

    /** The launch / attach arguments with the extension's settings (the SQL log, ...); launch.json wins. */
    private withEngineSettings(args: any): any {
        const settings: any = {};
        if (this.options.sqlMethods?.length) {
            settings.sqlLog = { enabled: true, methods: this.options.sqlMethods };
        }
        if (this.options.exceptionLog) {
            settings.exceptionLog = { enabled: true, snapshot: this.options.exceptionSnapshot !== false };
        }
        // The engine watches by default: an explicit setting also turns it off.
        if (this.options.uiFreeze) {
            settings.uiFreeze = this.options.uiFreeze;
        }
        return { ...settings, ...args };
    }

    private extendCapabilities(body: any): any {
        const labels = this.options.exceptionFilters ?? {};
        const filters = (body.exceptionBreakpointFilters ?? []).map((f: any) => ({
            ...f,
            ...(labels[f.filter] ?? {}),
            // The engine filters by exception type names ("A, B", or "!A" to exclude).
            supportsCondition: true,
        }));
        return { ...body, exceptionBreakpointFilters: filters, supportsDataBreakpoints: Boolean(this.options.findWriteSites) };
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
    /** The user's exception breakpoints merged with the types checked in the Exception Settings view. */
    private exceptionArgsForDebugger(): any {
        const merged = exceptionFiltersForDebugger(this.userExceptionSettings, this.checkedExceptionTypes, false);
        return { ...this.userExceptionArgs, ...merged };
    }

    /** The Exception Settings view changed: takes effect at once, also while the program runs. */
    private async setCheckedExceptionTypes(message: DapMessage): Promise<void> {
        const types = message.arguments?.types;
        this.checkedExceptionTypes = Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string') : [];
        await this.request('setExceptionBreakpoints', this.exceptionArgsForDebugger());
        this.respond(message, {});
    }
    /**
     * Set Next Statement: on success a "goto" stop makes VS Code fetch the new position; the engine's bare reason
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

    /**
     * Break on Value Change: the write sites are found here (the engine has
     * no workspace) and handed over; the engine stops when a write changes the value.
     */
    private async setValueWatches(message: DapMessage): Promise<void> {
        const watches: { name: string; sites: { path: string; line: number }[] }[] = [];
        for (const bp of message.arguments?.breakpoints ?? []) {
            const name = String(bp.dataId ?? '');
            const sites = name && this.options.findWriteSites ? await this.options.findWriteSites(name) : [];
            // Write sites are workspace (local) files; the engine knows the PDB's paths.
            watches.push({ name, sites: sites.map((s) => ({ path: this.mapper.toDebugger(s.path), line: s.line })) });
        }
        const r = await this.request(VALUE_WATCHES_REQUEST, { watches: watches.filter((w) => w.sites.length > 0) });
        if (!r.success) {
            this.toClient({ type: 'response', seq: this.nextEventSeq++, request_seq: message.seq, command: message.command, success: false, message: r.message, body: {} });
            return;
        }
        const results = watches.map(({ name, sites }) =>
            sites.length
                ? { verified: true, message: `${name}: ${sites.length} assignment(s) watched` }
                : { verified: false, message: `No assignment to ${name} was found in the workspace's C# files.` },
        );
        this.respond(message, { breakpoints: results });
    }

    /** Answers a request from VS Code directly, without the engine. */
    private respond(request: DapMessage, body: unknown): void {
        this.toClient({ type: 'response', seq: this.nextEventSeq++, request_seq: request.seq, command: request.command, success: true, body });
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
        // Every expression that reaches the engine
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
                this.log(`[proxy] invalid JSON from the engine: ${json}`);
                continue;
            }
            // Responses to the proxy's own requests resolve immediately: the queued handler may be waiting for them.
            if (message.type === 'response' && message.request_seq !== undefined && message.request_seq >= OWN_SEQ_BASE) {
                this.ownPending.get(message.request_seq)?.(message);
                this.ownPending.delete(message.request_seq);
                continue;
            }
            // Other messages are handled in order: a stack trace waiting for a Source Link download must not be overtaken.
            this.queue = this.queue.then(() => this.fromDebugger(message)).catch((e) => this.log(`[proxy] ${e}`));
        }
    }
    private fail(message: string): void {
        this.log(`[proxy] ${message}`);
        this.emitEvent('output', { category: 'stderr', output: `${message}\n` });
    }
    /** Every message to VS Code goes through here: PDB paths become local ones and object IDs the client's. */
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
