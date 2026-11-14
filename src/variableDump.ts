import * as vscode from 'vscode';
import { DapVariable, DumpCancelledError, dumpVariable } from './dumpCore';

/** Argument VS Code passes to commands contributed to "debug/variables/context". */
interface VariablesContextArg {
    variable?: DapVariable & { evaluateName?: string };
}

export async function dumpVariableCommand(arg?: VariablesContextArg): Promise<void> {
    const session = requireSession();
    if (!session) {
        return;
    }
    if (!arg?.variable) {
        void vscode.window.showErrorMessage('変数ビューで変数を右クリックして「Dump Variable」を実行してください。');
        return;
    }
    const v = arg.variable;
    await runDump(session, v.evaluateName ?? v.name, {
        name: v.name,
        value: v.value,
        type: v.type,
        variablesReference: v.variablesReference,
    });
}

export async function dumpExpressionCommand(): Promise<void> {
    const session = requireSession();
    if (!session) {
        return;
    }
    const expression = await vscode.window.showInputBox({
        prompt: 'ダンプする式（例: this, myList, order.Items）',
        placeHolder: 'this',
    });
    if (!expression) {
        return;
    }
    const frame = vscode.debug.activeStackItem;
    const frameId = frame instanceof vscode.DebugStackFrame ? frame.frameId : undefined;
    let evaluated: { result: string; type?: string; variablesReference: number };
    try {
        evaluated = await session.customRequest('evaluate', { expression, frameId, context: 'watch' });
    } catch (e) {
        void vscode.window.showErrorMessage(`式を評価できませんでした: ${expression} (${errorMessage(e)})。停止中のフレームで評価できる式か確認してください。`);
        return;
    }
    await runDump(session, expression, {
        name: expression,
        value: evaluated.result,
        type: evaluated.type,
        variablesReference: evaluated.variablesReference,
    });
}

async function runDump(session: vscode.DebugSession, title: string, root: DapVariable): Promise<void> {
    const config = vscode.workspace.getConfiguration('dotnetX86.dump');
    const maxDepth = config.get<number>('maxDepth', 3);
    const maxNodes = config.get<number>('maxNodes', 2000);

    let result;
    try {
        result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${title} をダンプしています…`, cancellable: true },
            (_progress, token) =>
                dumpVariable((command, args) => session.customRequest(command, args), root, {
                    maxDepth,
                    maxNodes,
                    isCancelled: () => token.isCancellationRequested,
                }),
        );
    } catch (e) {
        if (e instanceof DumpCancelledError) {
            return;
        }
        void vscode.window.showErrorMessage(`ダンプに失敗しました: ${errorMessage(e)}`);
        return;
    }

    const content = JSON.stringify({ [title]: result.value }, null, 2);
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    if (result.truncated) {
        void vscode.window.showInformationMessage(
            `上限に達したため一部を展開していません（深さ ${maxDepth} / ノード ${maxNodes}）。設定 dotnetX86.dump.maxDepth / maxNodes で変更できます。`,
        );
    }
}

function requireSession(): vscode.DebugSession | undefined {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
        void vscode.window.showErrorMessage('デバッグ中ではありません。ブレークポイントで停止してから実行してください。');
    }
    return session;
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
