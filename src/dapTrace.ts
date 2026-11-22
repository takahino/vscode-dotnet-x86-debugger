import * as vscode from 'vscode';

/** Long payloads (e.g. hundreds of variables) are cut so the log stays readable. */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Logs DAP traffic between VS Code and netcoredbg to the output channel when "netdbg.trace" is enabled.
 * Used to diagnose issues that only happen inside VS Code (e.g. Variables view or hover showing nothing).
 */
export class DapTraceFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(private readonly output: vscode.OutputChannel) {}

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        if (!vscode.workspace.getConfiguration('netdbg').get<boolean>('trace')) {
            return undefined;
        }
        const log = (direction: string, message: unknown) => {
            let text = JSON.stringify(message);
            if (text.length > MAX_MESSAGE_LENGTH) {
                text = `${text.slice(0, MAX_MESSAGE_LENGTH)}… (${text.length} chars)`;
            }
            this.output.appendLine(`${new Date().toISOString()} ${direction} ${text}`);
        };
        this.output.appendLine(`[trace] session "${session.name}" started`);
        return {
            onWillReceiveMessage: (m) => log('VSCode->dbg', m),
            onDidSendMessage: (m) => log('dbg->VSCode', m),
            onError: (e) => log('ERROR', e.message),
            onExit: (code, signal) => log('EXIT', { code, signal }),
        };
    }
}
