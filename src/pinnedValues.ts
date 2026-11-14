import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';

interface Pin {
    uri: string;
    /** 0-based */
    line: number;
    expression: string;
    value?: string;
    error?: boolean;
}

const STATE_KEY = 'dotnetX86.pinnedValues';
/** Long values (e.g. big strings) would push everything else off screen. */
const MAX_VALUE_LENGTH = 120;

/**
 * Pinned values (as Visual Studio's pinned DataTips): expressions shown at the end of an editor line and evaluated
 * again in the selected stack frame every time the program stops. Pins are kept in the workspace state.
 */
export class PinnedValues implements vscode.Disposable {
    private pins: Pin[];
    private readonly decoration = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('debugTokenExpression.value'),
            backgroundColor: new vscode.ThemeColor('editor.inactiveSelectionBackground'),
            margin: '0 0 0 2em',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    private readonly disposables: vscode.Disposable[] = [];
    /** Ignores results of an older evaluation that finishes after a newer one started. */
    private generation = 0;

    constructor(private readonly state: vscode.Memento) {
        this.pins = state.get<Pin[]>(STATE_KEY, []).map((p) => ({ uri: p.uri, line: p.line, expression: p.expression }));
        this.disposables.push(
            this.decoration,
            vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
            vscode.debug.onDidChangeActiveStackItem((item) => void this.evaluate(item)),
            vscode.debug.onDidTerminateDebugSession((s) => {
                if (s.type === DEBUG_TYPE) {
                    this.pins.forEach((p) => (p.value = p.error = undefined));
                    this.render();
                }
            }),
            vscode.workspace.onDidChangeTextDocument((e) => this.followEdits(e)),
        );
        this.render();
    }

    async pin(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Open a C# file and put the cursor on the line to track.'));
            return;
        }
        const word = editor.document.getWordRangeAtPosition(editor.selection.active);
        const initial = editor.selection.isEmpty ? (word ? editor.document.getText(word) : '') : editor.document.getText(editor.selection);
        const expression = (await vscode.window.showInputBox({ prompt: vscode.l10n.t('Expression to pin to line {0}', editor.selection.active.line + 1), value: initial }))?.trim();
        if (!expression) {
            return;
        }
        this.pins.push({ uri: editor.document.uri.toString(), line: editor.selection.active.line, expression });
        this.save();
        await this.evaluate(vscode.debug.activeStackItem);
    }

    async unpin(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const uri = editor.document.uri.toString();
        const line = editor.selection.active.line;
        const onLine = this.pins.filter((p) => p.uri === uri && p.line === line);
        if (onLine.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('There is no pinned value on this line.'));
            return;
        }
        let remove = onLine;
        if (onLine.length > 1) {
            const picked = await vscode.window.showQuickPick(
                onLine.map((p) => ({ label: p.expression, pin: p })),
                { canPickMany: true, placeHolder: vscode.l10n.t('Pinned values to remove') },
            );
            if (!picked?.length) {
                return;
            }
            remove = picked.map((p) => p.pin);
        }
        this.pins = this.pins.filter((p) => !remove.includes(p));
        this.save();
    }

    clear(): void {
        this.pins = [];
        this.save();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    private save(): void {
        void this.state.update(STATE_KEY, this.pins.map((p) => ({ uri: p.uri, line: p.line, expression: p.expression })));
        this.render();
    }

    private async evaluate(item: vscode.DebugThread | vscode.DebugStackFrame | undefined): Promise<void> {
        if (!(item instanceof vscode.DebugStackFrame) || item.session.type !== DEBUG_TYPE || this.pins.length === 0) {
            return;
        }
        const generation = ++this.generation;
        const results: { value: string; error: boolean }[] = [];
        for (const pin of this.pins) {
            try {
                const r = await item.session.customRequest('evaluate', { expression: pin.expression, frameId: item.frameId, context: 'watch' });
                results.push({ value: String(r?.result ?? ''), error: false });
            } catch (e) {
                results.push({ value: e instanceof Error ? e.message : String(e), error: true });
            }
        }
        // A newer stop, or a pin added or removed meanwhile, makes these results stale.
        if (generation !== this.generation || results.length !== this.pins.length) {
            return;
        }
        this.pins.forEach((p, i) => ((p.value = results[i].value), (p.error = results[i].error)));
        this.render();
    }

    /** Keeps pins on their line when lines are inserted or deleted above them. */
    private followEdits(e: vscode.TextDocumentChangeEvent): void {
        const uri = e.document.uri.toString();
        let moved = false;
        for (const change of e.contentChanges) {
            const added = change.text.split('\n').length - 1;
            const removed = change.range.end.line - change.range.start.line;
            if (added === removed) {
                continue;
            }
            for (const pin of this.pins) {
                if (pin.uri === uri && pin.line > change.range.start.line) {
                    pin.line = Math.max(change.range.start.line, pin.line + added - removed);
                    moved = true;
                }
            }
        }
        if (moved) {
            this.save();
        }
    }

    private render(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const uri = editor.document.uri.toString();
            const byLine = new Map<number, Pin[]>();
            for (const pin of this.pins.filter((p) => p.uri === uri && p.line < editor.document.lineCount)) {
                byLine.set(pin.line, [...(byLine.get(pin.line) ?? []), pin]);
            }
            const options: vscode.DecorationOptions[] = [...byLine].map(([line, pins]) => {
                const end = editor.document.lineAt(line).range.end;
                const text = pins.map((p) => `📌 ${p.expression}${p.value === undefined ? '' : ` = ${truncate(p.error ? `⚠ ${p.value}` : p.value)}`}`).join('   ');
                const hover = new vscode.MarkdownString();
                pins.forEach((p) => hover.appendCodeblock(`${p.expression} = ${p.value ?? '?'}`, 'csharp'));
                return { range: new vscode.Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: ` ${text} ` } } };
            });
            editor.setDecorations(this.decoration, options);
        }
    }
}

function truncate(value: string): string {
    const oneLine = value.replace(/\s*\r?\n\s*/g, ' ');
    return oneLine.length > MAX_VALUE_LENGTH ? `${oneLine.slice(0, MAX_VALUE_LENGTH)}…` : oneLine;
}
