import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { LIVE_WATCH_EVENT, LIVE_WATCH_REQUEST } from './dapProxy';
import { isEnabled, onDidChangeFeature } from './features';

interface WatchValue {
    value: string;
    type?: string;
    error?: string;
    /** When this value was read. */
    time: number;
    /** When it last differed from the value before. */
    changedAt?: number;
}

export interface LiveWatchItem {
    expression: string;
}

const EXPRESSIONS_KEY = 'dotnetX86.liveWatch.expressions';
const RUNNING_KEY = 'dotnetX86.liveWatch.running';
/** Context key for the start / stop button of the view title. */
const RUNNING_CONTEXT = 'dotnetX86.liveWatch.running';
const MAX_VALUE_LENGTH = 120;
/** A value that changed this recently is marked. */
const CHANGED_MARK_MS = 3000;

/**
 * Live Watch view: expressions read again and again while the program runs, without stopping it from the user's point
 * of view (the DAP relay takes each sample at a safe point of the UI thread and resumes at once). Reaches what can be
 * reached from anywhere: static fields and properties and what hangs off them; not local variables.
 * The expressions and whether it is on are kept in the workspace state; the start / stop button turns sampling on and off.
 */
export class LiveWatch implements vscode.TreeDataProvider<LiveWatchItem>, vscode.Disposable {
    private expressions: string[];
    private running: boolean;
    private readonly values = new Map<string, WatchValue>();
    private idleSince: number | undefined;
    private view: vscode.TreeView<LiveWatchItem> | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly state: vscode.Memento) {
        this.expressions = state.get<string[]>(EXPRESSIONS_KEY, []);
        this.running = state.get<boolean>(RUNNING_KEY, true);
        void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, this.running);
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => s.type === DEBUG_TYPE && void this.sync(s)),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type === DEBUG_TYPE && e.event === LIVE_WATCH_EVENT) {
                    this.receive(e.body);
                }
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('dotnetX86.liveWatch.intervalMs') || e.affectsConfiguration('dotnetX86.liveWatch.hookMethods')) {
                    void this.syncAll();
                }
            }),
            onDidChangeFeature('liveWatch', () => void this.syncAll()),
        );
    }

    attach(view: vscode.TreeView<LiveWatchItem>): void {
        this.view = view;
        this.update();
    }

    getTreeItem(item: LiveWatchItem): vscode.TreeItem {
        const v = this.values.get(item.expression);
        const t = new vscode.TreeItem(item.expression);
        if (!v) {
            t.description = vscode.l10n.t('(not read yet)');
            t.iconPath = new vscode.ThemeIcon('eye');
        } else if (v.error) {
            t.description = v.error;
            t.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        } else {
            const changed = v.changedAt !== undefined && Date.now() - v.changedAt < CHANGED_MARK_MS;
            const shown = v.value.length > MAX_VALUE_LENGTH ? `${v.value.slice(0, MAX_VALUE_LENGTH)}…` : v.value;
            t.description = changed ? `● ${shown}` : shown;
            t.iconPath = new vscode.ThemeIcon('eye', changed ? new vscode.ThemeColor('debugTokenExpression.value') : undefined);
        }
        const tooltip = new vscode.MarkdownString();
        tooltip.appendCodeblock(`${item.expression}${v?.type ? `: ${v.type}` : ''}\n${v?.error ?? v?.value ?? ''}`, 'text');
        if (v) {
            tooltip.appendMarkdown(vscode.l10n.t('Read at {0}', new Date(v.time).toLocaleTimeString()));
            if (v.changedAt) {
                tooltip.appendMarkdown(` · ${vscode.l10n.t('changed at {0}', new Date(v.changedAt).toLocaleTimeString())}`);
            }
        }
        t.tooltip = tooltip;
        t.contextValue = 'dotnetX86.liveWatchItem';
        return t;
    }

    getChildren(): LiveWatchItem[] {
        return this.expressions.map((expression) => ({ expression }));
    }

    async add(): Promise<void> {
        const expression = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Expression to watch while the program runs, reachable from anywhere (e.g. MyApp.Program.Counter, System.Windows.Forms.Application.OpenForms[0].Text)'),
            validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Enter an expression.')),
        });
        if (!expression?.trim() || this.expressions.includes(expression.trim())) {
            return;
        }
        this.expressions.push(expression.trim());
        await this.saveAndSync();
    }

    async edit(item: LiveWatchItem | undefined): Promise<void> {
        const target = item ?? this.view?.selection[0];
        if (!target) {
            return;
        }
        const expression = await vscode.window.showInputBox({ value: target.expression, validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Enter an expression.')) });
        if (!expression?.trim() || expression.trim() === target.expression) {
            return;
        }
        this.expressions = this.expressions.map((e) => (e === target.expression ? expression.trim() : e));
        this.values.delete(target.expression);
        await this.saveAndSync();
    }

    async remove(item: LiveWatchItem | undefined): Promise<void> {
        const target = item ?? this.view?.selection[0];
        if (!target) {
            return;
        }
        this.expressions = this.expressions.filter((e) => e !== target.expression);
        this.values.delete(target.expression);
        await this.saveAndSync();
    }

    async clear(): Promise<void> {
        this.expressions = [];
        this.values.clear();
        await this.saveAndSync();
    }

    /** The view's start / stop button: off means no sampling at all (the program is never paused for Live Watch). */
    async setRunning(running: boolean): Promise<void> {
        this.running = running;
        await this.state.update(RUNNING_KEY, running);
        await vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, running);
        await this.syncAll();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private async saveAndSync(): Promise<void> {
        await this.state.update(EXPRESSIONS_KEY, this.expressions);
        await this.syncAll();
    }

    private async syncAll(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (session?.type === DEBUG_TYPE) {
            await this.sync(session);
        }
        this.update();
    }

    /** Tells the relay what to watch (nothing when off or when the feature is turned off). */
    private async sync(session: vscode.DebugSession): Promise<void> {
        const config = vscode.workspace.getConfiguration('dotnetX86.liveWatch');
        const on = this.running && isEnabled('liveWatch');
        try {
            await session.customRequest(LIVE_WATCH_REQUEST, {
                expressions: on ? this.expressions : [],
                intervalMs: config.get<number>('intervalMs', 1000),
                hookMethods: config.get<string[]>('hookMethods', []),
            });
        } catch {
            // The session ended meanwhile.
        }
        this.idleSince = undefined;
        this.update();
    }

    private receive(body: { time: number; idle?: boolean; values?: { expression: string; value: string; type?: string; error?: string }[] }): void {
        if (body.idle) {
            this.idleSince ??= body.time;
            this.update();
            return;
        }
        this.idleSince = undefined;
        for (const v of body.values ?? []) {
            const before = this.values.get(v.expression);
            const changed = before !== undefined && !before.error && !v.error && before.value !== v.value;
            this.values.set(v.expression, {
                value: v.value,
                type: v.type,
                error: v.error,
                time: body.time,
                changedAt: changed ? body.time : before?.changedAt,
            });
        }
        this.update();
    }

    private update(): void {
        this.changeEmitter.fire();
        if (!this.view) {
            return;
        }
        if (this.expressions.length === 0) {
            this.view.message = vscode.l10n.t('Add an expression with +. Static fields and properties, and what is reached from them, are read while the program runs.');
        } else if (!this.running) {
            this.view.message = vscode.l10n.t('Live Watch is off: press ▶ to read the values while the program runs. The last values are kept.');
        } else if (this.idleSince !== undefined) {
            this.view.message = vscode.l10n.t('Waiting for the UI thread: it handled no window message since {0} (the values do not change while it is idle).', new Date(this.idleSince).toLocaleTimeString());
        } else {
            this.view.message = undefined;
        }
    }
}
