import * as cp from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';

interface Sample {
    /** ms since the session started */
    t: number;
    privateBytes: number;
    workingSet: number;
    /** CPU usage over the last interval, as % of all logical cores (like Task Manager); null for the first sample. */
    cpu: number | null;
}

interface SessionMemory {
    name: string;
    pid: number;
    startedAt: number;
    samples: Sample[];
    /** Periods the debuggee was stopped at a breakpoint / step (end undefined while still stopped). */
    breaks: { start: number; end?: number }[];
    exited: boolean;
}

/** One hour at one sample per second. */
const MAX_SAMPLES = 3600;
const SAMPLE_INTERVAL_MS = 1000;

/**
 * Samples the debuggee's memory (Private Bytes / Working Set) and CPU usage while debugging and draws them in a
 * webview, like the process memory / CPU graphs of Visual Studio's Diagnostic Tools.
 */
export class MemoryMonitor implements vscode.DebugAdapterTrackerFactory, vscode.Disposable {
    private current: SessionMemory | undefined;
    private sampler: cp.ChildProcess | undefined;
    private panel: vscode.WebviewPanel | undefined;

    constructor(private readonly output: vscode.OutputChannel) {}

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
        return {
            onDidSendMessage: (m: { type?: string; event?: string; body?: { systemProcessId?: number } }) => {
                if (m.type !== 'event') {
                    return;
                }
                if (m.event === 'process' && m.body?.systemProcessId) {
                    this.start(session.name, m.body.systemProcessId);
                } else if (m.event === 'stopped') {
                    this.markStopped();
                } else if (m.event === 'continued') {
                    this.markContinued();
                }
            },
            onExit: () => this.stopSampler(),
        };
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'dotnetX86.memory',
            vscode.l10n.t('Memory / CPU (.NET x86)'),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = renderHtml(localizedStrings());
        this.panel.onDidDispose(() => (this.panel = undefined));
        this.panel.webview.onDidReceiveMessage((m) => m?.type === 'ready' && this.post());
    }

    dispose(): void {
        this.stopSampler();
        this.panel?.dispose();
    }

    private start(name: string, pid: number): void {
        this.stopSampler();
        this.current = { name, pid, startedAt: Date.now(), samples: [], breaks: [], exited: false };
        if (vscode.workspace.getConfiguration('dotnetX86.memoryGraph').get<boolean>('autoOpen')) {
            this.show();
        }

        // One long-running PowerShell is much cheaper than spawning a process per sample.
        const script =
            `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
            `while (-not $p.HasExited) { $p.Refresh(); ` +
            `[Console]::Out.WriteLine(('{0},{1},{2}' -f $p.PrivateMemorySize64, $p.WorkingSet64, [int64]$p.TotalProcessorTime.TotalMilliseconds)); ` +
            `[Console]::Out.Flush(); Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS} }`;
        const sampler = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        const session = this.current;
        const cores = Math.max(1, os.cpus().length);
        let previous: { wall: number; cpuMs: number } | undefined;
        let pending = '';
        sampler.stdout.on('data', (d: Buffer) => {
            pending += d.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
                const [privateBytes, workingSet, cpuMs] = line.split(',').map(Number);
                if (!Number.isFinite(privateBytes) || !Number.isFinite(workingSet) || !Number.isFinite(cpuMs)) {
                    continue;
                }
                const wall = Date.now();
                const cpu = previous && wall > previous.wall
                    ? Math.min(100, Math.max(0, ((cpuMs - previous.cpuMs) / ((wall - previous.wall) * cores)) * 100))
                    : null;
                previous = { wall, cpuMs };
                session.samples.push({ t: wall - session.startedAt, privateBytes, workingSet, cpu });
                if (session.samples.length > MAX_SAMPLES) {
                    session.samples.shift();
                }
            }
            this.post();
        });
        sampler.stderr.on('data', (d: Buffer) => this.output.appendLine(`[memory] ${d.toString().trimEnd()}`));
        sampler.on('exit', () => {
            session.exited = true;
            this.post();
        });
        this.sampler = sampler;
    }

    private markStopped(): void {
        const s = this.current;
        if (s && (s.breaks.length === 0 || s.breaks[s.breaks.length - 1].end !== undefined)) {
            s.breaks.push({ start: Date.now() - s.startedAt });
            this.post();
        }
    }

    private markContinued(): void {
        const last = this.current?.breaks[this.current.breaks.length - 1];
        if (this.current && last && last.end === undefined) {
            last.end = Date.now() - this.current.startedAt;
            this.post();
        }
    }

    private stopSampler(): void {
        this.markContinued();
        this.sampler?.kill();
        this.sampler = undefined;
    }

    private post(): void {
        if (this.panel && this.current) {
            void this.panel.webview.postMessage({ type: 'data', session: this.current, now: Date.now() - this.current.startedAt });
        }
    }
}

/** Webview texts, localized in the extension host (the webview has no access to vscode.l10n). */
function localizedStrings() {
    return {
        title: vscode.l10n.t('Process memory and CPU'),
        waiting: vscode.l10n.t('Start debugging with the dotnet-x86 debugger to see memory.'),
        privateNow: vscode.l10n.t('Private Bytes (now)'),
        privatePeak: vscode.l10n.t('Private Bytes (peak)'),
        workingSetNow: vscode.l10n.t('Working Set (now)'),
        cpuNow: vscode.l10n.t('CPU (now)'),
        cpuPeak: vscode.l10n.t('CPU (peak)'),
        memoryChart: vscode.l10n.t('Memory'),
        cpuChart: vscode.l10n.t('CPU usage (% of all cores)'),
        stoppedLegend: vscode.l10n.t('Stopped (break / step)'),
        tableSummary: vscode.l10n.t('Data table (last 30 samples)'),
        time: vscode.l10n.t('Elapsed'),
        exited: vscode.l10n.t('process exited'),
        stopped: vscode.l10n.t('stopped'),
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
  /* Series colors validated (dataviz validate_palette.js) against #ffffff / #1f1f1f surfaces.
     --series-3 is below 3:1 on light, so the CPU chart is backed by its title, value tiles and the data table. */
  :root { --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; }
  body.vscode-dark, body.vscode-high-contrast { --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
  h1 { font-size: 1.1em; font-weight: 600; margin: 0 0 2px; }
  h2 { font-size: 1em; font-weight: 600; margin: 16px 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  .tiles { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .tile .label { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .tile .value { font-size: 1.4em; font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin: 4px 0 8px; color: var(--vscode-foreground); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 14px; height: 2px; border-radius: 1px; }
  .band-swatch { width: 14px; height: 10px; background: var(--vscode-descriptionForeground); opacity: 0.18; border-radius: 2px; }
  .chart { position: relative; }
  svg { display: block; width: 100%; overflow: visible; }
  .grid line { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.18; }
  .axis text { fill: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
  .band { fill: var(--vscode-descriptionForeground); fill-opacity: 0.12; }
  .line { fill: none; stroke-width: 2px; stroke-linejoin: round; stroke-linecap: round; }
  .end-label { font-size: 11px; fill: var(--vscode-foreground); }
  .crosshair { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.5; }
  .dot { stroke: var(--vscode-editor-background); stroke-width: 2px; }
  .tooltip { position: absolute; pointer-events: none; display: none; background: var(--vscode-editorHoverWidget-background);
             color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border);
             padding: 6px 8px; border-radius: 4px; font-variant-numeric: tabular-nums; white-space: nowrap; z-index: 1; }
  details { margin-top: 12px; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  td, th { padding: 2px 12px 2px 0; text-align: right; }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; }
</style>
</head>
<body>
<h1>${escapeHtml(t.title)}</h1>
<div class="sub" id="sub">${escapeHtml(t.waiting)}</div>
<div class="tiles">
  <div class="tile"><div class="label">${escapeHtml(t.privateNow)}</div><div class="value" id="privNow">-</div></div>
  <div class="tile"><div class="label">${escapeHtml(t.privatePeak)}</div><div class="value" id="privPeak">-</div></div>
  <div class="tile"><div class="label">${escapeHtml(t.workingSetNow)}</div><div class="value" id="wsNow">-</div></div>
  <div class="tile"><div class="label">${escapeHtml(t.cpuNow)}</div><div class="value" id="cpuNow">-</div></div>
  <div class="tile"><div class="label">${escapeHtml(t.cpuPeak)}</div><div class="value" id="cpuPeak">-</div></div>
</div>
<h2>${escapeHtml(t.memoryChart)}</h2>
<div class="legend">
  <span><span class="swatch" style="background: var(--series-1)"></span>Private Bytes</span>
  <span><span class="swatch" style="background: var(--series-2)"></span>Working Set</span>
  <span><span class="band-swatch"></span>${escapeHtml(t.stoppedLegend)}</span>
</div>
<div class="chart"><svg id="memSvg" height="220" role="img" aria-label="${escapeHtml(t.memoryChart)}"></svg><div class="tooltip" id="memTip"></div></div>
<h2>${escapeHtml(t.cpuChart)}</h2>
<div class="chart"><svg id="cpuSvg" height="160" role="img" aria-label="${escapeHtml(t.cpuChart)}"></svg><div class="tooltip" id="cpuTip"></div></div>
<details><summary>${escapeHtml(t.tableSummary)}</summary><table id="table"></table></details>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const T = ${JSON.stringify(t).replace(/</g, '\\u003c')};
let state;
const MB = 1024 * 1024;
const fmtMB = (b) => (b / MB).toFixed(1) + ' MB';
const fmtPct = (v) => (v == null ? '-' : v.toFixed(1) + ' %');
const fmtTime = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const el = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const M = { top: 8, right: 96, bottom: 24, left: 56 };

const charts = [
  {
    svg: document.getElementById('memSvg'), tip: document.getElementById('memTip'), unit: (v) => v + ' MB', fmt: fmtMB, scale: MB, minMax: 1,
    series: [
      { key: 'privateBytes', name: 'Private Bytes', color: 'var(--series-1)' },
      { key: 'workingSet', name: 'Working Set', color: 'var(--series-2)' },
    ],
  },
  {
    // A single series: the chart title names it, so it has no legend; the y axis grows from 0-10 % up to 100 %.
    svg: document.getElementById('cpuSvg'), tip: document.getElementById('cpuTip'), unit: (v) => v + ' %', fmt: fmtPct, scale: 1, minMax: 10, maxMax: 100,
    series: [{ key: 'cpu', name: 'CPU', color: 'var(--series-3)' }],
  },
];

function niceStep(max) {
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function drawChart(c) {
  const svg = c.svg;
  svg.innerHTML = '';
  const { samples, breaks } = state.session;
  const H = Number(svg.getAttribute('height')), W = svg.clientWidth, w = W - M.left - M.right, h = H - M.top - M.bottom;
  const t0 = samples[0].t, t1 = Math.max(samples[samples.length - 1].t, t0 + 1);
  const values = samples.flatMap((p) => c.series.map((s) => p[s.key])).filter((v) => v != null);
  const rawMax = Math.max(c.minMax, ...values.map((v) => v / c.scale));
  const step = niceStep(rawMax), yMax = Math.min(c.maxMax ?? Infinity, Math.ceil(rawMax / step) * step);
  const x = (t) => M.left + ((t - t0) / (t1 - t0)) * w;
  const y = (v) => M.top + h - (v / c.scale / yMax) * h;

  for (const b of breaks) {
    const s = Math.max(b.start, t0), e = Math.min(b.end ?? state.now, t1);
    if (e > s) svg.appendChild(el('rect', { class: 'band', x: x(s), y: M.top, width: Math.max(1, x(e) - x(s)), height: h }));
  }
  const grid = el('g', { class: 'grid' }), axis = el('g', { class: 'axis' });
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    grid.appendChild(el('line', { x1: M.left, x2: M.left + w, y1: y(v * c.scale), y2: y(v * c.scale) }));
    const t = el('text', { x: M.left - 8, y: y(v * c.scale) + 4, 'text-anchor': 'end' }); t.textContent = c.unit(+v.toFixed(2)); axis.appendChild(t);
  }
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const tt = t0 + ((t1 - t0) * i) / ticks;
    const t = el('text', { x: x(tt), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }); t.textContent = fmtTime(tt); axis.appendChild(t);
  }
  svg.appendChild(grid); svg.appendChild(axis);

  const ends = [];
  for (const s of c.series) {
    const pts = samples.filter((p) => p[s.key] != null);
    if (pts.length === 0) continue;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p[s.key]).toFixed(1)).join(' ');
    svg.appendChild(el('path', { class: 'line', d, stroke: s.color }));
    ends.push({ s, y: y(pts[pts.length - 1][s.key]) });
  }
  // Direct labels at the line ends, nudged apart so they never overlap.
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) {
    const t = el('text', { class: 'end-label', x: M.left + w + 8, y: e.y + 4 }); t.textContent = e.s.name; svg.appendChild(t);
  }

  const hover = el('g', { visibility: 'hidden' });
  const cross = el('line', { class: 'crosshair', y1: M.top, y2: M.top + h });
  hover.appendChild(cross);
  const dots = c.series.map((s) => { const d = el('circle', { class: 'dot', r: 4, fill: s.color }); hover.appendChild(d); return d; });
  svg.appendChild(hover);
  const hit = el('rect', { x: M.left, y: M.top, width: w, height: h, fill: 'transparent' });
  svg.appendChild(hit);
  hit.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const t = t0 + ((ev.clientX - rect.left - M.left) / w) * (t1 - t0);
    let p = samples[0];
    for (const s of samples) if (Math.abs(s.t - t) < Math.abs(p.t - t)) p = s;
    cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t));
    c.series.forEach((s, i) => {
      dots[i].setAttribute('visibility', p[s.key] == null ? 'hidden' : 'visible');
      if (p[s.key] != null) { dots[i].setAttribute('cx', x(p.t)); dots[i].setAttribute('cy', y(p[s.key])); }
    });
    hover.setAttribute('visibility', 'visible');
    const stopped = breaks.some((b) => p.t >= b.start && p.t <= (b.end ?? state.now));
    c.tip.innerHTML = '<b>' + fmtTime(p.t) + '</b>' + (stopped ? ' (' + T.stopped + ')' : '') +
      c.series.map((s) => '<br>' + s.name + ': ' + c.fmt(p[s.key])).join('');
    c.tip.style.display = 'block';
    c.tip.style.left = Math.min(x(p.t) + 12, W - c.tip.offsetWidth - 4) + 'px'; c.tip.style.top = M.top + 'px';
  });
  hit.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); c.tip.style.display = 'none'; });
}

function draw() {
  if (!state || state.session.samples.length < 2) return;
  for (const c of charts) drawChart(c);
}

function update() {
  const s = state.session, samples = s.samples, last = samples[samples.length - 1];
  const cpuValues = samples.map((p) => p.cpu).filter((v) => v != null);
  document.getElementById('sub').textContent = s.name + ' (PID ' + s.pid + ')' + (s.exited ? ' - ' + T.exited : '');
  document.getElementById('privNow').textContent = last ? fmtMB(last.privateBytes) : '-';
  document.getElementById('privPeak').textContent = samples.length ? fmtMB(Math.max(...samples.map((p) => p.privateBytes))) : '-';
  document.getElementById('wsNow').textContent = last ? fmtMB(last.workingSet) : '-';
  document.getElementById('cpuNow').textContent = last ? fmtPct(last.cpu) : '-';
  document.getElementById('cpuPeak').textContent = cpuValues.length ? fmtPct(Math.max(...cpuValues)) : '-';
  const rows = samples.slice(-30).reverse().map((p) => '<tr><td>' + fmtTime(p.t) + '</td><td>' + fmtMB(p.privateBytes) + '</td><td>' + fmtMB(p.workingSet) + '</td><td>' + fmtPct(p.cpu) + '</td></tr>');
  document.getElementById('table').innerHTML = '<tr><th>' + T.time + '</th><th>Private Bytes</th><th>Working Set</th><th>CPU</th></tr>' + rows.join('');
  draw();
}

window.addEventListener('message', (e) => { if (e.data.type === 'data') { state = e.data; update(); } });
window.addEventListener('resize', () => draw());
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
