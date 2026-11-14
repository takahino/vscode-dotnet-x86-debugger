// DAP relay between VS Code and netcoredbg that adds logpoints, which netcoredbg does not support.
// Kept free of the vscode module so it can be exercised directly against netcoredbg.

import * as cp from 'child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */
type DapMessage = { type: string; seq?: number; command?: string; event?: string; request_seq?: number; arguments?: any; body?: any; success?: boolean };

const HEADER_DELIMITER = '\r\n\r\n';
/** Requests the proxy sends itself use seq numbers far above the client's, so their responses can be told apart. */
const OWN_SEQ_BASE = 1_000_000_000;

interface Logpoint {
    path: string;
    line: number;
    message: string;
}

export class DapProxy {
    private readonly child: cp.ChildProcessWithoutNullStreams;
    private buffer = Buffer.alloc(0);
    private ownSeq = OWN_SEQ_BASE;
    private readonly ownPending = new Map<number, (m: DapMessage) => void>();
    private nextEventSeq = 1;
    private exited = false;
    private queue: Promise<void> = Promise.resolve();

    /** setBreakpoints requests waiting for their response, to learn which breakpoint ids are logpoints. */
    private readonly pendingSetBreakpoints = new Map<number, { path: string; messages: (string | undefined)[] }>();
    private readonly logpointIdsByPath = new Map<string, number[]>();
    private readonly logpoints = new Map<number, Logpoint>();
    /** The "continued" event caused by resuming after a logpoint is hidden: the client never saw the stop. */
    private hideNextContinued = false;

    constructor(
        executable: string,
        args: string[],
        cwd: string,
        private readonly toClient: (message: DapMessage) => void,
        private readonly log: (line: string) => void,
    ) {
        this.child = cp.spawn(executable, args, { cwd, windowsHide: true });
        this.child.stdout.on('data', (d: Buffer) => this.onData(d));
        this.child.stderr.on('data', (d: Buffer) => this.log(`[netcoredbg] ${d.toString()}`));
        this.child.on('error', (e) => this.fail(`netcoredbg を起動できませんでした: ${e.message}`));
        this.child.on('exit', (code) => {
            this.exited = true;
            this.log(`[netcoredbg] exited with code ${code}`);
            // Make sure the session ends even if netcoredbg died without sending "terminated".
            this.emitEvent('terminated');
        });
    }

    /** Message from VS Code. */
    fromClient(message: DapMessage): void {
        if (message.type === 'request' && message.command === 'setBreakpoints' && message.seq !== undefined) {
            const args = message.arguments ?? {};
            this.pendingSetBreakpoints.set(message.seq, {
                path: normalizePath(args.source?.path ?? ''),
                messages: (args.breakpoints ?? []).map((b: any) => (typeof b.logMessage === 'string' ? b.logMessage : undefined)),
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
            message.body = { ...(message.body ?? {}), supportsLogPoints: true };
        }
        if (message.type === 'response' && message.command === 'setBreakpoints' && message.request_seq !== undefined) {
            this.recordLogpoints(message);
        }
        if (message.type === 'event' && message.event === 'breakpoint') {
            // Breakpoints bind to their final line once the module loads.
            const bp = message.body?.breakpoint;
            const logpoint = bp && this.logpoints.get(bp.id);
            if (logpoint && typeof bp.line === 'number') {
                logpoint.line = bp.line;
            }
        }
        if (message.type === 'event' && message.event === 'continued' && this.hideNextContinued) {
            this.hideNextContinued = false;
            return;
        }
        if (message.type === 'event' && message.event === 'stopped' && message.body?.reason === 'breakpoint' && this.logpoints.size > 0) {
            if (await this.handleLogpointStop(message.body.threadId)) {
                return;
            }
        }
        this.toClient(message);
    }

    private recordLogpoints(response: DapMessage): void {
        const pending = this.pendingSetBreakpoints.get(response.request_seq!);
        this.pendingSetBreakpoints.delete(response.request_seq!);
        if (!pending) {
            return;
        }
        // setBreakpoints replaces every breakpoint of the source.
        for (const id of this.logpointIdsByPath.get(pending.path) ?? []) {
            this.logpoints.delete(id);
        }
        const ids: number[] = [];
        const breakpoints: any[] = response.body?.breakpoints ?? [];
        breakpoints.forEach((bp, i) => {
            const message = pending.messages[i];
            if (message !== undefined && typeof bp.id === 'number') {
                this.logpoints.set(bp.id, { path: pending.path, line: bp.line, message });
                ids.push(bp.id);
            }
        });
        this.logpointIdsByPath.set(pending.path, ids);
    }

    /** Returns true when the stop was a logpoint: the message was logged and execution resumed. */
    private async handleLogpointStop(threadId: number): Promise<boolean> {
        try {
            const stack = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
            const frame = stack.body?.stackFrames?.[0];
            if (!frame?.source?.path) {
                return false;
            }
            const path = normalizePath(frame.source.path);
            const logpoint = [...this.logpoints.values()].find((l) => l.path === path && l.line === frame.line);
            if (!logpoint) {
                return false;
            }
            const text = await this.formatMessage(logpoint.message, frame.id, frame.name, threadId);
            this.emitEvent('output', { category: 'console', output: `${text}\n`, source: frame.source, line: frame.line });
            this.hideNextContinued = true;
            await this.request('continue', { threadId });
            return true;
        } catch (e) {
            this.log(`[logpoint] ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
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
            // Other messages are handled in order: a stop being checked for a logpoint must not overtake later events.
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

function normalizePath(p: string): string {
    return p.replace(/\//g, '\\').toLowerCase();
}
