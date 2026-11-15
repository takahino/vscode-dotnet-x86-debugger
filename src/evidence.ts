import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { ControlRow, EvidenceData, EvidenceForm, buildEvidence, evidenceFolderName, pictureFileName, valuePropertiesOf } from './evidenceCore';
import { SqlLog } from './sqlLog';
import { shortFrameName } from './sqlLogCore';

const OPEN_FORMS = 'System.Windows.Forms.Application.OpenForms';
/** Every control costs several evaluations (about 20 ms each) while the program is stopped. */
const MAX_CONTROLS = 300;
const MAX_GRID_ROWS = 20;
const MAX_GRID_COLUMNS = 10;
const MAX_LOCALS = 100;
const CAPTURE_TIMEOUT_MS = 60_000;

type Evaluate = (expression: string) => Promise<string>;

/**
 * "Capture Evidence": saves what a test report needs from the stopped screen - a picture of every open form, the
 * values of their controls (and of the DataGridView cells), the variables, the call stack and the SQL run since the
 * previous capture - as a Markdown file and PNG files in a new folder, so no one has to paste screenshots by hand.
 */
export class EvidenceCapture implements vscode.Disposable {
    /** Number of the last SQL log entry that went into a capture. */
    private lastSqlNumber = 0;

    constructor(
        private readonly extensionPath: string,
        private readonly sqlLog: SqlLog,
        private readonly log: (line: string) => void,
    ) {}

    async capture(): Promise<void> {
        const frame = vscode.debug.activeStackItem;
        if (!(frame instanceof vscode.DebugStackFrame) || frame.session.type !== DEBUG_TYPE) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Stop the program, then run this command: it captures the stopped screen.'));
            return;
        }
        const folder = this.targetFolder(frame.session);
        if (!folder) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Open a folder first: the evidence is saved in it.'));
            return;
        }
        const time = new Date();
        const dir = path.join(folder, evidenceFolderName(time));
        try {
            fs.mkdirSync(dir, { recursive: true });
            const data = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Capturing evidence…'), cancellable: true },
                (_progress, token) => this.collect(frame, dir, time, token),
            );
            const file = path.join(dir, 'evidence.md');
            fs.writeFileSync(file, buildEvidence(data, (text) => vscode.l10n.t(text)), 'utf8');
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
            void vscode.window.showInformationMessage(vscode.l10n.t('Saved the evidence in {0}.', dir));
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not capture the evidence: {0}', e instanceof Error ? e.message : String(e)));
        }
    }

    dispose(): void {}

    private targetFolder(session: vscode.DebugSession): string | undefined {
        const base = session.workspaceFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!base) {
            return undefined;
        }
        const configured = vscode.workspace.getConfiguration('dotnetX86.evidence', session.workspaceFolder?.uri).get<string>('folder', 'evidence').trim() || 'evidence';
        return path.isAbsolute(configured) ? configured : path.join(base, configured);
    }

    private async collect(frame: vscode.DebugStackFrame, dir: string, time: Date, token: vscode.CancellationToken): Promise<EvidenceData> {
        const session = frame.session;
        const request = (command: string, args: Record<string, unknown>) => session.customRequest(command, args);
        const evaluate: Evaluate = async (expression) => {
            const r = await request('evaluate', { expression, frameId: frame.frameId, context: 'watch' });
            return unquote(String(r?.result ?? ''));
        };

        const data: EvidenceData = { time, program: path.basename(String(session.configuration.program ?? '')) || undefined, stack: [], locals: [], forms: [], sql: [] };

        // Where the program is stopped.
        try {
            const stack = (await request('stackTrace', { threadId: frame.threadId, startFrame: 0, levels: 30 }))?.stackFrames ?? [];
            data.stack = stack.map((f: { name: string; source?: { path?: string }; line?: number }) => `${shortFrameName(f.name)}${f.source?.path ? `  ${path.basename(f.source.path)}:${f.line}` : ''}`);
            const selected = stack.find((f: { id: number }) => f.id === frame.frameId) ?? stack[0];
            if (selected) {
                data.location = { name: shortFrameName(selected.name), file: selected.source?.path ? path.basename(selected.source.path) : undefined, line: selected.line };
                if (selected.source?.path && selected.line) {
                    data.location.code = readLine(selected.source.path, selected.line);
                }
            }
        } catch (e) {
            this.log(`[evidence] stack: ${errorMessage(e)}`);
        }

        // Variables of the selected frame (one level: the values as the Variables view shows them).
        try {
            const scopes = (await request('scopes', { frameId: frame.frameId }))?.scopes ?? [];
            if (scopes[0]?.variablesReference) {
                const vars = (await request('variables', { variablesReference: scopes[0].variablesReference }))?.variables ?? [];
                data.locals = vars.slice(0, MAX_LOCALS).map((v: { name: string; value: string; type?: string }) => ({ name: v.name, value: v.value, type: v.type }));
            }
        } catch (e) {
            this.log(`[evidence] variables: ${errorMessage(e)}`);
        }

        // The forms: pictures first (the compositor's image of the stopped windows), then the control values.
        try {
            const count = Number(await evaluate(`${OPEN_FORMS}.Count`)) || 0;
            const pictures: string[] = [];
            for (let i = 0; i < count && !token.isCancellationRequested; i++) {
                const expression = `${OPEN_FORMS}[${i}]`;
                const form: EvidenceForm = {
                    name: await evaluate(`${expression}.Name`).catch(() => ''),
                    type: await evaluate(`${expression}.GetType().FullName`).catch(() => '?'),
                    title: await evaluate(`${expression}.Text`).catch(() => ''),
                    controls: [],
                    truncated: false,
                };
                if ((await evaluate(`${expression}.IsHandleCreated`).catch(() => 'false')) === 'true') {
                    const handle = await evaluate(`${expression}.Handle`).catch(() => '');
                    if (/^\d+$/.test(handle)) {
                        const file = pictureFileName(i, form.name || form.type);
                        pictures.push(`${handle}=${file}`);
                        form.screenshot = file;
                    }
                } else {
                    form.screenshotProblem = vscode.l10n.t('the form has not been shown');
                }
                const budget = { left: MAX_CONTROLS };
                await this.readChildren(evaluate, expression, 0, form.controls, budget, token);
                form.truncated = budget.left <= 0;
                data.forms.push(form);
            }
            if (pictures.length) {
                const answers = await this.takePictures(dir, pictures);
                for (const form of data.forms) {
                    const answer = form.screenshot ? answers.get(form.screenshot) : undefined;
                    if (form.screenshot && answer !== 'ok') {
                        form.screenshotProblem = answer ?? 'no answer';
                        form.screenshot = undefined;
                    }
                }
            }
        } catch (e) {
            data.formsProblem = errorMessage(e);
            this.log(`[evidence] forms: ${errorMessage(e)}`);
        }

        // SQL run since the previous capture.
        const fresh = this.sqlLog.getEntries().filter((s) => s.n > this.lastSqlNumber);
        data.sql = fresh.map((s) => `${this.sqlLog.sqlWithValues(s)};`);
        this.lastSqlNumber = this.sqlLog.getEntries().at(-1)?.n ?? this.lastSqlNumber;
        return data;
    }

    /** The controls inside `expression` (a form or a container), depth first, up to the budget. */
    private async readChildren(evaluate: Evaluate, expression: string, depth: number, rows: ControlRow[], budget: { left: number }, token: vscode.CancellationToken): Promise<void> {
        const count = Number(await evaluate(`${expression}.Controls.Count`).catch(() => '0')) || 0;
        for (let i = 0; i < count && budget.left > 0 && !token.isCancellationRequested; i++) {
            budget.left--;
            const child = `${expression}.Controls[${i}]`;
            const type = await evaluate(`${child}.GetType().FullName`).catch(() => '?');
            const row: ControlRow = {
                depth,
                name: await evaluate(`${child}.Name`).catch(() => ''),
                type,
                text: await evaluate(`${child}.Text`).catch(() => ''),
                visible: (await evaluate(`${child}.Visible`).catch(() => 'true')) === 'true',
                enabled: (await evaluate(`${child}.Enabled`).catch(() => 'true')) === 'true',
            };
            const values: string[] = [];
            for (const p of valuePropertiesOf(type)) {
                const v = await evaluate(`${child}.${p.property}`).catch(() => undefined);
                if (v !== undefined) {
                    values.push(`${p.label}: ${v}`);
                }
            }
            if (values.length) {
                row.value = values.join(', ');
            }
            if (/\.DataGridView$/.test(type)) {
                row.grid = await readGrid(evaluate, child).catch(() => undefined);
            }
            rows.push(row);
            await this.readChildren(evaluate, child, depth + 1, rows, budget, token);
        }
    }

    /** Runs windowCapture.ps1 for "<hwnd>=<file>" entries; returns each file's answer ("ok" or the reason). */
    private takePictures(dir: string, entries: string[]): Promise<Map<string, string>> {
        const script = path.join(this.extensionPath, 'resources', 'windowCapture.ps1');
        return new Promise((resolve) => {
            cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutDir', dir, '-Windows', entries.join(';')],
                { windowsHide: true, timeout: CAPTURE_TIMEOUT_MS }, (error, stdout, stderr) => {
                    const answers = new Map<string, string>();
                    for (const line of stdout.split(/\r?\n/)) {
                        const [name, answer] = line.split('\t');
                        if (name && answer) {
                            answers.set(name, answer.trim());
                        }
                    }
                    if (error || stderr) {
                        this.log(`[evidence] picture helper: ${error?.message ?? ''} ${stderr}`.trim());
                    }
                    resolve(answers);
                });
        });
    }
}

/** The first rows and columns of a DataGridView, as their cell values show. */
async function readGrid(evaluate: Evaluate, grid: string): Promise<ControlRow['grid']> {
    const rowCount = Number(await evaluate(`${grid}.RowCount`)) || 0;
    const columns = Math.min(Number(await evaluate(`${grid}.ColumnCount`)) || 0, MAX_GRID_COLUMNS);
    const headers: string[] = [];
    for (let c = 0; c < columns; c++) {
        headers.push(await evaluate(`${grid}.Columns[${c}].HeaderText`).catch(() => `#${c + 1}`));
    }
    const rows: string[][] = [];
    for (let r = 0; r < Math.min(rowCount, MAX_GRID_ROWS); r++) {
        if ((await evaluate(`${grid}.Rows[${r}].IsNewRow`).catch(() => 'false')) === 'true') {
            continue; // the empty row at the end of an editable grid
        }
        const row: string[] = [];
        for (let c = 0; c < columns; c++) {
            // FormattedValue is the text the user sees (a null cell is "").
            row.push(await evaluate(`${grid}.Rows[${r}].Cells[${c}].FormattedValue`).catch(() => ''));
        }
        rows.push(row);
    }
    return { headers, rows, rowCount };
}

function readLine(file: string, line: number): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/)[line - 1];
    } catch {
        return undefined;
    }
}

/** netcoredbg returns strings as C# literals ("abc", with escapes). */
function unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t', '0': '\0' })[c] ?? c);
    }
    return value;
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
