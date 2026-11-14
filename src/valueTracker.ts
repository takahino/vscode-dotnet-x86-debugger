import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { TRACK_EVENT, TRACK_PREFIX } from './dapProxy';

interface TrackedValue {
    expression: string;
    value: string;
    type?: string;
    error?: string;
}

interface Hit {
    /** 1-based hit number across all trackers */
    n: number;
    time: number;
    location: string;
    values: TrackedValue[];
}

/** Keeps the chart responsive in long loops; older hits are dropped. */
const MAX_HITS = 5000;

/**
 * "Value trend": records expressions at a line on every pass without stopping (a "#track:" logpoint handled by
 * the DAP relay) and charts them per expression, hit by hit.
 */
export class ValueTracker implements vscode.Disposable {
    private hits: Hit[] = [];
    private panel: vscode.WebviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === DEBUG_TYPE) {
                    this.hits = [];
                    this.post();
                }
            }),
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type === DEBUG_TYPE && e.event === TRACK_EVENT) {
                    this.record(e.body);
                }
            }),
        );
    }

    /** Adds a "#track:" logpoint on the current line for the expressions the user enters. */
    async addTracker(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Open a C# file and put the cursor on the line to track.'));
            return;
        }
        const position = editor.selection.active;
        const wordRange = editor.document.getWordRangeAtPosition(position);
        const expressions = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Expressions to record each time line {0} runs, separated by ";" (e.g. total; items.Count)', position.line + 1),
            value: wordRange ? editor.document.getText(wordRange) : '',
        });
        if (!expressions?.trim()) {
            return;
        }
        const location = new vscode.Location(editor.document.uri, new vscode.Position(position.line, 0));
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, undefined, undefined, `${TRACK_PREFIX} ${expressions.trim()}`)]);
        this.show();
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'dotnetX86.valueTrend',
            vscode.l10n.t('Value Trend (.NET x86)'),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = renderHtml(localizedStrings());
        this.panel.onDidDispose(() => (this.panel = undefined));
        this.panel.webview.onDidReceiveMessage((m) => m?.type === 'ready' && this.post());
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.panel?.dispose();
    }

    private record(body: { source?: { path?: string }; line?: number; time?: number; values?: TrackedValue[] }): void {
        const file = body.source?.path ? path.basename(body.source.path) : '?';
        const n = (this.hits[this.hits.length - 1]?.n ?? 0) + 1;
        this.hits.push({ n, time: body.time ?? Date.now(), location: `${file}:${body.line ?? '?'}`, values: body.values ?? [] });
        if (this.hits.length > MAX_HITS) {
            this.hits.shift();
        }
        this.post();
    }

    private post(): void {
        void this.panel?.webview.postMessage({ type: 'data', hits: this.hits });
    }
}

function localizedStrings() {
    return {
        title: vscode.l10n.t('Value trend'),
        waiting: vscode.l10n.t('Right-click a line and choose "Track Value at This Line...", then run the code. Values are recorded each time the line runs, without stopping.'),
        hit: vscode.l10n.t('Hit'),
        location: vscode.l10n.t('Location'),
        notNumeric: vscode.l10n.t('No numeric values to chart; see the data table.'),
        tableSummary: vscode.l10n.t('Data table (last 50 hits)'),
        hits: vscode.l10n.t('{0} hits'),
    };
}

type Strings = ReturnType<typeof localizedStrings>;

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHtml(t: Strings): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  /* One series per chart (small multiples), so every chart uses categorical slot 1, validated against #ffffff / #1f1f1f. */
  :root { --series-1: #2a78d6; }
  body.vscode-dark, body.vscode-high-contrast { --series-1: #3987e5; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
  h1 { font-size: 1.1em; font-weight: 600; margin: 0 0 2px; }
  h2 { font-size: 1em; font-weight: 600; margin: 16px 0 2px; font-family: var(--vscode-editor-font-family, monospace); }
  .sub, .note { color: var(--vscode-descriptionForeground); }
  .sub { margin-bottom: 8px; }
  .stat { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; margin-bottom: 4px; }
  .stat b { color: var(--vscode-foreground); font-weight: 600; }
  .chart { position: relative; }
  svg { display: block; width: 100%; overflow: visible; }
  .grid line { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.18; }
  .axis text { fill: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
  .line { fill: none; stroke: var(--series-1); stroke-width: 2px; stroke-linejoin: round; stroke-linecap: round; }
  .marker { fill: var(--series-1); stroke: var(--vscode-editor-background); stroke-width: 2px; }
  .crosshair { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.5; }
  .tooltip { position: absolute; pointer-events: none; display: none; background: var(--vscode-editorHoverWidget-background);
             color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border);
             padding: 6px 8px; border-radius: 4px; font-variant-numeric: tabular-nums; white-space: nowrap; z-index: 1; }
  details { margin-top: 16px; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  td, th { padding: 2px 12px 2px 0; text-align: right; }
  td.text { text-align: left; }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; }
</style>
</head>
<body>
<h1>${escapeHtml(t.title)}</h1>
<div class="sub" id="sub">${escapeHtml(t.waiting)}</div>
<div id="charts"></div>
<details><summary>${escapeHtml(t.tableSummary)}</summary><table id="table"></table></details>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const T = ${JSON.stringify(t).replace(/</g, '\\u003c')};
const M = { top: 8, right: 24, bottom: 24, left: 64 };
const H = 140;
const el = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v) => (v && !v.error && /^-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?$/.test(v.value) ? Number(v.value) : null);
let hits = [];

function niceStep(range) {
  const raw = range / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Series keyed by "expression @ location", in first-seen order. */
function seriesList() {
  const map = new Map();
  for (const h of hits) for (const v of h.values) {
    const key = v.expression + ' @ ' + h.location;
    if (!map.has(key)) map.set(key, { key, expression: v.expression, points: [] });
    map.get(key).points.push({ n: h.n, v, y: num(v) });
  }
  return [...map.values()];
}

function drawChart(container, s) {
  const pts = s.points.filter((p) => p.y != null);
  const head = document.createElement('h2'); head.textContent = s.key; container.appendChild(head);
  const last = s.points[s.points.length - 1];
  const stat = document.createElement('div'); stat.className = 'stat';
  stat.innerHTML = T.hits.replace('{0}', s.points.length) + ' · <b>' + esc(last.v.error ? 'error' : last.v.value) + '</b>' +
    (pts.length ? ' · min ' + Math.min(...pts.map((p) => p.y)) + ' · max ' + Math.max(...pts.map((p) => p.y)) : '');
  container.appendChild(stat);
  if (pts.length === 0) { const n = document.createElement('div'); n.className = 'note'; n.textContent = T.notNumeric; container.appendChild(n); return; }

  const wrap = document.createElement('div'); wrap.className = 'chart';
  const svg = el('svg', { height: H, role: 'img', 'aria-label': s.key });
  const tip = document.createElement('div'); tip.className = 'tooltip';
  wrap.appendChild(svg); wrap.appendChild(tip); container.appendChild(wrap);
  const W = svg.clientWidth || container.clientWidth, w = W - M.left - M.right, h = H - M.top - M.bottom;
  const n0 = s.points[0].n, n1 = Math.max(s.points[s.points.length - 1].n, n0 + 1);
  let lo = Math.min(...pts.map((p) => p.y)), hi = Math.max(...pts.map((p) => p.y));
  if (lo > 0 && lo < hi * 0.5) lo = 0; // anchor at zero unless the values sit in a narrow band far from it
  if (hi === lo) { hi += 1; lo -= lo === 0 ? 0 : 1; }
  const step = niceStep(hi - lo), yLo = Math.floor(lo / step) * step, yHi = Math.ceil(hi / step) * step;
  const x = (n) => M.left + ((n - n0) / (n1 - n0)) * w;
  const y = (v) => M.top + h - ((v - yLo) / (yHi - yLo)) * h;
  const grid = el('g', { class: 'grid' }), axis = el('g', { class: 'axis' });
  for (let v = yLo; v <= yHi + step * 1e-9; v += step) {
    grid.appendChild(el('line', { x1: M.left, x2: M.left + w, y1: y(v), y2: y(v) }));
    const t = el('text', { x: M.left - 8, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = +v.toPrecision(6); axis.appendChild(t);
  }
  const ticks = Math.min(5, n1 - n0);
  for (let i = 0; i <= ticks; i++) {
    const nn = Math.round(n0 + ((n1 - n0) * i) / ticks);
    const t = el('text', { x: x(nn), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }); t.textContent = '#' + nn; axis.appendChild(t);
  }
  svg.appendChild(grid); svg.appendChild(axis);
  svg.appendChild(el('path', { class: 'line', d: pts.map((p, i) => (i ? 'L' : 'M') + x(p.n).toFixed(1) + ' ' + y(p.y).toFixed(1)).join(' ') }));
  if (pts.length <= 25) for (const p of pts) svg.appendChild(el('circle', { class: 'marker', r: 4, cx: x(p.n), cy: y(p.y) }));

  const cross = el('line', { class: 'crosshair', y1: M.top, y2: M.top + h, visibility: 'hidden' });
  const dot = el('circle', { class: 'marker', r: 5, visibility: 'hidden' });
  svg.appendChild(cross); svg.appendChild(dot);
  const hit = el('rect', { x: M.left, y: M.top, width: w, height: h, fill: 'transparent' });
  svg.appendChild(hit);
  hit.addEventListener('mousemove', (ev) => {
    const n = n0 + ((ev.clientX - svg.getBoundingClientRect().left - M.left) / w) * (n1 - n0);
    let p = pts[0];
    for (const q of pts) if (Math.abs(q.n - n) < Math.abs(p.n - n)) p = q;
    cross.setAttribute('x1', x(p.n)); cross.setAttribute('x2', x(p.n)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(p.n)); dot.setAttribute('cy', y(p.y)); dot.setAttribute('visibility', 'visible');
    tip.innerHTML = '<b>' + T.hit + ' #' + p.n + '</b><br>' + esc(s.expression) + ' = ' + esc(p.v.value);
    tip.style.display = 'block';
    tip.style.left = Math.min(x(p.n) + 12, W - tip.offsetWidth - 4) + 'px'; tip.style.top = M.top + 'px';
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
}

function update() {
  const charts = document.getElementById('charts');
  charts.innerHTML = '';
  const series = seriesList();
  document.getElementById('sub').style.display = hits.length ? 'none' : '';
  for (const s of series) drawChart(charts, s);
  const exprs = [...new Set(hits.flatMap((h) => h.values.map((v) => v.expression)))];
  const rows = hits.slice(-50).reverse().map((h) => '<tr><td>#' + h.n + '</td><td class="text">' + esc(h.location) + '</td>' +
    exprs.map((e) => { const v = h.values.find((x) => x.expression === e); return '<td class="text">' + (v ? esc(v.error ? 'error: ' + v.error : v.value) : '') + '</td>'; }).join('') + '</tr>');
  document.getElementById('table').innerHTML = '<tr><th>' + T.hit + '</th><th>' + T.location + '</th>' + exprs.map((e) => '<th>' + esc(e) + '</th>').join('') + '</tr>' + rows.join('');
}

window.addEventListener('message', (e) => { if (e.data.type === 'data') { hits = e.data.hits; update(); } });
window.addEventListener('resize', () => update());
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
