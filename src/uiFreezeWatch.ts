import * as cp from 'child_process';
import * as path from 'path';

/**
 * Runs resources/uiFreezeWatch.ps1 for one process: it asks the process's UI threads, a few times a second, whether
 * they still answer window messages, and reports the ones that stopped answering for `thresholdMs`.
 * Kept free of the vscode module.
 */
export class UiFreezeWatch {
    private readonly helper: cp.ChildProcessWithoutNullStreams;
    private received = '';
    private paused = false;

    constructor(
        extensionPath: string,
        processId: number,
        thresholdMs: number,
        onHung: (threadId: number, ms: number) => void,
        log: (line: string) => void,
    ) {
        const script = path.join(extensionPath, 'resources', 'uiFreezeWatch.ps1');
        this.helper = cp.spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(processId), '-ThresholdMs', String(thresholdMs)],
            { windowsHide: true },
        );
        this.helper.stdout.setEncoding('utf8');
        this.helper.stdout.on('data', (chunk: string) => {
            this.received += chunk;
            let newline: number;
            while ((newline = this.received.indexOf('\n')) >= 0) {
                const line = this.received.slice(0, newline).trim();
                this.received = this.received.slice(newline + 1);
                const hung = /^hung (\d+) (\d+)$/.exec(line);
                // A report that crossed a "pause" on the way is about the debugger's own stop: ignore it.
                if (hung && !this.paused) {
                    onHung(Number(hung[1]), Number(hung[2]));
                }
            }
        });
        this.helper.stderr.on('data', (d: Buffer) => log(`[ui freeze] ${d.toString().trimEnd()}`));
        this.helper.on('error', (e) => log(`[ui freeze] could not start PowerShell: ${e.message}`));
    }

    /** The debugger stopped the program: its windows cannot answer, which is not a freeze. */
    pause(): void {
        this.send('pause');
        this.paused = true;
    }

    /** The program runs again; freezes are measured from now on. */
    resume(): void {
        this.paused = false;
        this.send('resume');
    }

    dispose(): void {
        // Only the helper this session started; closing its input also ends it.
        this.helper.stdin.end();
        this.helper.kill();
    }

    private send(command: string): void {
        if (this.helper.exitCode === null && this.helper.stdin.writable) {
            this.helper.stdin.write(`${command}\n`);
        }
    }
}
