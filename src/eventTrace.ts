import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { EVENT_TRACE_EVENT, EVENT_TRACE_REQUEST } from './dapProxy';

export interface EventTraceEntry {
    n: number;
    time: number;
    /** "Click", ... (the events the handler is attached to). */
    events: string[];
    labels: string[];
    controls: string[];
    /** Name of the control that fired it (the handler's `sender`), when the handler could tell. */
    sender?: string;
    handler: string;
    source?: { path?: string };
    line?: number;
}

const MAX_ENTRIES = 2000;

/**
 * Event Trace view: which control's event fired, in what order and how far apart, as the user works with the form.
 * The DAP relay stops at the handlers picked with "Trace Events" (WinForms Controls view), records the firing and
 * resumes. Oldest first, as a trace reads.
 */
export class EventTrace implements vscode.TreeDataProvider<EventTraceEntry>, vscode.Disposable {
    private entries: EventTraceEntry[] = [];
    private view: vscode.TreeView<EventTraceEntry> | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => s.type === DEBUG_TYPE && this.clearEntries()),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type === DEBUG_TYPE && e.event === EVENT_TRACE_EVENT) {
                    this.add(e.body);
                }
            }),
        );
    }

    attach(view: vscode.TreeView<EventTraceEntry>): void {
        this.view = view;
    }

    /** Clears the list; with a running session, the traced handlers too. */
    async clear(): Promise<void> {
        this.clearEntries();
        const session = vscode.debug.activeDebugSession;
        if (session?.type === DEBUG_TYPE) {
            await session.customRequest(EVENT_TRACE_REQUEST, { clear: true }).then(undefined, () => undefined);
        }
    }

    getTreeItem(e: EventTraceEntry): vscode.TreeItem {
        const index = this.entries.indexOf(e);
        const previous = index > 0 ? this.entries[index - 1] : undefined;
        const who = e.sender ?? e.controls.join(' / ');
        const item = new vscode.TreeItem(`${e.events.join(' / ') || vscode.l10n.t('(event)')}  ${who}`);
        const time = new Date(e.time);
        const stamp = `${time.toLocaleTimeString()}.${String(time.getMilliseconds()).padStart(3, '0')}`;
        item.description = `${e.labels.join(', ') || e.handler.replace(/\(.*$/s, '')} · ${stamp}${previous ? ` (+${e.time - previous.time} ms)` : ''}`;
        item.tooltip = `${e.handler}\n${e.source?.path ? `${e.source.path}:${e.line}` : ''}`.trim();
        item.iconPath = new vscode.ThemeIcon('zap');
        if (e.source?.path && e.line) {
            item.command = {
                command: 'vscode.open',
                title: vscode.l10n.t('Go to Location'),
                arguments: [vscode.Uri.file(e.source.path), { selection: new vscode.Range(e.line - 1, 0, e.line - 1, 0) }],
            };
        }
        return item;
    }

    getChildren(): EventTraceEntry[] {
        return this.entries;
    }

    getParent(): undefined {
        return undefined;
    }

    getEntries(): readonly EventTraceEntry[] {
        return this.entries;
    }

    /** Writes the trace to a text file (evidence of the order the events fired in). */
    async export(): Promise<void> {
        if (this.entries.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('The event trace is empty.'));
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const target = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, 'event-trace.txt') : undefined, filters: { Text: ['txt'] } });
        if (!target) {
            return;
        }
        const lines = this.entries.map((e, i) => {
            const t = new Date(e.time);
            const where = e.source?.path ? ` (${path.basename(e.source.path)}:${e.line})` : '';
            const delta = i > 0 ? ` +${e.time - this.entries[i - 1].time} ms` : '';
            return `${String(e.n).padStart(4)}  ${t.toLocaleTimeString()}.${String(t.getMilliseconds()).padStart(3, '0')}${delta}  ${e.events.join('/')}  ${e.sender ?? e.controls.join('/')}  ${e.handler.replace(/\(.*$/s, '')}${where}`;
        });
        await vscode.workspace.fs.writeFile(target, Buffer.from(lines.join('\n') + '\n', 'utf8'));
        void vscode.window.showInformationMessage(vscode.l10n.t('Saved {0} events to {1}.', this.entries.length, path.basename(target.fsPath)));
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private clearEntries(): void {
        this.entries = [];
        this.update();
    }

    private add(body: Omit<EventTraceEntry, 'n'>): void {
        this.entries.push({ ...body, n: (this.entries[this.entries.length - 1]?.n ?? 0) + 1 });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
        }
        this.update();
        // The newest firing is at the bottom: keep it in sight.
        const last = this.entries[this.entries.length - 1];
        if (this.view?.visible) {
            void this.view.reveal(last, { select: false, focus: false });
        }
    }

    private update(): void {
        this.changeEmitter.fire();
        if (this.view) {
            this.view.badge = this.entries.length
                ? { value: this.entries.length, tooltip: vscode.l10n.t('{0} events fired', this.entries.length) }
                : undefined;
        }
    }
}
