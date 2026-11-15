import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { ControlNode } from './controlTree';
import { BindingSourceInfo, DataBindings, Position, readDataBindings } from './dataBindingsCore';

const OPEN_FORMS = 'System.Windows.Forms.Application.OpenForms';

/**
 * "Show Data Bindings": a table of the WinForms data bindings of a form (or of every open form) while the program is
 * stopped - which control property is bound to which member, the value on each side, where the list stands - and
 * which bindings are not connected or show something else than their source holds. Visual Studio has no such view.
 */
export class DataBindingsPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    /** What the panel shows, to read it again with Refresh. */
    private roots: { expression: string }[] = [];
    private rows: { expression: string; label: string }[] = [];

    constructor(private readonly highlight: (node: ControlNode) => Thenable<void> | void) {}

    /** Reads the bindings of `node` and the controls inside it, or of every open form without a node. */
    async show(node?: ControlNode): Promise<void> {
        this.roots = node ? [{ expression: node.expression }] : [];
        await this.read();
    }

    dispose(): void {
        this.panel?.dispose();
    }

    private async read(): Promise<void> {
        const evaluate = evaluator();
        if (!evaluate) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Stop the program to see its WinForms controls.'));
            return;
        }
        let roots = this.roots;
        try {
            if (roots.length === 0) {
                const count = Number(await evaluate(`${OPEN_FORMS}.Count`)) || 0;
                if (count === 0) {
                    void vscode.window.showInformationMessage(vscode.l10n.t('No WinForms form is open.'));
                    return;
                }
                roots = Array.from({ length: count }, (_v, i) => ({ expression: `${OPEN_FORMS}[${i}]` }));
            }
            const bindings = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the data bindings…'), cancellable: true },
                (progress, token) => readDataBindings(roots, evaluate, {
                    onProgress: (n) => progress.report({ message: vscode.l10n.t('{0} controls', n) }),
                    cancelled: () => token.isCancellationRequested,
                }),
            );
            this.render(bindings);
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not read the data bindings: {0}', e instanceof Error ? e.message : String(e)));
        }
    }

    private render(bindings: DataBindings): void {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('dotnetX86.dataBindings', vscode.l10n.t('Data Bindings (.NET x86)'), vscode.ViewColumn.Beside, { enableScripts: true });
            this.panel.onDidDispose(() => (this.panel = undefined));
            this.panel.webview.onDidReceiveMessage((m: { type?: string; row?: number }) => {
                if (m?.type === 'refresh') {
                    void this.read();
                } else if (m?.type === 'highlight' && typeof m.row === 'number' && this.rows[m.row]) {
                    const row = this.rows[m.row];
                    const name = row.label.split(' › ').pop() ?? '';
                    void this.highlight({ expression: row.expression, name, typeName: '', text: '', visible: true, childCount: 0 });
                }
            });
        } else {
            this.panel.reveal(undefined, true);
        }
        // Rows refer to controls by index: the page never sends an expression back.
        this.rows = [...bindings.simple, ...bindings.lists].map((b) => ({ expression: b.controlExpression, label: b.control }));
        this.panel.webview.html = renderHtml(bindings);
    }
}

/** Evaluates in the selected stack frame of a stopped dotnet-x86 session; strings come back without their quotes. */
function evaluator(): ((expression: string) => Promise<string>) | undefined {
    const frame = vscode.debug.activeStackItem;
    if (!(frame instanceof vscode.DebugStackFrame) || frame.session.type !== DEBUG_TYPE) {
        return undefined;
    }
    return async (expression) => {
        const r = await frame.session.customRequest('evaluate', { expression, frameId: frame.frameId, context: 'watch' });
        const value = String(r?.result ?? '');
        return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
    };
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function position(p: Position | undefined): string {
    return p ? (p.index < 0 ? vscode.l10n.t('none of {0}', p.count) : `${p.index + 1} / ${p.count}`) : '';
}

/** "BindingSource → BindingList<Customer>" with its data member, filter and sort. */
function source(type: string, bs: BindingSourceInfo | undefined): string {
    if (!bs) {
        return `<code>${escapeHtml(type)}</code>`;
    }
    const extras = [
        bs.dataMember && `DataMember: ${bs.dataMember}`,
        bs.filter && `Filter: ${bs.filter}`,
        bs.sort && `Sort: ${bs.sort}`,
    ].filter(Boolean).map((x) => `<div class="hint">${escapeHtml(x as string)}</div>`).join('');
    return `<code>${escapeHtml(type)}</code>${bs.dataSourceType ? ` → <code>${escapeHtml(bs.dataSourceType)}</code>` : ''}${extras}`;
}

function value(v: string | undefined): string {
    return v === undefined ? '<span class="hint">?</span>' : `<code>${escapeHtml(v)}</code>`;
}

function renderHtml(b: DataBindings): string {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const t = vscode.l10n.t;
    const eye = (row: number) => `<button class="icon" data-row="${row}" title="${escapeHtml(t('Highlight on Screen'))}">◎</button>`;
    const problems = b.simple.filter((x) => !x.active || x.differs).length;

    const simpleRows = b.simple.map((x, i) => {
        const status = !x.active
            ? `<span class="warn" title="${escapeHtml(t('The binding is not connected: the member does not exist on the data source, or the control has not been created yet.'))}">⚠ ${escapeHtml(t('not connected'))}</span>`
            : x.differs
                ? `<span class="warn" title="${escapeHtml(t('The control shows another value than the current item holds: an edit not written back yet (update mode {0}), or the source changed without notifying.', x.updateMode))}">≠ ${escapeHtml(t('differs'))}</span>`
                : '';
        const format = x.formattingEnabled ? (x.formatString ? `<code>${escapeHtml(x.formatString)}</code>` : t('on')) : '';
        return `<tr><td>${eye(i)}</td><td class="control">${escapeHtml(x.control)}</td><td><code>${escapeHtml(x.property)}</code></td>` +
            `<td>${source(x.sourceType, x.bindingSource)}</td><td><code>${escapeHtml(x.member)}</code></td>` +
            `<td>${value(x.controlValue)}</td><td>${value(x.sourceValue)}</td><td>${status}</td>` +
            `<td class="num">${position(x.position)}</td><td>${escapeHtml(x.updateMode)}</td><td>${format}</td></tr>`;
    }).join('');

    const listRows = b.lists.map((x, i) => {
        const members = [
            x.dataMember && `DataMember: <code>${escapeHtml(x.dataMember)}</code>`,
            x.displayMember && `DisplayMember: <code>${escapeHtml(x.displayMember)}</code>`,
            x.valueMember && `ValueMember: <code>${escapeHtml(x.valueMember)}</code>`,
        ].filter(Boolean).join('<br>');
        return `<tr><td>${eye(b.simple.length + i)}</td><td class="control">${escapeHtml(x.control)}</td><td>${escapeHtml(x.controlType)}</td>` +
            `<td>${source(x.sourceType, x.bindingSource)}</td><td>${members}</td><td>${x.selectedValue === undefined ? '' : value(x.selectedValue)}</td>` +
            `<td class="num">${position(x.position)}</td></tr>`;
    }).join('');

    const summary = [
        t('{0} simple bindings, {1} list bindings in {2} controls.', b.simple.length, b.lists.length, b.controls),
        problems ? t('{0} need a look (⚠ / ≠).', problems) : '',
        b.truncated ? t('Only the first {0} controls were read.', b.controls) : '',
        t('Values as of the stop at {0}.', new Date().toLocaleTimeString()),
    ].filter(Boolean).join(' ');

    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 12px; }
  h2 { font-size: 13px; margin: 16px 0 6px; }
  .hint { color: var(--vscode-descriptionForeground); }
  .bar { display: flex; gap: 12px; align-items: center; margin-bottom: 6px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 12px; cursor: pointer; }
  button.icon { background: none; color: var(--vscode-foreground); padding: 0 4px; }
  button.icon:hover { color: var(--vscode-textLink-foreground); }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 3px 8px; white-space: nowrap; font-weight: 600; }
  td { padding: 3px 8px; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.control { white-space: nowrap; }
  code { font-family: var(--vscode-editor-font-family); word-break: break-all; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .warn { white-space: nowrap; }
  .warn::first-letter { color: var(--vscode-editorWarning-foreground); }
</style>
</head>
<body>
<div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button><span class="hint">${escapeHtml(summary)}</span></div>
<h2>${escapeHtml(t('Simple bindings (Control.DataBindings)'))}</h2>
${b.simple.length ? `<table><thead><tr><th></th><th>${escapeHtml(t('Control'))}</th><th>${escapeHtml(t('Property'))}</th><th>${escapeHtml(t('Data source'))}</th><th>${escapeHtml(t('Member'))}</th>` +
    `<th>${escapeHtml(t('Control value'))}</th><th>${escapeHtml(t('Source value'))}</th><th></th><th>${escapeHtml(t('Position'))}</th><th>${escapeHtml(t('Update'))}</th><th>${escapeHtml(t('Format'))}</th></tr></thead><tbody>${simpleRows}</tbody></table>`
    : `<p class="hint">${escapeHtml(t('None.'))}</p>`}
<h2>${escapeHtml(t('List bindings (DataSource)'))}</h2>
${b.lists.length ? `<table><thead><tr><th></th><th>${escapeHtml(t('Control'))}</th><th>${escapeHtml(t('Type'))}</th><th>${escapeHtml(t('Data source'))}</th><th>${escapeHtml(t('Members'))}</th>` +
    `<th>SelectedValue</th><th>${escapeHtml(t('Position'))}</th></tr></thead><tbody>${listRows}</tbody></table>`
    : `<p class="hint">${escapeHtml(t('None.'))}</p>`}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-row]');
  if (button) vscode.postMessage({ type: 'highlight', row: Number(button.dataset.row) });
});
</script>
</body>
</html>`;
}
