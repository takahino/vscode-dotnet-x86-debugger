import * as cp from 'child_process';
import * as path from 'path';

/** Answer of the helper: the frame is shown, or why not. */
export type HighlightResult = 'ok' | 'gone' | 'hidden' | 'minimized' | { error: string };

/** The first request also waits for PowerShell to start and compile the helper (about a second). */
const ANSWER_TIMEOUT_MS = 15_000;

/**
 * Frames a window of the debugged program on the screen (resources/windowHighlight.ps1). The helper is a
 * long-lived Windows PowerShell process, started on first use: drawing needs a message loop, and starting
 * PowerShell for every click would take a second each time.
 */
export class WindowHighlighter {
    private helper: cp.ChildProcessWithoutNullStreams | undefined;
    private readonly waiting: ((answer: string) => void)[] = [];
    private received = '';

    constructor(
        private readonly extensionPath: string,
        private readonly log: (line: string) => void,
    ) {}

    highlight(hwnd: string, label: string): Promise<HighlightResult> {
        const helper = this.start();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const i = this.waiting.indexOf(onAnswer);
                if (i >= 0) {
                    this.waiting.splice(i, 1);
                }
                resolve({ error: 'the highlight helper did not answer' });
            }, ANSWER_TIMEOUT_MS);
            const onAnswer = (answer: string) => {
                clearTimeout(timer);
                resolve(answer === 'ok' || answer === 'gone' || answer === 'hidden' || answer === 'minimized' ? answer : { error: answer.replace(/^error\s*/, '') });
            };
            this.waiting.push(onAnswer);
            // One request per line: the label must not contain the separators.
            helper.stdin.write(`${hwnd}\t${label.replace(/[\t\r\n]+/g, ' ')}\n`, 'utf8');
        });
    }

    dispose(): void {
        // Only the helper this extension started; ending its input also ends it.
        this.helper?.stdin.end();
        this.helper?.kill();
        this.helper = undefined;
    }

    private start(): cp.ChildProcessWithoutNullStreams {
        if (this.helper && this.helper.exitCode === null) {
            return this.helper;
        }
        const script = path.join(this.extensionPath, 'resources', 'windowHighlight.ps1');
        const helper = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
        helper.stdout.setEncoding('utf8');
        helper.stdout.on('data', (chunk: string) => {
            this.received += chunk;
            let newline: number;
            while ((newline = this.received.indexOf('\n')) >= 0) {
                const answer = this.received.slice(0, newline).trim();
                this.received = this.received.slice(newline + 1);
                this.waiting.shift()?.(answer);
            }
        });
        helper.stderr.on('data', (d: Buffer) => this.log(`[highlight] ${d.toString().trimEnd()}`));
        helper.on('error', (e) => this.log(`[highlight] could not start PowerShell: ${e.message}`));
        helper.on('exit', (code) => {
            this.log(`[highlight] helper exited with code ${code}`);
            // Requests still waiting will not be answered any more.
            this.waiting.splice(0).forEach((answer) => answer('error the highlight helper stopped'));
            if (this.helper === helper) {
                this.helper = undefined;
            }
        });
        this.helper = helper;
        return helper;
    }
}
