import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { APPLY_CHANGES_REQUEST, ApplyChangesResult, CHANGES_APPLIED_EVENT, describeProblems, isCSharpSource, parseResult, presentation } from './editAndContinueCore';
import { isEnabled } from './features';

/**
 * Edit and Continue: applies the edits of the program's C# sources to the program being debugged, without restarting.
 * Saving a .cs file applies it (setting `dotnetX86.editAndContinue.applyOnSave`), and so does the command
 * "Apply Code Changes" (debug toolbar). The engine builds the change with the Roslyn of the installed .NET SDK; changed
 * methods run the new code from their next call, and a stopped method moves to the new code at its next statement.
 */
export class EditAndContinue implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly sessions = new Set<vscode.DebugSession>();
    /** Applying, per session: one request at a time (saves can come quickly). */
    private readonly queues = new Map<string, Promise<void>>();
    /** `dotnetX86.changesApplied` events still to come for our own requests (shown from the response instead). */
    private readonly ownEvents = new Map<string, number>();

    constructor(private readonly output: vscode.OutputChannel) {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === DEBUG_TYPE) this.sessions.add(s);
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                this.sessions.delete(s);
                this.queues.delete(s.id);
                this.ownEvents.delete(s.id);
            }),
            vscode.workspace.onDidSaveTextDocument((d) => this.onSaved(d)),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => this.onEvent(e)),
        );
    }

    /** Command: apply the saved edits of all sources to the active session. */
    async applyCommand(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session || session.type !== DEBUG_TYPE) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Start debugging a .NET x86 program to apply code changes.'));
            return;
        }
        await this.apply(session, undefined, true);
    }

    private onSaved(document: vscode.TextDocument): void {
        if (this.sessions.size === 0 || !isCSharpSource(document.languageId, document.fileName)) return;
        if (!isEnabled('editAndContinue', document.uri)) return;
        if (!vscode.workspace.getConfiguration('dotnetX86.editAndContinue', document.uri).get<boolean>('applyOnSave', true)) return;
        for (const session of this.sessions) {
            void this.apply(session, [document.uri.fsPath], false);
        }
    }

    private apply(session: vscode.DebugSession, files: string[] | undefined, byCommand: boolean): Promise<void> {
        const previous = this.queues.get(session.id) ?? Promise.resolve();
        const next = previous.then(() => this.send(session, files, byCommand));
        this.queues.set(session.id, next);
        return next;
    }

    private async send(session: vscode.DebugSession, files: string[] | undefined, byCommand: boolean): Promise<void> {
        let body: unknown;
        try {
            body = await session.customRequest(APPLY_CHANGES_REQUEST, files ? { files } : {});
        } catch (e) {
            // The session may run netcoredbg (dotnetX86.debuggerPath), be attached, or have Edit and Continue turned off:
            // a save then only logs; the command says why.
            const message = e instanceof Error ? e.message : String(e);
            this.output.appendLine(`[enc] ${message}`);
            if (byCommand) void vscode.window.showErrorMessage(vscode.l10n.t('Could not apply the code changes: {0}', message));
            return;
        }
        this.ownEvents.set(session.id, (this.ownEvents.get(session.id) ?? 0) + 1);
        this.show(parseResult(body), byCommand);
    }

    /** A change applied by someone else (an AI through MCP) is shown too. */
    private onEvent(e: vscode.DebugSessionCustomEvent): void {
        if (e.session.type !== DEBUG_TYPE || e.event !== CHANGES_APPLIED_EVENT) return;
        const own = this.ownEvents.get(e.session.id) ?? 0;
        if (own > 0) {
            this.ownEvents.set(e.session.id, own - 1);
            return;
        }
        this.show(parseResult(e.body), false);
    }

    private show(result: ApplyChangesResult, byCommand: boolean): void {
        if (result.status !== 'noChanges' || byCommand) {
            this.output.appendLine(`[enc] ${result.message}`);
            for (const line of [...describeProblems(result.problems), ...result.details]) this.output.appendLine(`[enc]   ${line}`);
        }
        const shown = presentation(result, byCommand);
        switch (shown.kind) {
            case 'status':
                this.disposables.push(vscode.window.setStatusBarMessage(`$(check) ${shown.text}`, 5000));
                break;
            case 'info':
                void vscode.window.showInformationMessage(shown.text);
                break;
            case 'warning': {
                const restart = vscode.l10n.t('Restart Debugging');
                const details = vscode.l10n.t('Show Details');
                void vscode.window.showWarningMessage(shown.text, restart, details).then((choice) => {
                    if (choice === restart) void vscode.commands.executeCommand('workbench.action.debug.restart');
                    if (choice === details) this.output.show(true);
                });
                break;
            }
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
