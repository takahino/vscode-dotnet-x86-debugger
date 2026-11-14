// DAP relay between VS Code and netcoredbg that adds what netcoredbg lacks: logpoints, hit-count breakpoints
// and readable exception filter labels. Kept free of the vscode module so it can be exercised directly against netcoredbg.

import * as cp from 'child_process';

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
/** Custom DAP event for every exception thrown while the exception log is on. */
export const EXCEPTION_EVENT = 'dotnetX86.exceptionThrown';

export interface ExceptionFilterText {
    label: string;
    description: string;
    conditionDescription: string;
}

export interface ProxyOptions {
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
}

interface WriteSite {
    /** normalized path */
    path: string;
    /** path as given, sent back to netcoredbg */
    rawPath: string;
    line: number;
}

interface BreakpointSpec {
    logMessage?: string;
    hitCondition?: string;
}

/** A breakpoint the proxy handles itself: it has a log message and/or a hit condition. */
interface SpecialBreakpoint {
    path: string;
    line: number;
    logMessage?: string;
    hitCondition?: (hits: number) => boolean;
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
    private userExceptionSettings: { filters: string[]; filterOptions: { filterId: string; condition?: string }[] } = { filters: [], filterOptions: [] };

    constructor(
        executable: string,
        args: string[],
        cwd: string,
        private readonly toClient: (message: DapMessage) => void,
        private readonly log: (line: string) => void,
        private readonly options: ProxyOptions = {},
    ) {
        this.child = cp.spawn(executable, args, { cwd, windowsHide: true });
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
        if (message.type === 'request' && message.command === 'setExceptionBreakpoints' && this.options.exceptionLog) {
            message = { ...message, arguments: this.withExceptionLogFilter(message.arguments ?? {}) };
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
            if (hidden) {
                message = { ...message, arguments: { ...args, breakpoints: [...userBreakpoints, ...[...hidden.lines].map((line) => ({ line }))] } };
            }
        }
        this.write(message);
    }

    dispose(): void {
        if (!this.exited) {
            this.child.kill();
        }
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
        if (message.type === 'event' && message.event === 'breakpoint') {
            // Breakpoints bind to their final line once the module loads.
            const bp = message.body?.breakpoint;
            const special = bp && this.specials.get(bp.id);
            if (special && typeof bp.line === 'number') {
                special.line = bp.line;
            }
        }
        if (message.type === 'event' && message.event === 'continued' && this.hiddenContinuedCount > 0) {
            this.hiddenContinuedCount--;
            return;
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'exception' && this.options.exceptionLog) {
            if (await this.handleExceptionStop(message.body.threadId)) {
                return;
            }
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'breakpoint' && (this.specials.size > 0 || this.hiddenLines.size > 0)) {
            if (await this.handleSpecialStop(message.body.threadId)) {
                return;
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
    }

    private recordSpecials(path: string, specs: BreakpointSpec[], breakpoints: any[]): void {
        // setBreakpoints replaces every breakpoint of the source.
        for (const id of this.specialIdsByPath.get(path) ?? []) {
            this.specials.delete(id);
        }
        const ids: number[] = [];
        breakpoints.forEach((bp, i) => {
            const spec = specs[i];
            if (!spec || typeof bp.id !== 'number' || (spec.logMessage === undefined && spec.hitCondition === undefined)) {
                return;
            }
            const hitCondition = spec.hitCondition !== undefined ? parseHitCondition(spec.hitCondition) : undefined;
            if (spec.hitCondition !== undefined && !hitCondition) {
                this.emitEvent('output', {
                    category: 'console',
                    output: `Ignored hit count condition "${spec.hitCondition}": use N, ==N, >=N, >N or %N.\n`,
                });
            }
            this.specials.set(bp.id, { path, line: bp.line, logMessage: spec.logMessage, hitCondition });
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

    /** Keeps the user's settings for later decisions and adds an unconditional "all" filter for the log. */
    private withExceptionLogFilter(args: any): any {
        const filters: string[] = Array.isArray(args.filters) ? args.filters : [];
        const filterOptions: { filterId: string; condition?: string }[] = Array.isArray(args.filterOptions) ? args.filterOptions : [];
        this.userExceptionSettings = { filters, filterOptions };
        return {
            ...args,
            filters: [...new Set([...filters, 'all'])],
            filterOptions: filterOptions.filter((o) => o.filterId !== 'all'),
        };
    }

    /** Whether the user's own "All Exceptions" setting (with its type condition, if any) covers this exception type. */
    private userBreaksOnThrow(typeName: string): boolean {
        if (this.userExceptionSettings.filters.includes('all')) {
            return true;
        }
        return this.userExceptionSettings.filterOptions.some((o) => {
            if (o.filterId !== 'all') {
                return false;
            }
            let condition = (o.condition ?? '').trim();
            if (!condition) {
                return true;
            }
            // Same syntax as netcoredbg: "A, B" breaks on those types, "!A, B" on every type except those.
            const negate = condition.startsWith('!');
            if (negate) {
                condition = condition.slice(1);
            }
            const types = condition.split(/[\s,]+/).filter(Boolean);
            return types.includes(typeName) !== negate;
        });
    }

    /** Logs the exception; returns true when the stop was only for the log and execution resumed. */
    private async handleExceptionStop(threadId: number): Promise<boolean> {
        try {
            const info = await this.request('exceptionInfo', { threadId });
            const typeName: string = info.body?.details?.fullTypeName ?? info.body?.exceptionId ?? '?';
            const breakMode: string = info.body?.breakMode ?? 'always';
            const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: 20 });
            // Exceptions thrown inside the framework have no source on the top frame: report the first user frame.
            const frame = (stack.body?.stackFrames ?? []).find((f: any) => f.source?.path);
            const stops = breakMode !== 'always' || this.userBreaksOnThrow(typeName);
            this.emitEvent(EXCEPTION_EVENT, {
                time: Date.now(),
                typeName,
                message: info.body?.details?.message ?? '',
                breakMode,
                stopped: stops,
                functionName: frame?.name,
                source: frame?.source,
                line: frame?.line,
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
                this.dataWatches.set(name, sites.map((s) => ({ path: normalizePath(s.path), rawPath: s.path, line: s.line })));
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
        const response = await this.request('setBreakpoints', { ...args, breakpoints: [...user, ...hidden] });
        // netcoredbg recreates every breakpoint of the source, so the user's logpoints / hit counts get new ids.
        this.recordSpecials(path, user.map(toSpec), (response.body?.breakpoints ?? []).slice(0, user.length));
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
    };
}

function normalizePath(p: string): string {
    return p.replace(/\//g, '\\').toLowerCase();
}
