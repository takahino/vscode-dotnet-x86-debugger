import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { SQL_EVENT } from './dapProxy';
import { SQL_COMPLETED_EVENT, applySqlCompleted, sqlDurationLabel } from './journalCore';
import {
    CallerFrame,
    SqlCommandInfo,
    SqlParameter,
    callerOf,
    dialectOf,
    normalizeSql,
    shortFrameName,
    substituteParameters,
    summarizeSql,
} from './sqlLogCore';

export interface SqlEntry extends SqlCommandInfo {
    n: number;
    time: number;
    /** Journal seq (`netdbg.sqlExecuted` / `netdbg.sqlCompleted`). */
    seq?: number;
    /** "Oracle.ManagedDataAccess.Client.OracleCommand" */
    typeName: string;
    /** The provider method that ran it ("...OracleCommand.ExecuteReader"). */
    method: string;
    frames: CallerFrame[];
    /** How many times this statement (same text) has run in the session, this run included. */
    repeat: number;
    /** Run time in ms, filled in by `netdbg.sqlCompleted` when the statement did not stop. */
    durationMs?: number;
    /** The statement threw before returning. */
    failed?: boolean;
    /** Open transaction that ran this statement (`transactionId` on the journal record). */
    transactionId?: number;
}

type ParameterNode = { kind: 'parameter'; parameter: SqlParameter };
type FrameNode = { kind: 'frame'; frame: CallerFrame };
type Node = SqlEntry | ParameterNode | FrameNode;

const MAX_ENTRIES = 2000;
/** A statement that ran this many times is flagged: the usual shape of an N+1 problem. */
const REPEAT_WARNING = 5;

/**
 * SQL Log view: every statement the program ran through an ADO.NET provider (ODP.NET, SqlClient, ...) with its
 * parameter values, the caller and the SQL ready to paste into a SQL tool. Recorded by the DAP relay without stopping.
 */
export class SqlLog implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private entries: SqlEntry[] = [];
    private readonly repeats = new Map<string, number>();
    private view: vscode.TreeView<Node> | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => s.type === DEBUG_TYPE && this.clear()),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type !== DEBUG_TYPE) {
                    return;
                }
                if (e.event === SQL_EVENT) {
                    this.add(e.body);
                } else if (e.event === SQL_COMPLETED_EVENT) {
                    this.complete(e.body);
                }
            }),
        );
    }

    attach(view: vscode.TreeView<Node>): void {
        this.view = view;
    }

    clear(): void {
        this.entries = [];
        this.repeats.clear();
        this.update();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if ('kind' in node) {
            return node.kind === 'parameter' ? parameterItem(node.parameter) : frameItem(node.frame);
        }
        const e = node;
        const caller = callerOf(e.frames);
        const hasChildren = e.parameters.length > 0 || e.frames.length > 0;
        const item = new vscode.TreeItem(summarizeSql(e.commandText) || `(${e.commandType})`, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        const parts = [caller ? shortFrameName(caller.name) : '', new Date(e.time).toLocaleTimeString()];
        if (e.repeat > 1) {
            parts.push(`×${e.repeat}`);
        }
        const duration = sqlDurationLabel(e);
        if (duration) {
            parts.push(duration);
        }
        item.description = parts.filter(Boolean).join(' · ');
        item.tooltip = new vscode.MarkdownString().appendCodeblock(this.sqlWithValues(e), 'sql');
        item.iconPath = e.failed
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
            : e.repeat >= REPEAT_WARNING
              ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
              : new vscode.ThemeIcon('database');
        item.contextValue = 'netdbg.sql';
        item.command = { command: 'netdbg.openSql', title: vscode.l10n.t('Open SQL'), arguments: [e] };
        return item;
    }

    getChildren(node?: Node): Node[] {
        if (!node) {
            return [...this.entries].reverse();
        }
        if ('kind' in node) {
            return [];
        }
        return [
            ...node.parameters.map((parameter): ParameterNode => ({ kind: 'parameter', parameter })),
            ...node.frames.map((frame): FrameNode => ({ kind: 'frame', frame })),
        ];
    }

    /** The statement with the parameter values filled in. */
    sqlWithValues(entry: SqlCommandInfo & { typeName: string }): string {
        return substituteParameters(entry, dialectOf(entry.typeName));
    }

    getEntries(): readonly SqlEntry[] {
        return this.entries;
    }

    /** Opens the statement (with values) as a SQL document, with the caller and the parameters as a comment. */
    async open(entry: SqlEntry | undefined): Promise<void> {
        if (!entry || !('commandText' in entry)) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: this.describe(entry) });
        await vscode.window.showTextDocument(doc, { preview: true });
    }

    async copy(entry: SqlEntry | undefined, withValues: boolean): Promise<void> {
        if (!entry || !('commandText' in entry)) {
            return;
        }
        await vscode.env.clipboard.writeText(withValues ? this.sqlWithValues(entry) : entry.commandText);
        void vscode.window.showInformationMessage(withValues ? vscode.l10n.t('Copied the SQL with the parameter values filled in.') : vscode.l10n.t('Copied the SQL.'));
    }

    /** Writes every statement of the session to a .sql file (evidence of what the program ran). */
    async export(): Promise<void> {
        if (this.entries.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('The SQL log is empty.'));
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const target = await vscode.window.showSaveDialog({
            defaultUri: folder ? vscode.Uri.joinPath(folder, 'sql-log.sql') : undefined,
            filters: { SQL: ['sql'] },
        });
        if (!target) {
            return;
        }
        const text = this.entries.map((e) => this.describe(e)).join('\n\n');
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        void vscode.window.showInformationMessage(vscode.l10n.t('Saved {0} statements to {1}.', this.entries.length, path.basename(target.fsPath)));
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private describe(e: SqlEntry): string {
        const caller = callerOf(e.frames);
        const where = caller?.source?.path ? ` (${path.basename(caller.source.path)}:${caller.line})` : '';
        const duration = sqlDurationLabel(e);
        const header = [
            `-- #${e.n}  ${new Date(e.time).toLocaleString()}  ${e.method.split('.').slice(-2).join('.')}${duration ? `  ${duration}` : ''}`,
            caller ? `-- ${shortFrameName(caller.name)}${where}` : '',
            e.dataSource ? `-- ${e.dataSource}` : '',
            e.parameters.length ? `-- ${e.parameters.map((p) => `${p.name}=${p.kind === 'null' ? 'NULL' : p.value}`).join(', ')}` : '',
        ];
        return `${header.filter(Boolean).join('\n')}\n${this.sqlWithValues(e)}${/;\s*$/.test(e.commandText) ? '' : ';'}`;
    }

    private add(body: Omit<SqlEntry, 'n' | 'repeat'> & { repeat?: number }): void {
        const key = normalizeSql(body.commandText);
        const repeat = typeof body.repeat === 'number' ? body.repeat : (this.repeats.get(key) ?? 0) + 1;
        this.repeats.set(key, repeat);
        this.entries.push({
            ...body,
            seq: typeof body.seq === 'number' ? body.seq : undefined,
            transactionId: typeof body.transactionId === 'number' ? body.transactionId : undefined,
            durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
            failed: body.failed === true ? true : undefined,
            repeat,
            n: (this.entries[this.entries.length - 1]?.n ?? 0) + 1,
        });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
        }
        this.update();
    }

    private complete(body: { seq?: number; durationMs?: number; failed?: boolean }): void {
        if (applySqlCompleted(this.entries, body)) {
            this.update();
        }
    }

    private update(): void {
        this.changeEmitter.fire();
        if (this.view) {
            this.view.badge = this.entries.length
                ? { value: this.entries.length, tooltip: vscode.l10n.t('{0} SQL statements', this.entries.length) }
                : undefined;
        }
    }
}

function parameterItem(p: SqlParameter): vscode.TreeItem {
    const shown = p.kind === 'null' ? 'NULL' : p.kind === 'string' ? JSON.stringify(p.value) : p.value;
    const item = new vscode.TreeItem(`${p.name} = ${shown}`);
    item.description = p.direction === 'Input' ? p.kind : `${p.kind} · ${p.direction}`;
    item.tooltip = `${p.name}: ${p.kind} (${p.direction})\n${p.value}`;
    item.iconPath = new vscode.ThemeIcon('symbol-variable');
    return item;
}

function frameItem(frame: CallerFrame): vscode.TreeItem {
    const item = new vscode.TreeItem(shortFrameName(frame.name));
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
