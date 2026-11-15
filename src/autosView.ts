import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { isEnabled } from './features';
import { findInlineTargets } from './inlineValuesCore';

interface AutoItem {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
}

/**
 * Autos view (as in Visual Studio): the variables used on the current and the previous line of the selected frame,
 * found with the same text heuristic as the inline values.
 */
export class AutosView implements vscode.TreeDataProvider<AutoItem>, vscode.Disposable {
    private items: AutoItem[] = [];
    private session: vscode.DebugSession | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];
    /** Ignores results of an older refresh that finishes after a newer one started. */
    private generation = 0;

    constructor() {
        this.disposables.push(vscode.debug.onDidChangeActiveStackItem((item) => void this.refresh(item)));
    }

    getTreeItem(item: AutoItem): vscode.TreeItem {
        const tree = new vscode.TreeItem(
            `${item.name} = ${item.value}`,
            item.variablesReference ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        tree.description = item.type;
        tree.tooltip = `${item.name}: ${item.type ?? ''}\n${item.value}`;
        return tree;
    }

    async getChildren(item?: AutoItem): Promise<AutoItem[]> {
        if (!item) {
            return this.items;
        }
        if (!this.session || !item.variablesReference) {
            return [];
        }
        try {
            const result = await this.session.customRequest('variables', { variablesReference: item.variablesReference });
            return (result?.variables ?? []).map((v: AutoItem) => ({ name: v.name, value: v.value, type: v.type, variablesReference: v.variablesReference }));
        } catch {
            return [];
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private async refresh(item: vscode.DebugThread | vscode.DebugStackFrame | undefined): Promise<void> {
        const generation = ++this.generation;
        const update = (items: AutoItem[], session?: vscode.DebugSession) => {
            if (generation === this.generation) {
                this.items = items;
                this.session = session;
                this.changeEmitter.fire();
            }
        };
        // Turned off: the view is hidden, and no stack trace or evaluation is spent on it at each stop.
        if (!(item instanceof vscode.DebugStackFrame) || item.session.type !== DEBUG_TYPE || !isEnabled('autos')) {
            update([]);
            return;
        }
        const session = item.session;
        try {
            // DebugStackFrame has no location, so find the selected frame in the thread's stack.
            const stack = await session.customRequest('stackTrace', { threadId: item.threadId, startFrame: 0, levels: 50 });
            const frame = stack?.stackFrames?.find((f: { id: number }) => f.id === item.frameId);
            if (!frame?.source?.path) {
                update([]);
                return;
            }
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(frame.source.path));
            const stoppedLine = frame.line - 1;
            const lines: string[] = [];
            for (let i = 0; i <= stoppedLine && i < document.lineCount; i++) {
                lines.push(document.lineAt(i).text);
            }
            const names = [
                ...new Set(
                    findInlineTargets(lines, stoppedLine)
                        .filter((t) => t.line >= stoppedLine - 1)
                        .map((t) => t.text),
                ),
            ];
            // Return values of the last step ("Type.Method returned", added to Locals by the debugger) come first, as in Visual Studio.
            const items: AutoItem[] = await returnValues(session, item.frameId);
            for (const name of names) {
                try {
                    const r = await session.customRequest('evaluate', { expression: name, frameId: item.frameId, context: 'watch' });
                    items.push({ name, value: r.result, type: r.type, variablesReference: r.variablesReference ?? 0 });
                } catch {
                    // Not in scope at this point (e.g. declared later on the line): leave it out.
                }
            }
            update(items, session);
        } catch {
            update([]);
        }
    }
}

async function returnValues(session: vscode.DebugSession, frameId: number): Promise<AutoItem[]> {
    try {
        const scopes = await session.customRequest('scopes', { frameId });
        const locals = scopes?.scopes?.[0];
        if (!locals?.variablesReference) {
            return [];
        }
        const result = await session.customRequest('variables', { variablesReference: locals.variablesReference });
        return (result?.variables ?? [])
            .filter((v: AutoItem) => v.name.endsWith(' returned'))
            .map((v: AutoItem) => ({ name: v.name, value: v.value, type: v.type, variablesReference: v.variablesReference ?? 0 }));
    } catch {
        return [];
    }
}
