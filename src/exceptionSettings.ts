import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { EXCEPTION_TYPES_REQUEST } from './dapProxy';

/** Common exception types, by namespace, as in Visual Studio's Exception Settings window. */
const CATALOG: Record<string, string[]> = {
    System: [
        'ArgumentException', 'ArgumentNullException', 'ArgumentOutOfRangeException', 'InvalidOperationException',
        'NullReferenceException', 'IndexOutOfRangeException', 'InvalidCastException', 'FormatException',
        'NotImplementedException', 'NotSupportedException', 'ObjectDisposedException', 'OverflowException',
        'DivideByZeroException', 'TimeoutException', 'UnauthorizedAccessException', 'OperationCanceledException',
        'AggregateException', 'OutOfMemoryException',
    ],
    'System.Collections.Generic': ['KeyNotFoundException'],
    'System.Threading.Tasks': ['TaskCanceledException'],
    'System.IO': ['IOException', 'FileNotFoundException', 'DirectoryNotFoundException', 'PathTooLongException', 'EndOfStreamException'],
    'System.Net': ['WebException'],
    'System.Net.Http': ['HttpRequestException'],
    'System.Net.Sockets': ['SocketException'],
    'System.Data': ['DataException', 'DBConcurrencyException'],
    'System.Runtime.InteropServices': ['COMException', 'SEHException', 'ExternalException'],
    'System.ComponentModel': ['Win32Exception'],
    'System.Xml': ['XmlException'],
    'System.Text.Json': ['JsonException'],
    'System.Security': ['SecurityException'],
};
const STATE_KEY = 'netdbg.exceptionSettings';

type Node = { kind: 'group'; namespace: string } | { kind: 'type'; fullName: string; custom: boolean };

interface State {
    checked: string[];
    /** Types added by the user (not in the catalog). */
    custom: string[];
}

/**
 * "Exception Settings (.NET x86)" view: check the exception types to stop on when thrown, as in Visual Studio. VS Code
 * cannot change the exception breakpoints of the Breakpoints view from an extension, so the checked types go to the
 * DAP relay, which merges them with those (see exceptionFilterCore).
 */
export class ExceptionSettings implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];
    private state: State;

    constructor(private readonly storage: vscode.Memento) {
        this.state = storage.get<State>(STATE_KEY) ?? { checked: [], custom: [] };
        // A session that starts gets the types through the adapter factory; one that is running gets every change.
        this.disposables.push(this.changeEmitter);
    }

    attach(view: vscode.TreeView<Node>): void {
        this.disposables.push(
            view.onDidChangeCheckboxState((e) => {
                const checked = new Set(this.state.checked);
                for (const [node, state] of e.items) {
                    const on = state === vscode.TreeItemCheckboxState.Checked;
                    for (const type of node.kind === 'group' ? this.typesOf(node.namespace) : [node.fullName]) {
                        if (on) {
                            checked.add(type);
                        } else {
                            checked.delete(type);
                        }
                    }
                }
                void this.update({ ...this.state, checked: [...checked] });
            }),
        );
        this.updateDescription(view);
        this.disposables.push(this.changeEmitter.event(() => this.updateDescription(view)));
    }

    /** The types to stop on, for a session that starts now. */
    checkedTypes(): string[] {
        return [...this.state.checked];
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'group') {
            const types = this.typesOf(node.namespace);
            const checkedCount = types.filter((t) => this.state.checked.includes(t)).length;
            const item = new vscode.TreeItem(node.namespace, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = checkedCount ? `${checkedCount} / ${types.length}` : undefined;
            item.checkboxState = checkedCount === types.length ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            item.iconPath = new vscode.ThemeIcon('symbol-namespace');
            return item;
        }
        const item = new vscode.TreeItem(node.fullName.slice(node.fullName.lastIndexOf('.') + 1));
        item.tooltip = node.fullName;
        item.checkboxState = this.state.checked.includes(node.fullName) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        item.contextValue = node.custom ? 'netdbg.exceptionType.custom' : 'netdbg.exceptionType';
        item.iconPath = new vscode.ThemeIcon(node.custom ? 'symbol-event' : 'symbol-class');
        return item;
    }

    getChildren(node?: Node): Node[] {
        if (!node) {
            const namespaces = [...new Set([...Object.keys(CATALOG), ...this.state.custom.map(namespaceOf)])].sort((a, b) => (a === 'System' ? -1 : b === 'System' ? 1 : a.localeCompare(b)));
            return namespaces.map((namespace) => ({ kind: 'group', namespace }));
        }
        if (node.kind !== 'group') {
            return [];
        }
        const builtIn = (CATALOG[node.namespace] ?? []).map((name) => ({ kind: 'type' as const, fullName: `${node.namespace}.${name}`, custom: false }));
        const custom = this.state.custom.filter((t) => namespaceOf(t) === node.namespace).map((fullName) => ({ kind: 'type' as const, fullName, custom: true }));
        return [...builtIn, ...custom];
    }

    /** Adds (and checks) a type: asked for, or given by the Exception Log. */
    async addType(typeName?: string): Promise<void> {
        const name = (typeName ?? (await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Full name of the exception type to stop on when thrown'),
            placeHolder: 'MyApp.Orders.OrderException',
            validateInput: (v) => (/^[A-Za-z_][\w`]*(\.[A-Za-z_][\w`]*)+$/.test(v.trim()) ? undefined : vscode.l10n.t('Enter the full name, e.g. System.IO.IOException.')),
        })))?.trim();
        if (!name) {
            return;
        }
        const known = Object.entries(CATALOG).some(([ns, types]) => types.some((t) => `${ns}.${t}` === name));
        await this.update({
            checked: [...new Set([...this.state.checked, name])],
            custom: known || this.state.custom.includes(name) ? this.state.custom : [...this.state.custom, name],
        });
        void vscode.window.showInformationMessage(vscode.l10n.t('The program now stops when {0} is thrown.', name));
    }

    async removeType(node?: Node): Promise<void> {
        if (node?.kind !== 'type') {
            return;
        }
        await this.update({ checked: this.state.checked.filter((t) => t !== node.fullName), custom: this.state.custom.filter((t) => t !== node.fullName) });
    }

    async uncheckAll(): Promise<void> {
        await this.update({ ...this.state, checked: [] });
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    private typesOf(namespace: string): string[] {
        return [...(CATALOG[namespace] ?? []).map((t) => `${namespace}.${t}`), ...this.state.custom.filter((t) => namespaceOf(t) === namespace)];
    }

    private async update(state: State): Promise<void> {
        this.state = state;
        await this.storage.update(STATE_KEY, state);
        this.changeEmitter.fire();
        // Running sessions pick the change up at once.
        const session = vscode.debug.activeDebugSession;
        if (session?.type === DEBUG_TYPE) {
            await session.customRequest(EXCEPTION_TYPES_REQUEST, { types: state.checked }).then(undefined, () => undefined);
        }
    }

    private updateDescription(view: vscode.TreeView<Node>): void {
        view.description = this.state.checked.length ? vscode.l10n.t('{0} checked', this.state.checked.length) : undefined;
    }
}

function namespaceOf(fullName: string): string {
    const dot = fullName.lastIndexOf('.');
    return dot > 0 ? fullName.slice(0, dot) : '';
}
