import * as vscode from 'vscode';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RESUME_COMMANDS = new Set(['continue', 'next', 'stepIn', 'stepOut']);

/**
 * PerfTips (as in Visual Studio): after a step or continue stops again, shows the elapsed time at the end of the
 * stopped line. The time includes the debugger's own overhead, hence "≤".
 */
export class PerfTips implements vscode.DebugAdapterTrackerFactory, vscode.Disposable {
    private readonly decoration = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 2em',
        },
    });
    private shown: { path: string; line: number; text: string } | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(vscode.window.onDidChangeVisibleTextEditors(() => this.render()));
    }

    createDebugAdapterTracker(): vscode.DebugAdapterTracker {
        let resumedAt: number | undefined;
        let elapsedForThread: { threadId: number; ms: number } | undefined;
        const stackTraceRequests = new Map<number, number>(); // request seq -> threadId

        return {
            onWillReceiveMessage: (m: any) => {
                if (m.type !== 'request') {
                    return;
                }
                if (RESUME_COMMANDS.has(m.command)) {
                    resumedAt = Date.now();
                    elapsedForThread = undefined;
                    this.clear();
                } else if (m.command === 'stackTrace' && elapsedForThread && m.arguments?.threadId === elapsedForThread.threadId) {
                    stackTraceRequests.set(m.seq, m.arguments.threadId);
                }
            },
            onDidSendMessage: (m: any) => {
                if (m.type === 'event' && m.event === 'stopped') {
                    if (resumedAt !== undefined && m.body?.threadId !== undefined) {
                        elapsedForThread = { threadId: m.body.threadId, ms: Date.now() - resumedAt };
                    }
                    resumedAt = undefined;
                } else if (m.type === 'event' && (m.event === 'continued' || m.event === 'terminated')) {
                    this.clear();
                } else if (m.type === 'response' && m.command === 'stackTrace' && stackTraceRequests.has(m.request_seq)) {
                    stackTraceRequests.delete(m.request_seq);
                    const frame = m.body?.stackFrames?.[0];
                    if (elapsedForThread && frame?.source?.path && vscode.workspace.getConfiguration('netdbg.perfTips').get<boolean>('enabled', true)) {
                        this.shown = { path: frame.source.path, line: frame.line - 1, text: vscode.l10n.t('≤ {0} elapsed', formatElapsed(elapsedForThread.ms)) };
                        elapsedForThread = undefined;
                        this.render();
                    }
                }
            },
            onExit: () => this.clear(),
        };
    }

    dispose(): void {
        this.decoration.dispose();
        this.disposables.forEach((d) => d.dispose());
    }

    private clear(): void {
        this.shown = undefined;
        this.render();
    }

    private render(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const match = this.shown && samePath(editor.document.uri.fsPath, this.shown.path) && this.shown.line < editor.document.lineCount;
            if (!match || !this.shown) {
                editor.setDecorations(this.decoration, []);
                continue;
            }
            const end = editor.document.lineAt(this.shown.line).range.end;
            editor.setDecorations(this.decoration, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: this.shown.text } } }]);
        }
    }
}

export function formatElapsed(ms: number): string {
    return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function samePath(a: string, b: string): boolean {
    return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
}
