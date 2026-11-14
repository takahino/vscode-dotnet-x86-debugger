import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { EXCEPTION_EVENT } from './dapProxy';

interface ExceptionEntry {
    n: number;
    time: number;
    typeName: string;
    message: string;
    breakMode: string;
    stopped: boolean;
    functionName?: string;
    source?: { path?: string };
    line?: number;
}

const MAX_ENTRIES = 1000;

/**
 * Exception log view: every exception thrown in the debuggee, including ones caught and swallowed,
 * recorded by the DAP relay without stopping (unless the user's exception settings ask to stop).
 */
export class ExceptionLog implements vscode.TreeDataProvider<ExceptionEntry>, vscode.Disposable {
    private entries: ExceptionEntry[] = [];
    private view: vscode.TreeView<ExceptionEntry> | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => s.type === DEBUG_TYPE && this.clear()),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type === DEBUG_TYPE && e.event === EXCEPTION_EVENT) {
                    this.add(e.body);
                }
            }),
        );
    }

    attach(view: vscode.TreeView<ExceptionEntry>): void {
        this.view = view;
    }

    clear(): void {
        this.entries = [];
        this.update();
    }

    getTreeItem(e: ExceptionEntry): vscode.TreeItem {
        const shortType = e.typeName.split('.').pop() ?? e.typeName;
        const item = new vscode.TreeItem(`${shortType}: ${e.message}`);
        const location = e.source?.path ? `${path.basename(e.source.path)}:${e.line}` : '';
        item.description = `${location} · ${new Date(e.time).toLocaleTimeString()}` + (e.stopped ? ` · ${vscode.l10n.t('stopped')}` : '');
        item.tooltip = new vscode.MarkdownString().appendCodeblock(`${e.typeName}\n${e.message}\n\n${e.functionName ?? ''}  ${location}\nbreakMode: ${e.breakMode}`, 'text');
        // Unhandled exceptions get the error icon; the description text also says whether it stopped.
        item.iconPath = new vscode.ThemeIcon(e.breakMode === 'always' ? 'warning' : 'error');
        if (e.source?.path && e.line) {
            item.command = {
                command: 'vscode.open',
                title: vscode.l10n.t('Go to Location'),
                arguments: [vscode.Uri.file(e.source.path), { selection: new vscode.Range(e.line - 1, 0, e.line - 1, 0) }],
            };
        }
        return item;
    }

    getChildren(): ExceptionEntry[] {
        return [...this.entries].reverse();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private add(body: Omit<ExceptionEntry, 'n'>): void {
        this.entries.push({ ...body, n: (this.entries[this.entries.length - 1]?.n ?? 0) + 1 });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
        }
        this.update();
    }

    private update(): void {
        this.changeEmitter.fire();
        if (this.view) {
            this.view.badge = this.entries.length
                ? { value: this.entries.length, tooltip: vscode.l10n.t('{0} exceptions thrown', this.entries.length) }
                : undefined;
        }
    }
}
