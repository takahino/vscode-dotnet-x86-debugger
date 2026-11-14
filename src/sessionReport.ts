import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { ExceptionLog } from './exceptionLog';
import { ModuleList } from './moduleList';
import { ReportSession, buildReport } from './sessionReportCore';
import { StepHistory } from './stepHistory';
import { ValueTracker } from './valueTracker';

/**
 * "Export Debug Session Report": a Markdown summary of the last dotnet-x86 session (stops with changed values,
 * exceptions, section timings, tracked values, modules), built from what the other views already recorded.
 */
export class SessionReport implements vscode.DebugAdapterTrackerFactory, vscode.Disposable {
    private session: ReportSession | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly stepHistory: StepHistory,
        private readonly exceptionLog: ExceptionLog,
        private readonly moduleList: ModuleList,
        private readonly valueTracker: ValueTracker,
    ) {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === DEBUG_TYPE) {
                    this.session = { name: s.name, program: s.configuration.program ?? s.configuration.processName, request: s.configuration.request, start: Date.now() };
                }
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                if (s.type === DEBUG_TYPE && this.session) {
                    this.session.end = Date.now();
                }
            }),
        );
    }

    createDebugAdapterTracker(): vscode.DebugAdapterTracker {
        return {
            onDidSendMessage: (m: { type?: string; event?: string; body?: { exitCode?: number } }) => {
                if (m.type === 'event' && m.event === 'exited' && this.session) {
                    this.session.exitCode = m.body?.exitCode;
                }
            },
        };
    }

    async export(): Promise<void> {
        if (!this.session) {
            void vscode.window.showErrorMessage(vscode.l10n.t('No .NET x86 debug session has run yet. Debug the program first, then export the report.'));
            return;
        }
        const content = buildReport(
            {
                session: this.session,
                stops: this.stepHistory.getEntries().map((e) => ({
                    n: e.n,
                    time: e.time.getTime(),
                    reason: e.reason,
                    functionName: e.functionName,
                    sourcePath: e.sourcePath,
                    line: e.line,
                    changes: e.locals.flatMap((l) => (l.change ? [{ name: l.name, value: l.value, change: l.change }] : [])),
                })),
                exceptions: this.exceptionLog.getEntries().map((e) => ({ ...e, sourcePath: e.source?.path })),
                tracked: [...this.valueTracker.getHits()],
                modules: this.moduleList.getChildren().map((m) => ({ name: m.name, path: m.path, symbolsLoaded: m.symbolStatus === 'Symbols loaded.' })),
                createdAt: Date.now(),
            },
            (message, ...args) => vscode.l10n.t(message, ...args),
            (p) => vscode.workspace.asRelativePath(p),
        );
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
