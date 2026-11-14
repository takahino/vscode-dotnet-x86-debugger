import * as vscode from 'vscode';
import { toCSharpStatement } from './csharpInitializer';
import { CollectResult, DapVariable, DumpCancelledError, collectTree, parseLeaf, toJson } from './dumpCore';
import { StringFormat, detectFormat, formatString } from './stringFormat';

/** Argument VS Code passes to commands contributed to "debug/variables/context". */
interface VariablesContextArg {
    variable?: DapVariable & { evaluateName?: string };
}

interface Target {
    session: vscode.DebugSession;
    /** Expression identifying the variable (its evaluateName), used for titles and snapshot keys. */
    expression: string;
    root: DapVariable;
}

export const SNAPSHOT_SCHEME = 'dotnetx86-snapshot';

/** Serves snapshot / current-value documents shown by "Compare with Snapshot". */
export class SnapshotStore implements vscode.TextDocumentContentProvider {
    private readonly snapshots = new Map<string, { json: string; takenAt: Date }>();
    private readonly documents = new Map<string, string>();
    private counter = 0;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.documents.get(uri.toString()) ?? '';
    }

    take(expression: string, json: string): void {
        this.snapshots.set(expression, { json, takenAt: new Date() });
    }

    get(expression: string) {
        return this.snapshots.get(expression);
    }

    /** Registers content under a unique virtual URI so each comparison opens fresh documents. */
    createDocument(label: string, content: string): vscode.Uri {
        const uri = vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${label}.json`, query: String(++this.counter) });
        this.documents.set(uri.toString(), content);
        return uri;
    }
}

export async function dumpVariableCommand(arg?: VariablesContextArg): Promise<void> {
    const target = targetFromContext(arg, 'Dump Variable');
    if (target) {
        await showDump(target);
    }
}

export async function dumpExpressionCommand(): Promise<void> {
    const target = await targetFromInput();
    if (target) {
        await showDump(target);
    }
}

export async function copyAsCSharpCommand(arg?: VariablesContextArg): Promise<void> {
    const target = targetFromContext(arg, 'Copy as C# Initializer');
    const result = target && (await collect(target));
    if (!target || !result) {
        return;
    }
    await vscode.env.clipboard.writeText(toCSharpStatement(target.expression, result.node));
    void vscode.window.showInformationMessage(
        `${target.expression} を C# の初期化子としてコピーしました。get 専用プロパティも含まれるため、必要に応じて削除してください。`,
    );
    reportTruncation(result);
}

export async function viewStringCommand(arg?: VariablesContextArg): Promise<void> {
    const target = targetFromContext(arg, 'View String');
    if (!target) {
        return;
    }
    if (target.root.type !== 'string' || target.root.value === 'null') {
        void vscode.window.showErrorMessage(`${target.expression} は文字列ではありません（型: ${target.root.type ?? '不明'}）。string 型の変数で実行してください。`);
        return;
    }
    const value = String(parseLeaf(target.root.value));
    const detected = detectFormat(value);
    const choices: { label: string; format: StringFormat }[] = [
        { label: `自動判定 (${detected})`, format: detected },
        { label: 'JSON', format: 'json' },
        { label: 'XML', format: 'xml' },
        { label: 'HTML', format: 'html' },
        { label: 'テキスト', format: 'text' },
    ];
    const picked = await vscode.window.showQuickPick(choices, { placeHolder: `${target.expression} の表示形式` });
    if (!picked) {
        return;
    }
    const languageByFormat: Record<StringFormat, string> = { json: 'json', xml: 'xml', html: 'html', text: 'plaintext' };
    const doc = await vscode.workspace.openTextDocument({ language: languageByFormat[picked.format], content: formatString(value, picked.format) });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    if (picked.format === 'html') {
        // HTML has a built-in formatter in VS Code; XML / JSON are formatted by formatString.
        await vscode.commands.executeCommand('editor.action.formatDocument');
    }
}

export async function takeSnapshotCommand(store: SnapshotStore, arg?: VariablesContextArg): Promise<void> {
    const target = targetFromContext(arg, 'Take Snapshot');
    const result = target && (await collect(target));
    if (!target || !result) {
        return;
    }
    store.take(target.expression, JSON.stringify(toJson(result.node), null, 2));
    void vscode.window.showInformationMessage(
        `${target.expression} のスナップショットを記録しました。値が変わった後に「Compare with Snapshot」で差分を表示できます。`,
    );
    reportTruncation(result);
}

export async function compareWithSnapshotCommand(store: SnapshotStore, arg?: VariablesContextArg): Promise<void> {
    const target = targetFromContext(arg, 'Compare with Snapshot');
    if (!target) {
        return;
    }
    const snapshot = store.get(target.expression);
    if (!snapshot) {
        void vscode.window.showErrorMessage(`${target.expression} のスナップショットがありません。先に「Take Snapshot」を実行してください。`);
        return;
    }
    const result = await collect(target);
    if (!result) {
        return;
    }
    const current = JSON.stringify(toJson(result.node), null, 2);
    const left = store.createDocument(`${target.expression} (snapshot)`, snapshot.json);
    const right = store.createDocument(`${target.expression} (now)`, current);
    const time = snapshot.takenAt.toLocaleTimeString();
    await vscode.commands.executeCommand('vscode.diff', left, right, `${target.expression}: ${time} ↔ 現在`);
    if (snapshot.json === current) {
        void vscode.window.showInformationMessage(`${target.expression} はスナップショット（${time}）から変化していません。`);
    }
}

function targetFromContext(arg: VariablesContextArg | undefined, commandTitle: string): Target | undefined {
    const session = requireSession();
    if (!session) {
        return undefined;
    }
    if (!arg?.variable) {
        void vscode.window.showErrorMessage(`変数ビューで変数を右クリックして「${commandTitle}」を実行してください。`);
        return undefined;
    }
    const v = arg.variable;
    return {
        session,
        expression: v.evaluateName ?? v.name,
        root: { name: v.name, value: v.value, type: v.type, variablesReference: v.variablesReference },
    };
}

async function targetFromInput(): Promise<Target | undefined> {
    const session = requireSession();
    if (!session) {
        return undefined;
    }
    const expression = await vscode.window.showInputBox({
        prompt: 'ダンプする式（例: this, myList, order.Items）',
        placeHolder: 'this',
    });
    if (!expression) {
        return undefined;
    }
    const frame = vscode.debug.activeStackItem;
    const frameId = frame instanceof vscode.DebugStackFrame ? frame.frameId : undefined;
    try {
        const evaluated = await session.customRequest('evaluate', { expression, frameId, context: 'watch' });
        return {
            session,
            expression,
            root: { name: expression, value: evaluated.result, type: evaluated.type, variablesReference: evaluated.variablesReference },
        };
    } catch (e) {
        void vscode.window.showErrorMessage(`式を評価できませんでした: ${expression} (${errorMessage(e)})。停止中のフレームで評価できる式か確認してください。`);
        return undefined;
    }
}

/** Walks the variable with progress and cancellation; returns undefined when cancelled or failed (already reported). */
async function collect(target: Target): Promise<CollectResult | undefined> {
    const config = vscode.workspace.getConfiguration('dotnetX86.dump');
    try {
        return await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${target.expression} の値を取得しています…`, cancellable: true },
            (_progress, token) =>
                collectTree((command, args) => target.session.customRequest(command, args), target.root, {
                    maxDepth: config.get<number>('maxDepth', 3),
                    maxNodes: config.get<number>('maxNodes', 2000),
                    isCancelled: () => token.isCancellationRequested,
                }),
        );
    } catch (e) {
        if (!(e instanceof DumpCancelledError)) {
            void vscode.window.showErrorMessage(`値の取得に失敗しました: ${errorMessage(e)}`);
        }
        return undefined;
    }
}

async function showDump(target: Target): Promise<void> {
    const result = await collect(target);
    if (!result) {
        return;
    }
    const content = JSON.stringify({ [target.expression]: toJson(result.node) }, null, 2);
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    reportTruncation(result);
}

function reportTruncation(result: CollectResult): void {
    if (result.truncated) {
        const config = vscode.workspace.getConfiguration('dotnetX86.dump');
        void vscode.window.showInformationMessage(
            `上限に達したため一部を展開していません（深さ ${config.get('maxDepth', 3)} / ノード ${config.get('maxNodes', 2000)}）。設定 dotnetX86.dump.maxDepth / maxNodes で変更できます。`,
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
