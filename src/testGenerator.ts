import * as fs from 'fs';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { TestFramework, captureValues, detectFrameworks, findMethodSignature, generateTest, parseFrameName } from './testGenCore';

const FRAMEWORK_LABELS: Record<TestFramework, string> = { xunit: 'xUnit', nunit: 'NUnit', mstest: 'MSTest' };

/**
 * "Generate Unit Test from Here": a test that calls the method of the selected Call Stack frame again with the
 * arguments (and object) it has now, in the test framework the workspace uses. Opened as an unsaved document.
 */
export async function generateTestCommand(): Promise<void> {
    const item = vscode.debug.activeStackItem;
    if (!(item instanceof vscode.DebugStackFrame) || item.session.type !== DEBUG_TYPE) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Stop the program and select the method in the Call Stack view.'));
        return;
    }
    const session = item.session;
    try {
        const stack = await session.customRequest('stackTrace', { threadId: item.threadId, startFrame: 0, levels: 200 });
        const frame = (stack?.stackFrames ?? []).find((f: { id: number }) => f.id === item.frameId);
        const sourcePath: string | undefined = frame?.source?.path;
        if (!frame || !sourcePath || !fs.existsSync(sourcePath)) {
            void vscode.window.showErrorMessage(vscode.l10n.t('The selected frame has no source file here. Select a frame of your own code in the Call Stack view.'));
            return;
        }
        const method = parseFrameName(String(frame.name ?? ''));
        if (!method) {
            void vscode.window.showErrorMessage(vscode.l10n.t('{0} is a lambda, local function or constructor, which a test cannot call. Select the frame of the method that uses it.', String(frame.name)));
            return;
        }
        const lines = (await vscode.workspace.openTextDocument(sourcePath)).getText().split(/\r?\n/);
        const signature = findMethodSignature(lines, frame.line, method.method);
        if (!signature) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not find the declaration of {0} above line {1} of {2}.', method.method, frame.line, vscode.workspace.asRelativePath(sourcePath)));
            return;
        }
        const framework = await pickFramework();
        if (!framework) {
            return;
        }

        const config = vscode.workspace.getConfiguration('dotnetX86.dump');
        const captured = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the arguments of {0}…', method.method) },
            () =>
                captureValues(
                    signature,
                    (expression) => session.customRequest('evaluate', { expression, frameId: item.frameId, context: 'watch' }),
                    (command, args) => session.customRequest(command, args),
                    { maxDepth: config.get<number>('maxDepth', 3), maxNodes: config.get<number>('maxNodes', 2000) },
                ),
        );
        const location = `${vscode.workspace.asRelativePath(sourcePath)}:${frame.line}`;
        const code = generateTest({ framework, frame: method, signature, values: captured.values, instance: captured.instance, location });
        const doc = await vscode.workspace.openTextDocument({ language: 'csharp', content: code });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        if (captured.problems.length) {
            void vscode.window.showWarningMessage(vscode.l10n.t('Some values could not be read completely and are marked TODO: {0}', captured.problems.join('; ')));
        }
    } catch (e) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not generate the test: {0}', e instanceof Error ? e.message : String(e)));
    }
}

/** The framework the workspace's projects reference; asks when there is none or more than one. */
async function pickFramework(): Promise<TestFramework | undefined> {
    const projects = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules,.git}/**', 500);
    const texts = await Promise.all(projects.map((uri) => fs.promises.readFile(uri.fsPath, 'utf8').catch(() => '')));
    const detected = detectFrameworks(texts);
    if (detected.length === 1) {
        return detected[0];
    }
    const all: TestFramework[] = ['xunit', 'nunit', 'mstest'];
    const items = (detected.length ? detected : all).map((f) => ({
        label: FRAMEWORK_LABELS[f],
        description: detected.includes(f) ? vscode.l10n.t('used in this workspace') : undefined,
        framework: f,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Test framework for the generated test') });
    return picked?.framework;
}
