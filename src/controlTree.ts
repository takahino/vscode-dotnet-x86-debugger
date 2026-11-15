import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { EDITABLE_PROPERTIES, PropertyKind, failedResult, setterExpression, valueExpression } from './controlPropertyCore';
import { WindowHighlighter } from './windowHighlight';

export interface ControlNode {
    /** C# expression that reaches the control, e.g. System.Windows.Forms.Application.OpenForms[0].Controls[1] */
    expression: string;
    name: string;
    typeName: string;
    text: string;
    visible: boolean;
    childCount: number;
}

const OPEN_FORMS = 'System.Windows.Forms.Application.OpenForms';
/** A form with thousands of controls (e.g. generated grids) would take minutes to list at ~20 ms per evaluation. */
const MAX_CHILDREN = 200;
const MAX_TEXT_LENGTH = 60;

type Evaluate = (expression: string) => Promise<string>;

/**
 * WinForms control tree (like Spy++ / the Live Visual Tree): walks Application.OpenForms and Controls of the
 * stopped program by evaluating expressions in the selected frame. Children are read only when a node is expanded,
 * and the bounds / enabled state only when the tooltip is shown, because every value is a separate evaluation.
 */
export class ControlTree implements vscode.TreeDataProvider<ControlNode>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];
    private view: vscode.TreeView<ControlNode> | undefined;
    /** The tree is rebuilt on the next show when the program stopped while the view was hidden. */
    private stale = false;

    constructor() {
        this.disposables.push(
            vscode.debug.onDidChangeActiveStackItem(() => this.refreshIfVisible()),
            vscode.debug.onDidTerminateDebugSession(() => this.refreshIfVisible()),
        );
    }

    attach(view: vscode.TreeView<ControlNode>): void {
        this.view = view;
        this.disposables.push(
            view.onDidChangeVisibility((e) => {
                if (e.visible && this.stale) {
                    this.refresh();
                }
            }),
        );
    }

    refresh(): void {
        this.stale = false;
        this.changeEmitter.fire();
    }

    getTreeItem(node: ControlNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.name || `(${shortType(node.typeName)})`,
            node.childCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.description = [shortType(node.typeName), node.text ? `"${truncate(node.text)}"` : '', node.visible ? '' : vscode.l10n.t('(hidden)')]
            .filter(Boolean)
            .join('  ');
        const isForm = !node.expression.includes('.Controls[');
        item.iconPath = new vscode.ThemeIcon(isForm ? 'window' : 'symbol-field', node.visible ? undefined : new vscode.ThemeColor('disabledForeground'));
        item.contextValue = 'control';
        return item;
    }

    async resolveTreeItem(item: vscode.TreeItem, node: ControlNode): Promise<vscode.TreeItem> {
        const evaluate = this.evaluator();
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${node.name || shortType(node.typeName)}** — \`${node.typeName}\`\n\n`);
        if (evaluate) {
            const rows: [string, string][] = [];
            for (const [label, property] of [['Text', 'Text'], ['Bounds', 'Bounds.ToString()'], ['Visible', 'Visible'], ['Enabled', 'Enabled'], ['Dock', 'Dock.ToString()'], ['TabIndex', 'TabIndex']]) {
                rows.push([label, await evaluate(`${node.expression}.${property}`).catch((e) => `⚠ ${errorMessage(e)}`)]);
            }
            tooltip.appendMarkdown(rows.map(([k, v]) => `- ${k}: \`${v.replace(/`/g, "'")}\``).join('\n'));
        }
        tooltip.appendMarkdown(`\n\n\`${node.expression}\``);
        item.tooltip = tooltip;
        return item;
    }

    async getChildren(node?: ControlNode): Promise<ControlNode[]> {
        const evaluate = this.evaluator();
        if (!evaluate) {
            this.setMessage(vscode.l10n.t('Stop the program to see its WinForms controls.'));
            return [];
        }
        const collection = node ? `${node.expression}.Controls` : OPEN_FORMS;
        try {
            const count = node ? node.childCount : Number(await evaluate(`${OPEN_FORMS}.Count`));
            if (!node && !(count > 0)) {
                this.setMessage(vscode.l10n.t('No WinForms form is open.'));
                return [];
            }
            this.setMessage(undefined);
            const children: ControlNode[] = [];
            for (let i = 0; i < Math.min(count, MAX_CHILDREN); i++) {
                children.push(await readNode(evaluate, `${collection}[${i}]`));
            }
            if (count > MAX_CHILDREN) {
                this.setMessage(vscode.l10n.t('Only the first {0} of {1} controls are listed.', MAX_CHILDREN, count));
            }
            return children;
        } catch (e) {
            // Not a WinForms program (System.Windows.Forms is not loaded) or the frame cannot evaluate.
            this.setMessage(node ? undefined : vscode.l10n.t('Could not read Application.OpenForms ({0}). Is this a WinForms program?', errorMessage(e)));
            return [];
        }
    }

    /**
     * "Change Property...": calls the property's setter in the stopped program. The form cannot repaint while stopped,
     * so the change shows on screen when the program continues.
     */
    async editProperty(node: ControlNode | undefined): Promise<void> {
        const evaluate = this.evaluator();
        if (!node || !evaluate) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Stop the program to see its WinForms controls.'));
            return;
        }
        const label = node.name || shortType(node.typeName);
        const other = vscode.l10n.t('Other property...');
        const items = await Promise.all(EDITABLE_PROPERTIES.map(async (p) => ({
            label: p.name,
            description: await evaluate(`${node.expression}.${p.name}`).catch(() => '?'),
            property: p,
        })));
        const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { property?: { name: string; kind: PropertyKind } }>(
            [...items, { label: other, description: vscode.l10n.t('any property, with a C# expression as the value') }],
            { placeHolder: vscode.l10n.t('Property of {0} to change', label) },
        );
        if (!picked) {
            return;
        }
        let property = picked.property;
        if (!property) {
            const name = await vscode.window.showInputBox({
                prompt: vscode.l10n.t('Property name (e.g. Font, MaximumSize)'),
                validateInput: (v) => (/^[A-Za-z_]\w*$/.test(v.trim()) ? undefined : vscode.l10n.t('Enter a property name.')),
            });
            if (!name) {
                return;
            }
            property = { name: name.trim(), kind: 'expression' };
        }
        const input = await this.askValue(property, picked.description ?? '');
        if (input === undefined) {
            return;
        }
        const value = valueExpression(property.kind, input);
        if ('error' in value) {
            return; // the input box already refused it
        }
        const session = (vscode.debug.activeStackItem as vscode.DebugStackFrame).session;
        const frameId = (vscode.debug.activeStackItem as vscode.DebugStackFrame).frameId;
        try {
            const r = await session.customRequest('evaluate', { expression: setterExpression(node.expression, property.name, value.expression), frameId, context: 'repl' });
            const thrown = failedResult(r ?? {});
            if (thrown) {
                void vscode.window.showErrorMessage(vscode.l10n.t('{0}.{1} was not changed: the setter threw {2}.', label, property.name, thrown));
                return;
            }
            this.refresh();
            void vscode.window.showInformationMessage(vscode.l10n.t('{0}.{1} was changed. It shows on screen when the program continues.', label, property.name));
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // netcoredbg's evaluator cannot pass enum values (E_INVALIDARG): say so instead of the bare error code.
            const hint = /0x80070057/.test(message) ? vscode.l10n.t('Enum properties (Dock, Anchor, ...) cannot be changed with this debugger.') : message;
            void vscode.window.showErrorMessage(vscode.l10n.t('{0}.{1} was not changed: {2}', label, property.name, hint));
        }
    }

    private async askValue(property: { name: string; kind: PropertyKind }, current: string): Promise<string | undefined> {
        if (property.kind === 'bool') {
            return vscode.window.showQuickPick(['true', 'false'], { placeHolder: vscode.l10n.t('{0} (now {1})', property.name, current) });
        }
        const hints: Record<PropertyKind, string> = {
            string: vscode.l10n.t('New text'),
            bool: '',
            int: vscode.l10n.t('A whole number'),
            color: vscode.l10n.t('A color name (Red), #RRGGBB, #AARRGGBB or R,G,B'),
            expression: vscode.l10n.t('A C# expression, e.g. System.Drawing.SystemFonts.CaptionFont'),
        };
        return vscode.window.showInputBox({
            prompt: `${property.name}: ${hints[property.kind]}`,
            // Current text without its quotes, current numbers as they are; colors are typed anew.
            value: property.kind === 'string' ? current.replace(/^"|"$/g, '') : property.kind === 'int' ? current : '',
            validateInput: (v) => ('error' in valueExpression(property.kind, v) ? hints[property.kind] : undefined),
        });
    }

    /**
     * Frames the control on the screen. Its window handle is read only when the handle already exists:
     * reading Control.Handle would create the window of a control that was never shown.
     */
    async highlight(node: ControlNode | undefined, highlighter: WindowHighlighter): Promise<void> {
        const evaluate = this.evaluator();
        if (!node || !evaluate) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Stop the program to see its WinForms controls.'));
            return;
        }
        const label = [node.name, shortType(node.typeName)].filter(Boolean).join('  ');
        try {
            if ((await evaluate(`${node.expression}.IsHandleCreated`)) !== 'true') {
                void vscode.window.showInformationMessage(vscode.l10n.t('{0} has no window yet: it has not been shown.', label));
                return;
            }
            const hwnd = await evaluate(`${node.expression}.Handle`);
            if (!/^\d+$/.test(hwnd)) {
                throw new Error(hwnd);
            }
            const result = await highlighter.highlight(hwnd, label);
            const problems: Record<string, string> = {
                gone: vscode.l10n.t('The window of {0} no longer exists.', label),
                hidden: vscode.l10n.t('{0} is not visible on the screen (it or one of its parents is hidden).', label),
                minimized: vscode.l10n.t('The form of {0} is minimized: restore it, then stop the program again.', label),
            };
            if (typeof result === 'object') {
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not highlight {0}: {1}', label, result.error));
            } else if (result !== 'ok') {
                void vscode.window.showInformationMessage(problems[result]);
            }
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not highlight {0}: {1}', label, errorMessage(e)));
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }

    private refreshIfVisible(): void {
        if (this.view?.visible) {
            this.refresh();
        } else {
            this.stale = true;
        }
    }

    private setMessage(message: string | undefined): void {
        if (this.view) {
            this.view.message = message;
        }
    }

    /** Evaluates in the selected stack frame of a stopped dotnet-x86 session, or undefined when there is none. */
    private evaluator(): Evaluate | undefined {
        const frame = vscode.debug.activeStackItem;
        if (!(frame instanceof vscode.DebugStackFrame) || frame.session.type !== DEBUG_TYPE) {
            return undefined;
        }
        return async (expression) => {
            const r = await frame.session.customRequest('evaluate', { expression, frameId: frame.frameId, context: 'watch' });
            return unquote(String(r?.result ?? ''));
        };
    }
}

async function readNode(evaluate: Evaluate, expression: string): Promise<ControlNode> {
    const [name, typeName, text, visible, childCount] = [
        await evaluate(`${expression}.Name`).catch(() => ''),
        await evaluate(`${expression}.GetType().FullName`).catch(() => '?'),
        await evaluate(`${expression}.Text`).catch(() => ''),
        await evaluate(`${expression}.Visible`).catch(() => 'true'),
        await evaluate(`${expression}.Controls.Count`).catch(() => '0'),
    ];
    return { expression, name, typeName, text, visible: visible === 'true', childCount: Number(childCount) || 0 };
}

/** netcoredbg returns strings as C# literals ("abc", with escapes). */
function unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t', '0': '\0' })[c] ?? c);
    }
    return value;
}

function shortType(typeName: string): string {
    return typeName.slice(typeName.lastIndexOf('.') + 1);
}

function truncate(text: string): string {
    const oneLine = text.replace(/\s*\r?\n\s*/g, ' ');
    return oneLine.length > MAX_TEXT_LENGTH ? `${oneLine.slice(0, MAX_TEXT_LENGTH)}…` : oneLine;
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
