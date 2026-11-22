import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';

export interface LocalValue {
    name: string;
    value: string;
    type?: string;
    /** 'new': not in the previous stop; 'changed': different value than at the previous stop. */
    change?: 'new' | 'changed';
}

export interface HistoryEntry {
    n: number;
    time: Date;
    reason: string;
    functionName: string;
    sourcePath?: string;
    line: number;
    locals: LocalValue[];
}

const MAX_ENTRIES = 200;

/** Marks locals that are new or changed compared with the previous stop (in the same function). */
export function markChanges(locals: LocalValue[], previous: HistoryEntry | undefined, functionName: string): LocalValue[] {
    if (!previous || previous.functionName !== functionName) {
        return locals;
    }
    const before = new Map(previous.locals.map((l) => [l.name, l.value]));
    return locals.map((l) => {
        const old = before.get(l.name);
        return { ...l, change: old === undefined ? 'new' : old !== l.value ? 'changed' : undefined };
    });
}

/**
 * Step history: records the location and the local variables at every stop of a netdbg session, so earlier
 * values can be looked at again after stepping on (a history to browse, not a way to run backwards).
 */
export class StepHistory implements vscode.TreeDataProvider<HistoryEntry | LocalValue>, vscode.DebugAdapterTrackerFactory, vscode.Disposable {
    private entries: HistoryEntry[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => s.type === DEBUG_TYPE && this.clear()),
        );
    }

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
        return {
            onDidSendMessage: (m: { type?: string; event?: string; body?: { threadId?: number; reason?: string } }) => {
                if (m.type === 'event' && m.event === 'stopped' && m.body?.threadId !== undefined) {
                    void this.record(session, m.body.threadId, m.body.reason ?? '');
                }
            },
        };
    }

    getEntries(): readonly HistoryEntry[] {
        return this.entries;
    }

    clear(): void {
        this.entries = [];
        this.changeEmitter.fire();
    }

    getTreeItem(element: HistoryEntry | LocalValue): vscode.TreeItem {
        if ('locals' in element) {
            const location = element.sourcePath ? `${path.basename(element.sourcePath)}:${element.line}` : '';
            const changed = element.locals.filter((l) => l.change).length;
            const item = new vscode.TreeItem(`#${element.n} ${element.functionName}`, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${location} · ${element.time.toLocaleTimeString()}` + (changed ? ` · ${vscode.l10n.t('{0} changed', changed)}` : '');
            item.tooltip = `${element.functionName}\n${element.sourcePath ?? ''}:${element.line}\n${element.reason}`;
            item.iconPath = new vscode.ThemeIcon('debug-stackframe');
            if (element.sourcePath) {
                item.command = {
                    command: 'vscode.open',
                    title: vscode.l10n.t('Go to Location'),
                    arguments: [vscode.Uri.file(element.sourcePath), { selection: new vscode.Range(element.line - 1, 0, element.line - 1, 0) }],
                };
            }
            return item;
        }
        const item = new vscode.TreeItem(`${element.name} = ${element.value}`, vscode.TreeItemCollapsibleState.None);
        item.description = element.change === 'new' ? vscode.l10n.t('new') : element.change === 'changed' ? vscode.l10n.t('changed') : element.type;
        item.tooltip = `${element.name}: ${element.type ?? ''}\n${element.value}`;
        // Changed values stand out with a filled icon; the text says why, so the color is never the only cue.
        item.iconPath = new vscode.ThemeIcon(element.change ? 'circle-filled' : 'circle-outline', element.change ? new vscode.ThemeColor('debugTokenExpression.name') : undefined);
        return item;
    }

    getChildren(element?: HistoryEntry | LocalValue): (HistoryEntry | LocalValue)[] {
        if (!element) {
            return [...this.entries].reverse();
        }
        return 'locals' in element ? element.locals : [];
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private async record(session: vscode.DebugSession, threadId: number, reason: string): Promise<void> {
        if (!vscode.workspace.getConfiguration('netdbg.stepHistory').get<boolean>('enabled', true)) {
            return;
        }
        try {
            const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
            const frame = stack?.stackFrames?.[0];
            if (!frame) {
                return;
            }
            const scopes = await session.customRequest('scopes', { frameId: frame.id });
            const localsScope = scopes?.scopes?.[0];
            const variables = localsScope
                ? ((await session.customRequest('variables', { variablesReference: localsScope.variablesReference }))?.variables ?? [])
                : [];
            const locals: LocalValue[] = variables.map((v: { name: string; value: string; type?: string }) => ({ name: v.name, value: v.value, type: v.type }));
            const previous = this.entries[this.entries.length - 1];
            this.entries.push({
                n: (previous?.n ?? 0) + 1,
                time: new Date(),
                reason,
                functionName: frame.name,
                sourcePath: frame.source?.path,
                line: frame.line,
                locals: markChanges(locals, previous, frame.name),
            });
            if (this.entries.length > MAX_ENTRIES) {
                this.entries.shift();
            }
            this.changeEmitter.fire();
        } catch {
            // The debuggee may have resumed or exited meanwhile; a missing entry is harmless.
        }
    }
}
