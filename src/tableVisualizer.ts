import * as fs from 'fs';
import * as vscode from 'vscode';
import { DapVariable, collectTree } from './dumpCore';
import { Table, buildTable, cellText, toCsv } from './tableCore';
import { Target, VariablesContextArg, collect, targetFromContext } from './variableDump';

/** Rows read from a DataTable (one evaluation each) and nodes walked for other collections. */
const MAX_ROWS = 1000;
const MAX_NODES = 20000;

/** Shows List<T> / arrays / Dictionary / DataTable variables as a sortable, filterable table (with CSV export). */
export async function viewAsTableCommand(arg?: VariablesContextArg): Promise<void> {
    const target = targetFromContext(arg, vscode.l10n.t('View as Table'));
    if (!target) {
        return;
    }
    let table: Table | undefined;
    let truncated = false;
    if (target.root.type === 'System.Data.DataTable') {
        const result = await readDataTable(target);
        table = result?.table;
        truncated = result?.truncated ?? false;
    } else {
        const result = await collect(target, { maxDepth: 2, maxNodes: MAX_NODES, formatValue: (v) => formatWithToString(target, v) });
        if (!result) {
            return;
        }
        table = buildTable(result.node);
        truncated = result.truncated;
    }
    if (!table) {
        void vscode.window.showErrorMessage(
            vscode.l10n.t('{0} cannot be shown as a table (type: {1}). Use it on a List<T>, array, Dictionary or DataTable.', target.expression, target.root.type ?? '?'),
        );
        return;
    }
    showTable(target.expression, table, truncated);
}

function currentFrameId(): number | undefined {
    const frame = vscode.debug.activeStackItem;
    return frame instanceof vscode.DebugStackFrame ? frame.frameId : undefined;
}

async function evaluate(target: Target, expression: string): Promise<{ result: string; type?: string; variablesReference: number } | undefined> {
    try {
        return await target.session.customRequest('evaluate', { expression, frameId: currentFrameId(), context: 'watch' });
    } catch {
        return undefined;
    }
}

/** DateTime & co. in one `ToString()` evaluation instead of walking their members. */
async function formatWithToString(target: Target, variable: DapVariable): Promise<string | undefined> {
    return (await evaluate(target, `${variable.evaluateName}.ToString()`))?.result;
}

/** A DataTable's internals are not a plain list, so it is read through Columns / Rows[i].ItemArray expressions. */
async function readDataTable(target: Target): Promise<{ table: Table; truncated: boolean } | undefined> {
    const e = target.expression;
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading {0}…', e), cancellable: true },
        async (_progress, token) => {
            const columnCount = Number((await evaluate(target, `${e}.Columns.Count`))?.result);
            const rowCount = Number((await evaluate(target, `${e}.Rows.Count`))?.result);
            if (!Number.isInteger(columnCount) || !Number.isInteger(rowCount)) {
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not read the value: {0}', e));
                return undefined;
            }
            const columns: string[] = [];
            for (let c = 0; c < columnCount; c++) {
                const name = (await evaluate(target, `${e}.Columns[${c}].ColumnName`))?.result ?? `Column${c}`;
                columns.push(cellText({ kind: 'leaf', type: 'string', text: name }));
            }
            const rows: string[][] = [];
            const request = (command: string, args: Record<string, unknown>) => target.session.customRequest(command, args);
            for (let r = 0; r < Math.min(rowCount, MAX_ROWS) && !token.isCancellationRequested; r++) {
                const items = await evaluate(target, `${e}.Rows[${r}].ItemArray`);
                if (!items) {
                    rows.push(columns.map(() => '<error>'));
                    continue;
                }
                const { node } = await collectTree(
                    request,
                    { name: `[${r}]`, value: items.result, type: items.type, variablesReference: items.variablesReference },
                    { maxDepth: 2, maxNodes: MAX_NODES, formatValue: (v) => formatWithToString(target, v) },
                );
                rows.push(node.kind === 'list' ? node.items.map(cellText) : [cellText(node)]);
            }
            return { table: { columns: ['Row', ...columns], rows: rows.map((cells, i) => [String(i), ...cells]) }, truncated: rowCount > MAX_ROWS };
        },
    );
}

function showTable(expression: string, table: Table, truncated: boolean): void {
    const panel = vscode.window.createWebviewPanel(
        'netdbg.table',
        vscode.l10n.t('Table: {0}', expression),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true },
    );
    panel.webview.html = renderHtml(expression, table, truncated, localizedStrings());
    panel.webview.onDidReceiveMessage(async (m) => {
        if (m?.type === 'copy') {
            await vscode.env.clipboard.writeText(toCsv(table));
            void vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} rows as CSV.', table.rows.length));
        } else if (m?.type === 'save') {
            const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: vscode.l10n.t('Save CSV') });
            if (uri) {
                // UTF-8 with BOM so that Excel opens non-ASCII text correctly.
                fs.writeFileSync(uri.fsPath, '﻿' + toCsv(table), 'utf8');
            }
        }
    });
}

function localizedStrings() {
    return {
        filter: vscode.l10n.t('Filter rows'),
        copy: vscode.l10n.t('Copy CSV'),
        save: vscode.l10n.t('Save CSV...'),
        rows: vscode.l10n.t('{0} of {1} rows'),
        truncated: vscode.l10n.t('Only part of the collection was read (limit reached).'),
        sortHint: vscode.l10n.t('Click a column header to sort.'),
    };
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHtml(expression: string, table: Table, truncated: boolean, t: ReturnType<typeof localizedStrings>): string {
    const nonce = Math.random().toString(36).slice(2);
    const data = JSON.stringify({ table, t }).replace(/</g, '\\u003c');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
  h1 { font-size: 1.1em; font-weight: 600; margin: 0 0 8px; font-family: var(--vscode-editor-font-family, monospace); }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
          padding: 3px 6px; min-width: 200px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .info { color: var(--vscode-descriptionForeground); }
  .warn { color: var(--vscode-editorWarning-foreground); margin-bottom: 8px; }
  .wrap { overflow: auto; max-height: calc(100vh - 110px); }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 3px 12px 3px 6px; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.2)); white-space: nowrap; text-align: left; }
  td.num, th.num { text-align: right; }
  th { position: sticky; top: 0; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-weight: 600; cursor: pointer; user-select: none; }
  th[aria-sort="ascending"]::after { content: " ▲"; }
  th[aria-sort="descending"]::after { content: " ▼"; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<h1>${escapeHtml(expression)}</h1>
${truncated ? `<div class="warn">${escapeHtml(t.truncated)}</div>` : ''}
<div class="toolbar">
  <input id="filter" type="search" placeholder="${escapeHtml(t.filter)}" aria-label="${escapeHtml(t.filter)}">
  <button id="copy">${escapeHtml(t.copy)}</button>
  <button id="save">${escapeHtml(t.save)}</button>
  <span class="info" id="count"></span>
  <span class="info">${escapeHtml(t.sortHint)}</span>
</div>
<div class="wrap"><table id="table"></table></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const { table, t } = ${data};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isNum = (s) => /^-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?$/.test(s);
// A column is numeric when every non-empty cell is a number: it sorts by value and is right-aligned.
const numeric = table.columns.map((_, c) => table.rows.every((r) => r[c] === '' || r[c] === 'null' || isNum(r[c])));
let sort = { col: -1, dir: 1 };
let rows = table.rows.slice();

function render() {
  const q = document.getElementById('filter').value.toLowerCase();
  const shown = rows.filter((r) => !q || r.some((c) => c.toLowerCase().includes(q)));
  const head = '<tr>' + table.columns.map((c, i) => '<th data-col="' + i + '"' + (numeric[i] ? ' class="num"' : '') + (sort.col === i ? ' aria-sort="' + (sort.dir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' + esc(c) + '</th>').join('') + '</tr>';
  const body = shown.map((r) => '<tr>' + r.map((c, i) => '<td' + (numeric[i] ? ' class="num"' : '') + '>' + esc(c) + '</td>').join('') + '</tr>').join('');
  document.getElementById('table').innerHTML = head + body;
  document.getElementById('count').textContent = t.rows.replace('{0}', shown.length).replace('{1}', table.rows.length);
}

document.getElementById('table').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const col = Number(th.dataset.col);
  sort = { col, dir: sort.col === col ? -sort.dir : 1 };
  rows.sort((a, b) => {
    const x = a[col], y = b[col];
    const cmp = numeric[col] ? (Number(x) || 0) - (Number(y) || 0) : x.localeCompare(y, undefined, { numeric: true });
    return cmp * sort.dir;
  });
  render();
});
document.getElementById('filter').addEventListener('input', render);
document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save' }));
render();
</script>
</body>
</html>`;
}
