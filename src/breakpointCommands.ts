import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { REMOVE_BREAKPOINT_EVENT, parseMarker } from './dapProxy';

/**
 * Visual Studio 2022 breakpoint options. They are ordinary breakpoints whose condition holds a marker
 * (`#once`, `#after File.cs:12`, `#changed expr`, `#caller Method`) that the DAP relay interprets.
 */
export class BreakpointCommands implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type === DEBUG_TYPE && e.event === REMOVE_BREAKPOINT_EVENT) {
                    this.removeTemporary(e.body?.source?.path, e.body?.line);
                }
            }),
        );
    }

    addTemporary(): void {
        const location = currentLine();
        if (location) {
            vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, '#once')]);
        }
    }

    async addDependent(): Promise<void> {
        const location = currentLine();
        if (!location) {
            return;
        }
        const others = vscode.debug.breakpoints
            .filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint)
            .filter((b) => !(b.location.uri.toString() === location.uri.toString() && b.location.range.start.line === location.range.start.line))
            .map((b) => ({ label: `${path.basename(b.location.uri.fsPath)}:${b.location.range.start.line + 1}`, description: vscode.workspace.asRelativePath(b.location.uri) }));
        if (others.length === 0) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Set the breakpoint it should depend on first.'));
            return;
        }
        const target = await vscode.window.showQuickPick(others, {
            placeHolder: vscode.l10n.t('Line {0} becomes active only after stopping at:', location.range.start.line + 1),
        });
        if (target) {
            vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, `#after ${target.label}`)]);
        }
    }

    async addWhenChanged(): Promise<void> {
        const location = currentLine();
        const editor = vscode.window.activeTextEditor;
        if (!location || !editor) {
            return;
        }
        const word = editor.document.getWordRangeAtPosition(editor.selection.active);
        const expression = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Stop at line {0} only when this expression has a different value than the last time', location.range.start.line + 1),
            value: editor.selection.isEmpty ? (word ? editor.document.getText(word) : '') : editor.document.getText(editor.selection),
        });
        if (expression?.trim()) {
            vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, `#changed ${expression.trim()}`)]);
        }
    }

    /**
     * "#caller": stops at the line only when it is reached through one of the picked methods. While stopped, the
     * methods of the current call stack are offered; any method name can also be typed ("!Name" to exclude).
     */
    async addCallerFiltered(): Promise<void> {
        const location = currentLine();
        if (!location) {
            return;
        }
        const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
        pick.canSelectMany = true;
        pick.placeholder = vscode.l10n.t('Stop at line {0} only when called from (pick, or type a method name; "!Name" stops unless called from it)', location.range.start.line + 1);
        pick.items = (await currentCallStack()).map((name) => ({ label: name }));
        const methods = await new Promise<string | undefined>((resolve) => {
            pick.onDidAccept(() => {
                const picked = pick.selectedItems.map((i) => i.label);
                resolve(picked.length ? picked.join(', ') : pick.value.trim());
                pick.hide();
            });
            pick.onDidHide(() => resolve(undefined));
            pick.show();
        });
        pick.dispose();
        if (methods) {
            vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, `#caller ${methods}`)]);
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    private removeTemporary(sourcePath: string | undefined, line: number | undefined): void {
        if (!sourcePath || !line) {
            return;
        }
        const target = vscode.Uri.file(sourcePath).fsPath.toLowerCase();
        const matches = vscode.debug.breakpoints.filter(
            (b): b is vscode.SourceBreakpoint =>
                b instanceof vscode.SourceBreakpoint &&
                parseMarker(b.condition)?.kind === 'once' &&
                b.location.uri.fsPath.toLowerCase() === target &&
                b.location.range.start.line === line - 1,
        );
        if (matches.length) {
            vscode.debug.removeBreakpoints(matches);
        }
    }
}

/** Method names ("Orders.Save", without namespace and arguments) on the selected thread's stack, when stopped. */
async function currentCallStack(): Promise<string[]> {
    const item = vscode.debug.activeStackItem;
    if (!item || item.session.type !== DEBUG_TYPE) {
        return [];
    }
    try {
        const r = await item.session.customRequest('stackTrace', { threadId: item.threadId, startFrame: 0, levels: 50 });
        const names: string[] = (r?.stackFrames ?? []).map((f: { name?: string }) => String(f.name ?? '').replace(/\(.*$/, ''));
        // "Namespace.Class.Method" -> "Class.Method": specific enough, and short in the condition.
        const short = names.filter(Boolean).map((n) => n.split('.').slice(-2).join('.'));
        return [...new Set(short)];
    } catch {
        return []; // Running, or the thread is gone: the user types the name instead.
    }
}

function currentLine(): vscode.Location | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Open a C# file and put the cursor on the line to track.'));
        return undefined;
    }
    return new vscode.Location(editor.document.uri, new vscode.Position(editor.selection.active.line, 0));
}
