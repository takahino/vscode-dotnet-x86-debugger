import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { EXCEPTION_EVENT } from './dapProxy';
import { SnapshotFrame, SnapshotLocal } from './exceptionSnapshotCore';

export interface ExceptionEntry {
    n: number;
    time: number;
    typeName: string;
    message: string;
    breakMode: string;
    stopped: boolean;
    functionName?: string;
    source?: { path?: string };
    line?: number;
    /** The call stack and locals at the throw (see exceptionSnapshotCore). */
    snapshot?: { frames: SnapshotFrame[]; stackTrace?: string };
}

/** Rows below an entry: its call stack, and the locals of the frames of the user's code. */
type SnapshotNode = { kind: 'frame'; frame: SnapshotFrame } | { kind: 'local'; local: SnapshotLocal };
type Node = ExceptionEntry | SnapshotNode;

const MAX_ENTRIES = 1000;

/**
 * Exception log view: every exception thrown in the debuggee, including ones caught and swallowed,
 * recorded by the DAP relay without stopping (unless the user's exception settings ask to stop).
 */
export class ExceptionLog implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private entries: ExceptionEntry[] = [];
    private view: vscode.TreeView<Node> | undefined;
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

    attach(view: vscode.TreeView<Node>): void {
        this.view = view;
    }

    getEntries(): readonly ExceptionEntry[] {
        return this.entries;
    }

    clear(): void {
        this.entries = [];
        this.update();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if ('kind' in node) {
            return node.kind === 'frame' ? frameItem(node.frame) : localItem(node.local);
        }
        const e = node;
        const shortType = e.typeName.split('.').pop() ?? e.typeName;
        const item = new vscode.TreeItem(`${shortType}: ${e.message}`, e.snapshot?.frames.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        const location = e.source?.path ? `${path.basename(e.source.path)}:${e.line}` : '';
        item.description = `${location} · ${new Date(e.time).toLocaleTimeString()}` + (e.stopped ? ` · ${vscode.l10n.t('stopped')}` : '');
        item.tooltip = new vscode.MarkdownString().appendCodeblock(`${e.typeName}\n${e.message}\n\n${e.snapshot?.stackTrace ?? `${e.functionName ?? ''}  ${location}`}\nbreakMode: ${e.breakMode}`, 'text');
        // Unhandled exceptions get the error icon; the description text also says whether it stopped.
        item.iconPath = new vscode.ThemeIcon(e.breakMode === 'always' ? 'warning' : 'error');
        item.contextValue = 'netdbg.exception';
        if (e.source?.path && e.line) {
            item.command = {
                command: 'vscode.open',
                title: vscode.l10n.t('Go to Location'),
                arguments: [vscode.Uri.file(e.source.path), { selection: new vscode.Range(e.line - 1, 0, e.line - 1, 0) }],
            };
        }
        return item;
    }

    getChildren(node?: Node): Node[] {
        if (!node) {
            return [...this.entries].reverse();
        }
        if (!('kind' in node)) {
            return (node.snapshot?.frames ?? []).map((frame) => ({ kind: 'frame', frame }));
        }
        return node.kind === 'frame' ? (node.frame.locals ?? []).map((local) => ({ kind: 'local', local })) : [];
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

/** A frame of the snapshot: the user's code opens its location and expands into its locals. */
function frameItem(frame: SnapshotFrame): vscode.TreeItem {
    const item = new vscode.TreeItem(frame.name, frame.locals?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = frame.source?.path ? `${path.basename(frame.source.path)}:${frame.line}` : undefined;
    item.iconPath = new vscode.ThemeIcon(frame.source?.path ? 'symbol-method' : 'circle-small', frame.source?.path ? undefined : new vscode.ThemeColor('disabledForeground'));
    if (frame.source?.path && frame.line) {
        item.command = {
            command: 'vscode.open',
            title: vscode.l10n.t('Go to Location'),
            arguments: [vscode.Uri.file(frame.source.path), { selection: new vscode.Range(frame.line - 1, 0, frame.line - 1, 0) }],
        };
    }
    return item;
}

function localItem(local: SnapshotLocal): vscode.TreeItem {
    const item = new vscode.TreeItem(`${local.name} = ${local.value}`);
    item.description = local.type;
    item.tooltip = `${local.name}: ${local.type ?? '?'}\n${local.value}`;
    item.iconPath = new vscode.ThemeIcon('symbol-variable');
    return item;
}
