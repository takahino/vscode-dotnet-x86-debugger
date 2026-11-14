// DAP relay between VS Code and netcoredbg that adds what netcoredbg lacks: logpoints, hit-count breakpoints
// and readable exception filter labels. Kept free of the vscode module so it can be exercised directly against netcoredbg.

import * as cp from 'child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */
type DapMessage = { type: string; seq?: number; command?: string; event?: string; request_seq?: number; arguments?: any; body?: any; success?: boolean };

const HEADER_DELIMITER = '\r\n\r\n';
/** Requests the proxy sends itself use seq numbers far above the client's, so their responses can be told apart. */
const OWN_SEQ_BASE = 1_000_000_000;

/** A logpoint whose message starts with this records values for the value trend view instead of printing. */
export const TRACK_PREFIX = '#track:';
/** Custom DAP event carrying the values of a "#track:" logpoint hit. */
export const TRACK_EVENT = 'dotnetX86.trackedValues';
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

    /** setBreakpoints requests waiting for their response, to learn which breakpoint ids need special handling. */
    private readonly pendingSetBreakpoints = new Map<number, { path: string; specs: { logMessage?: string; hitCondition?: string }[] }>();
    private readonly specialIdsByPath = new Map<string, number[]>();
    private readonly specials = new Map<number, SpecialBreakpoint>();
    /**
     * Hit counts by "path:line". VS Code re-sends every breakpoint of a file when one of them changes,
     * so counting by location (not by breakpoint id) keeps the counts across those updates.
     */
    private readonly hits = new Map<string, number>();
    /** The "continued" event caused by resuming after a hidden stop is hidden too: the client never saw the stop. */
    private hideNextContinued = false;
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
        if (message.type === 'request' && message.command === 'setBreakpoints' && message.seq !== undefined) {
            const args = message.arguments ?? {};
            this.pendingSetBreakpoints.set(message.seq, {
                path: normalizePath(args.source?.path ?? ''),
                specs: (args.breakpoints ?? []).map((b: any) => ({
                    logMessage: typeof b.logMessage === 'string' ? b.logMessage : undefined,
                    hitCondition: typeof b.hitCondition === 'string' && b.hitCondition.trim() ? b.hitCondition : undefined,
                })),
            });
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
        if (message.type === 'event' && message.event === 'continued' && this.hideNextContinued) {
            this.hideNextContinued = false;
            return;
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'exception' && this.options.exceptionLog) {
            if (await this.handleExceptionStop(message.body.threadId)) {
                return;
            }
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'breakpoint' && this.specials.size > 0) {
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
        return { ...body, exceptionBreakpointFilters: filters, supportsLogPoints: true, supportsHitConditionalBreakpoints: true };
    }

    private recordSpecialBreakpoints(response: DapMessage): void {
        const pending = this.pendingSetBreakpoints.get(response.request_seq!);
        this.pendingSetBreakpoints.delete(response.request_seq!);
        if (!pending) {
            return;
        }
        // setBreakpoints replaces every breakpoint of the source.
        for (const id of this.specialIdsByPath.get(pending.path) ?? []) {
            this.specials.delete(id);
        }
        const ids: number[] = [];
        const breakpoints: any[] = response.body?.breakpoints ?? [];
        breakpoints.forEach((bp, i) => {
            const spec = pending.specs[i];
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
            this.specials.set(bp.id, { path: pending.path, line: bp.line, logMessage: spec.logMessage, hitCondition });
            ids.push(bp.id);
        });
        this.specialIdsByPath.set(pending.path, ids);
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
                return false;
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

    private async resume(threadId: number): Promise<void> {
        this.hideNextContinued = true;
        await this.request('continue', { threadId });
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

function normalizePath(p: string): string {
    return p.replace(/\//g, '\\').toLowerCase();
}
