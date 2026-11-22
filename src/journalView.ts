import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { isEnabled } from './features';
import {
    JOURNAL_REQUEST,
    JournalCursor,
    JournalRecord,
    JournalResponse,
    OpenTransaction,
    RECORDS_EVENTS,
    RECORDS_KINDS,
    TRANSACTIONS_REQUEST,
    mergeJournal,
    openTransactionHeading,
    recordHeading,
    recordsKindOf,
} from './journalCore';

const MAX_ENTRIES = 2000;
const DEBOUNCE_MS = 150;

type OpenNode = { kind: 'open'; open: OpenTransaction };
type DroppedNode = { kind: 'dropped'; dropped: number };
type RecordNode = { kind: 'record'; record: JournalRecord };
type Node = OpenNode | DroppedNode | RecordNode;

/**
 * Records view: dialogs, binding failures, transactions, child processes and the environment snapshot from
 * `netdbg.journal` (kinds without a dedicated view). A wake-up event triggers a differential read; open
 * transactions come from `netdbg.transactions`.
 */
export class JournalView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private records: JournalRecord[] = [];
    private open: OpenTransaction[] = [];
    private cursor: JournalCursor = { after: 0, dropped: 0 };
    private droppedNotice = false;
    private view: vscode.TreeView<Node> | undefined;
    private reading: Promise<void> = Promise.resolve();
    private debounce: ReturnType<typeof setTimeout> | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === DEBUG_TYPE) {
                    this.reset();
                }
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                if (s.type === DEBUG_TYPE) {
                    this.open = [];
                    this.update();
                }
            }),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type !== DEBUG_TYPE || !isEnabled('records')) {
                    return;
                }
                if ((RECORDS_EVENTS as readonly string[]).includes(e.event)) {
                    this.scheduleFetch(e.session, e.event === 'netdbg.transaction');
                }
            }),
        );
    }

    attach(view: vscode.TreeView<Node>): void {
        this.view = view;
    }

    clear(): void {
        this.reset();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'dropped') {
            const item = new vscode.TreeItem(vscode.l10n.t('Older records were dropped ({0})', node.dropped));
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            item.tooltip = vscode.l10n.t('The engine keeps at most 10,000 journal records; older ones are discarded.');
            return item;
        }
        if (node.kind === 'open') {
            const heading = openTransactionHeading(node.open);
            const item = new vscode.TreeItem(heading.label);
            item.description = heading.description;
            item.tooltip = heading.detail;
            item.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('list.warningForeground'));
            item.contextValue = 'netdbg.recordOpen';
            attachSource(item, heading.source);
            return item;
        }
        const heading = recordHeading(node.record);
        const item = new vscode.TreeItem(heading.label);
        item.description = heading.description;
        item.tooltip = heading.detail;
        item.iconPath = iconFor(recordsKindOf(node.record));
        item.contextValue = 'netdbg.record';
        attachSource(item, heading.source);
        return item;
    }

    getChildren(): Node[] {
        const nodes: Node[] = [];
        if (this.droppedNotice && this.cursor.dropped > 0) {
            nodes.push({ kind: 'dropped', dropped: this.cursor.dropped });
        }
        for (const open of this.open) {
            nodes.push({ kind: 'open', open });
        }
        for (const record of [...this.records].reverse()) {
            nodes.push({ kind: 'record', record });
        }
        return nodes;
    }

    dispose(): void {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private reset(): void {
        this.records = [];
        this.open = [];
        this.cursor = { after: 0, dropped: 0 };
        this.droppedNotice = false;
        this.update();
    }

    private scheduleFetch(session: vscode.DebugSession, refreshOpen: boolean): void {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        this.debounce = setTimeout(() => {
            this.debounce = undefined;
            this.reading = this.reading.then(() => this.fetch(session, refreshOpen), () => this.fetch(session, refreshOpen));
        }, DEBOUNCE_MS);
    }

    private async fetch(session: vscode.DebugSession, refreshOpen: boolean): Promise<void> {
        if (session !== vscode.debug.activeDebugSession && vscode.debug.activeDebugSession?.type === DEBUG_TYPE) {
            // Another session became active; still read from the session that woke us.
        }
        try {
            const body = (await session.customRequest(JOURNAL_REQUEST, {
                after: this.cursor.after,
                kinds: [...RECORDS_KINDS],
                limit: 1000,
            })) as JournalResponse;
            const merged = mergeJournal(this.records, this.cursor, body);
            this.records = merged.records;
            this.cursor = merged.cursor;
            if (merged.droppedGrew) {
                this.droppedNotice = true;
            }
            if (this.records.length > MAX_ENTRIES) {
                this.records = this.records.slice(this.records.length - MAX_ENTRIES);
            }
        } catch {
            // The session ended, or an older engine without the journal request.
        }
        if (refreshOpen || this.open.length > 0) {
            try {
                const body = (await session.customRequest(TRANSACTIONS_REQUEST, {})) as { open?: OpenTransaction[] };
                this.open = Array.isArray(body?.open) ? body.open : [];
            } catch {
                this.open = [];
            }
        }
        this.update();
    }

    private update(): void {
        this.changeEmitter.fire();
        if (this.view) {
            const count = this.records.length + this.open.length;
            this.view.badge = count
                ? { value: count, tooltip: vscode.l10n.t('{0} records', count) }
                : undefined;
        }
    }
}

function iconFor(kind: ReturnType<typeof recordsKindOf>): vscode.ThemeIcon {
    switch (kind) {
        case 'dialog':
            return new vscode.ThemeIcon('window');
        case 'binding':
            return new vscode.ThemeIcon('link', new vscode.ThemeColor('list.warningForeground'));
        case 'transaction':
            return new vscode.ThemeIcon('database');
        case 'process':
            return new vscode.ThemeIcon('server-process');
        case 'environment':
            return new vscode.ThemeIcon('server-environment');
        default:
            return new vscode.ThemeIcon('circle-outline');
    }
}

function attachSource(item: vscode.TreeItem, source: { path: string; line?: number } | undefined): void {
    if (!source?.path) {
        return;
    }
    const line = source.line && source.line > 0 ? source.line : 1;
    item.command = {
        command: 'vscode.open',
        title: vscode.l10n.t('Go to Location'),
        arguments: [vscode.Uri.file(source.path), { selection: new vscode.Range(line - 1, 0, line - 1, 0) }],
    };
    if (!item.description) {
        item.description = `${path.basename(source.path)}:${line}`;
    }
}
