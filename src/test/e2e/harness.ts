// E2E harness: drives the real netcoredbg through DapProxy, like VS Code does, against the apps in test/apps.
// Needs the bundled netcoredbg (scripts/build-netcoredbg.ps1), the .NET SDK and the x86 .NET runtime.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DapProxy, ProxyOptions } from '../../dapProxy';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const REPO = path.resolve(__dirname, '..', '..', '..');
export const NETCOREDBG = path.join(REPO, 'debugger', 'netcoredbg-x86', 'netcoredbg.exe');
export const DECOMPILER = path.join(REPO, 'debugger', 'decompiler', 'DotnetX86.Decompiler.dll');
const APPS = path.join(REPO, 'test', 'apps');
const OUT = path.join(os.tmpdir(), 'dotnetx86-e2e');

/** Why the E2E tests cannot run here, or false when they can. */
export const e2eSkip: string | false = fs.existsSync(NETCOREDBG) ? false : `netcoredbg is not built (${NETCOREDBG}): run scripts/build-netcoredbg.ps1`;

const built = new Map<string, string>();

/** Builds test/apps/<name> once per test run; returns its output folder. */
export function buildApp(name: string): string {
    const cached = built.get(name);
    if (cached) {
        return cached;
    }
    const outDir = path.join(OUT, name);
    const result = cp.spawnSync('dotnet', ['build', path.join(APPS, name), '-c', 'Debug', '-o', outDir, '-nologo', '-v', 'q'], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`dotnet build ${name} failed:\n${result.stdout}\n${result.stderr}`);
    }
    built.set(name, outDir);
    return outDir;
}

export function appSource(app: string, file: string): string {
    return path.join(APPS, app, file);
}

/** 1-based line of the "// @marker" comment in a test app source file. */
export function lineOf(file: string, marker: string): number {
    const index = fs.readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes(`// @${marker}`));
    if (index < 0) {
        throw new Error(`marker @${marker} not found in ${file}`);
    }
    return index + 1;
}

type Message = { type: string; seq?: number; command?: string; event?: string; request_seq?: number; success?: boolean; message?: string; body?: any };

export class DapSession {
    readonly events: Message[] = [];
    private readonly proxy: DapProxy;
    private readonly waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
    private seq = 1;

    constructor(options: ProxyOptions = {}) {
        this.proxy = new DapProxy(NETCOREDBG, ['--interpreter=vscode'], path.dirname(NETCOREDBG), (m) => this.receive(m as Message), () => undefined, options);
    }

    /** Sends a request; resolves with the whole response (check `success`). */
    request(command: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Message> {
        const seq = this.seq++;
        const response = this.waitFor((m) => m.type === 'response' && m.request_seq === seq, timeoutMs, `response to ${command}`);
        this.proxy.fromClient({ type: 'request', seq, command, arguments: args });
        return response;
    }

    /** Resolves with the next message (from now on) that matches. */
    waitFor(match: (m: Message) => boolean, timeoutMs = 30_000, what = 'message'): Promise<Message> {
        return new Promise((resolve, reject) => {
            const waiter = { match, resolve: (m: Message) => { clearTimeout(timer); resolve(m); } };
            const timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                reject(new Error(`timed out waiting for ${what}`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    nextStop(timeoutMs = 30_000): Promise<Message> {
        return this.waitFor((m) => m.type === 'event' && m.event === 'stopped', timeoutMs, 'a stop');
    }

    nextStopOrEnd(timeoutMs = 30_000): Promise<Message> {
        return this.waitFor((m) => m.type === 'event' && (m.event === 'stopped' || m.event === 'terminated'), timeoutMs, 'a stop or the end');
    }

    /** initialize, launch, the breakpoints by file, configurationDone; resolves with the first stop (if `waitForStop`). */
    async launch(program: string, breakpoints: Record<string, any[]> = {}, extra: Record<string, unknown> = {}): Promise<void> {
        await this.request('initialize', { adapterID: 'dotnet-x86', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
        const launched = await this.request('launch', { program, cwd: path.dirname(program), args: [], ...extra });
        if (!launched.success) {
            throw new Error(`launch failed: ${launched.message}`);
        }
        for (const [file, list] of Object.entries(breakpoints)) {
            await this.request('setBreakpoints', { source: { path: file }, breakpoints: list });
        }
        await this.request('configurationDone');
    }

    async topFrame(threadId: number): Promise<any> {
        const r = await this.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
        return r.body.stackFrames[0];
    }

    async frames(threadId: number, levels = 20): Promise<any[]> {
        return (await this.request('stackTrace', { threadId, startFrame: 0, levels })).body.stackFrames;
    }

    async evaluate(expression: string, frameId: number): Promise<Message> {
        return this.request('evaluate', { expression, frameId, context: 'watch' });
    }

    /** Continues and resolves with the next stop or the end of the program. */
    async continueTo(threadId: number, timeoutMs = 30_000): Promise<Message> {
        const next = this.nextStopOrEnd(timeoutMs);
        await this.request('continue', { threadId });
        return next;
    }

    async close(): Promise<void> {
        await this.request('disconnect', { terminateDebuggee: true }, 5_000).catch(() => undefined);
        // Only the netcoredbg this session started (never by process name: the user may be debugging too).
        this.proxy.dispose();
    }

    private receive(m: Message): void {
        if (m.type === 'event') {
            this.events.push(m);
        }
        for (let i = this.waiters.length - 1; i >= 0; i--) {
            if (this.waiters[i].match(m)) {
                this.waiters.splice(i, 1)[0].resolve(m);
            }
        }
    }
}
