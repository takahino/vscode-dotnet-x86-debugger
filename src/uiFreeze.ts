import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { FREEZE_PAUSE_REQUEST } from './dapProxy';
import { UiFreezeWatch } from './uiFreezeWatch';

/**
 * Requests after which the program runs freely; the watch resumes only then. Steps are left out (stepping over a slow
 * call is not a freeze), and so is the "continued" event, which netcoredbg also sends for steps.
 */
const RESUMING_REQUESTS = new Set(['continue', 'reverseContinue']);

/**
 * Breaks into the program when its UI stops responding (Visual Studio has no such option): while the program runs, a
 * helper watches its UI threads, and one that does not answer window messages for the configured time is paused,
 * showing the code that holds it up.
 */
export class UiFreezeDetector implements vscode.DebugAdapterTrackerFactory {
    constructor(
        private readonly extensionPath: string,
        private readonly output: vscode.OutputChannel,
    ) {}

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
        const config = vscode.workspace.getConfiguration('dotnetX86.uiFreeze', session.workspaceFolder?.uri);
        if (session.type !== DEBUG_TYPE || !config.get<boolean>('enabled', true)) {
            return undefined;
        }
        const thresholdMs = Math.max(500, config.get<number>('thresholdMs', 2000));
        let watch: UiFreezeWatch | undefined;
        // Stopped by the debugger (or a freeze pause on its way): the watch is paused meanwhile.
        let stopped = false;
        // The bundled engine watches the UI itself (with these settings, see adapterFactory): no helper then.
        let engineWatches = false;

        const onHung = (threadId: number, ms: number) => {
            if (stopped) {
                return;
            }
            stopped = true;
            watch?.pause();
            this.output.appendLine(`[ui freeze] thread ${threadId} did not answer for ${ms} ms: pausing`);
            session.customRequest(FREEZE_PAUSE_REQUEST, { threadId, ms }).then(undefined, (e: unknown) => {
                this.output.appendLine(`[ui freeze] pause failed: ${e instanceof Error ? e.message : String(e)}`);
                stopped = false;
                watch?.resume();
            });
        };

        return {
            onWillReceiveMessage: (m: { type?: string; command?: string }) => {
                if (m.type === 'request' && m.command && RESUMING_REQUESTS.has(m.command)) {
                    stopped = false;
                    watch?.resume();
                }
            },
            onDidSendMessage: (m: { type?: string; event?: string; command?: string; body?: { systemProcessId?: number; dotnetX86SupportsUiFreeze?: boolean } }) => {
                if (m.type === 'response' && m.command === 'initialize') {
                    engineWatches = m.body?.dotnetX86SupportsUiFreeze === true;
                }
                if (m.type !== 'event' || engineWatches) {
                    return;
                }
                if (m.event === 'process' && m.body?.systemProcessId && !watch) {
                    watch = new UiFreezeWatch(this.extensionPath, m.body.systemProcessId, thresholdMs, onHung, (line) => this.output.appendLine(line));
                    if (stopped) {
                        watch.pause();
                    }
                } else if (m.event === 'stopped') {
                    stopped = true;
                    watch?.pause();
                } else if (m.event === 'terminated' || m.event === 'exited') {
                    watch?.dispose();
                    watch = undefined;
                }
            },
            onExit: () => {
                watch?.dispose();
                watch = undefined;
            },
        };
    }
}
