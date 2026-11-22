import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { COVERAGE_CHANGED_EVENT, COVERAGE_REQUEST, CoverageLine, CoverageMarks, coverageMarks, coverageSummary, samePath } from './coverageCore';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Code coverage in the editor: while a session counts coverage (launch argument `coverage`, from the setting
 * `netdbg.coverage.enabled`), the engine sends `netdbg.coverageChanged` with the files whose marks changed; the
 * visible editors of those files are colored as run, partly run (some branch outcomes not taken) and not run. The marks
 * stay after the session ends (to review them) and are cleared when the next session starts. The status bar shows the
 * rates; clicking it writes the Cobertura XML.
 */
export class CoverageHighlighter implements vscode.Disposable {
    private readonly decorations = {
        hit: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(40, 160, 70, 0.12)', overviewRulerColor: 'rgba(40, 160, 70, 0.7)', overviewRulerLane: vscode.OverviewRulerLane.Left }),
        partial: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(220, 170, 0, 0.16)', overviewRulerColor: 'rgba(220, 170, 0, 0.8)', overviewRulerLane: vscode.OverviewRulerLane.Left }),
        missed: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: 'rgba(220, 60, 60, 0.12)', overviewRulerColor: 'rgba(220, 60, 60, 0.7)', overviewRulerLane: vscode.OverviewRulerLane.Left }),
    };
    /** Marks per file (path as the engine knows it). */
    private readonly marks = new Map<string, CoverageMarks>();
    private session: vscode.DebugSession | undefined;
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.status.command = 'netdbg.writeCoverage';
        this.status.tooltip = vscode.l10n.t('Code coverage of this debug session (lines run, branches taken). Click to write the Cobertura XML.');
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === DEBUG_TYPE) {
                    this.session = s;
                    this.marks.clear();
                    this.status.hide();
                    this.render();
                }
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                if (s === this.session) {
                    this.session = undefined;
                }
            }),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type === DEBUG_TYPE && e.event === COVERAGE_CHANGED_EVENT) {
                    void this.changed(e.session, e.body ?? {});
                }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => void this.loadVisible()),
            vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('netdbg.coverage.showInEditor') && this.render()),
            vscode.commands.registerCommand('netdbg.writeCoverage', () => this.write()),
        );
    }

    dispose(): void {
        Object.values(this.decorations).forEach((d) => d.dispose());
        this.status.dispose();
        this.disposables.forEach((d) => d.dispose());
    }

    /** The engine counted new lines: update the rates and reread the visible editors of the changed files. */
    private async changed(session: vscode.DebugSession, body: any): Promise<void> {
        this.session = session;
        this.showStatus(body);
        const files: string[] = Array.isArray(body.files) ? body.files : [];
        const visible = vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath);
        await Promise.all(visible.filter((path) => files.some((f) => samePath(f, path)) || !this.marks.has(key(path))).map((path) => this.load(path)));
    }

    /** Editors that became visible while counting. */
    private async loadVisible(): Promise<void> {
        if (this.session) {
            await Promise.all(vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath).filter((path) => !this.marks.has(key(path))).map((path) => this.load(path)));
        }
        this.render();
    }

    private async load(path: string): Promise<void> {
        const session = this.session;
        if (!session) {
            return;
        }
        try {
            const body = await session.customRequest(COVERAGE_REQUEST, { file: path });
            const lines: CoverageLine[] = Array.isArray(body?.lines) ? body.lines : [];
            // A file the engine does not count (not part of the program) gets empty marks, so that it is not asked again
            // until the engine names it as changed.
            this.marks.set(key(path), coverageMarks(lines));
        } catch {
            // The session ended, or it does not count coverage.
        }
        this.render();
    }

    private render(): void {
        const show = vscode.workspace.getConfiguration('netdbg.coverage').get<boolean>('showInEditor', true);
        for (const editor of vscode.window.visibleTextEditors) {
            const marks = show ? this.marks.get(key(editor.document.uri.fsPath)) : undefined;
            const lineRange = (line: number) => editor.document.lineAt(Math.min(line, editor.document.lineCount - 1)).range;
            editor.setDecorations(this.decorations.hit, marks ? marks.hit.map(lineRange) : []);
            editor.setDecorations(this.decorations.missed, marks ? marks.missed.map(lineRange) : []);
            editor.setDecorations(
                this.decorations.partial,
                marks ? marks.partial.map((p) => ({ range: lineRange(p.line), hoverMessage: vscode.l10n.t('Coverage: branches {0}/{1} taken', p.covered, p.valid) })) : [],
            );
        }
    }

    private showStatus(body: any): void {
        this.status.text = `$(beaker) ${coverageSummary(body, { lines: vscode.l10n.t('lines'), branches: vscode.l10n.t('branches') })}`;
        this.status.show();
    }

    /** Writes the Cobertura XML of the debug session (`netdbg.coverage { write }`) and tells where. */
    private async write(): Promise<void> {
        const session = this.session ?? (vscode.debug.activeDebugSession?.type === DEBUG_TYPE ? vscode.debug.activeDebugSession : undefined);
        if (!session) {
            void vscode.window.showErrorMessage(vscode.l10n.t('No .NET x86 debug session is counting coverage. Turn on netdbg.coverage.enabled and start debugging.'));
            return;
        }
        try {
            const folder = vscode.workspace.getConfiguration('netdbg.coverage').get<string>('folder', '').trim();
            const body = await session.customRequest(COVERAGE_REQUEST, folder ? { write: true, folder } : { write: true });
            this.showStatus(body);
            void vscode.window.showInformationMessage(vscode.l10n.t('Coverage written: {0}', String(body?.path ?? '')));
        } catch (e) {
            void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        }
    }
}

function key(path: string): string {
    return path.replace(/\//g, '\\').toLowerCase();
}
