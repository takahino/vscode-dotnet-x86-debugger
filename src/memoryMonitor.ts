import * as cp from 'child_process';
import * as vscode from 'vscode';

interface Sample {
    /** ms since the session started */
    t: number;
    privateBytes: number;
    workingSet: number;
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
 * Samples the debuggee's Private Bytes / Working Set while debugging and draws them in a webview,
 * like the process memory graph of Visual Studio's Diagnostic Tools.
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
        this.panel = vscode.window.createWebviewPanel('dotnetX86.memory', 'Memory (.NET x86)', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        this.panel.webview.html = renderHtml();
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
            `while (-not $p.HasExited) { $p.Refresh(); [Console]::Out.WriteLine(('{0},{1}' -f $p.PrivateMemorySize64, $p.WorkingSet64)); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS} }`;
        const sampler = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        const session = this.current;
        let pending = '';
        sampler.stdout.on('data', (d: Buffer) => {
            pending += d.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
                const [privateBytes, workingSet] = line.split(',').map(Number);
                if (Number.isFinite(privateBytes) && Number.isFinite(workingSet)) {
                    session.samples.push({ t: Date.now() - session.startedAt, privateBytes, workingSet });
                    if (session.samples.length > MAX_SAMPLES) {
                        session.samples.shift();
                    }
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

function renderHtml(): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  /* Series colors validated (dataviz validate_palette.js) against #ffffff / #1f1f1f surfaces. */
  :root { --series-1: #2a78d6; --series-2: #eb6834; }
  body.vscode-dark, body.vscode-high-contrast { --series-1: #3987e5; --series-2: #d95926; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
  h1 { font-size: 1.1em; font-weight: 600; margin: 0 0 2px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  .tiles { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .tile .label { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .tile .value { font-size: 1.4em; font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin: 4px 0 8px; color: var(--vscode-foreground); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 14px; height: 2px; border-radius: 1px; }
  .band-swatch { width: 14px; height: 10px; background: var(--vscode-descriptionForeground); opacity: 0.18; border-radius: 2px; }
  #chart { position: relative; }
  svg { display: block; width: 100%; overflow: visible; }
  .grid line { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.18; }
  .axis text { fill: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
  .band { fill: var(--vscode-descriptionForeground); fill-opacity: 0.12; }
  .line { fill: none; stroke-width: 2px; stroke-linejoin: round; stroke-linecap: round; }
  .end-label { font-size: 11px; fill: var(--vscode-foreground); }
  .crosshair { stroke: var(--vscode-descriptionForeground); stroke-opacity: 0.5; }
  .dot { stroke: var(--vscode-editor-background); stroke-width: 2px; }
  #tooltip { position: absolute; pointer-events: none; display: none; background: var(--vscode-editorHoverWidget-background);
             color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border);
             padding: 6px 8px; border-radius: 4px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  details { margin-top: 12px; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  td, th { padding: 2px 12px 2px 0; text-align: right; }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
</style>
</head>
<body>
<h1>Process memory</h1>
<div class="sub" id="sub">Start debugging with the dotnet-x86 debugger to see memory.</div>
<div class="tiles">
  <div class="tile"><div class="label">Private Bytes (now)</div><div class="value" id="privNow">-</div></div>
  <div class="tile"><div class="label">Private Bytes (peak)</div><div class="value" id="privPeak">-</div></div>
  <div class="tile"><div class="label">Working Set (now)</div><div class="value" id="wsNow">-</div></div>
</div>
<div class="legend">
  <span><span class="swatch" style="background: var(--series-1)"></span>Private Bytes</span>
  <span><span class="swatch" style="background: var(--series-2)"></span>Working Set</span>
  <span><span class="band-swatch"></span>Stopped (break / step)</span>
</div>
<div id="chart"><svg id="svg" height="260" role="img" aria-label="Process memory over time"></svg><div id="tooltip"></div></div>
<details><summary>Data table (last 30 samples)</summary><table id="table"></table></details>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const svg = document.getElementById('svg');
const tooltip = document.getElementById('tooltip');
let state;
const MB = 1024 * 1024;
const fmtMB = (b) => (b / MB).toFixed(1) + ' MB';
const fmtTime = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const el = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const series = [
  { key: 'privateBytes', name: 'Private Bytes', color: 'var(--series-1)' },
  { key: 'workingSet', name: 'Working Set', color: 'var(--series-2)' },
];
const M = { top: 8, right: 96, bottom: 24, left: 56 };

function niceStep(max) {
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function draw() {
  svg.innerHTML = '';
  if (!state || state.session.samples.length < 2) {
    return;
  }
  const { samples, breaks } = state.session;
  const W = svg.clientWidth, H = 260, w = W - M.left - M.right, h = H - M.top - M.bottom;
  const t0 = samples[0].t, t1 = Math.max(samples[samples.length - 1].t, t0 + 1);
  const maxMB = Math.max(...samples.map((s) => Math.max(s.privateBytes, s.workingSet))) / MB;
  const step = niceStep(maxMB || 1), yMax = Math.ceil((maxMB || 1) / step) * step;
  const x = (t) => M.left + ((t - t0) / (t1 - t0)) * w;
  const y = (b) => M.top + h - (b / MB / yMax) * h;

  for (const b of breaks) {
    const s = Math.max(b.start, t0), e = Math.min(b.end ?? state.now, t1);
    if (e > s) svg.appendChild(el('rect', { class: 'band', x: x(s), y: M.top, width: Math.max(1, x(e) - x(s)), height: h }));
  }
  const grid = el('g', { class: 'grid' }), axis = el('g', { class: 'axis' });
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    grid.appendChild(el('line', { x1: M.left, x2: M.left + w, y1: y(v * MB), y2: y(v * MB) }));
    const t = el('text', { x: M.left - 8, y: y(v * MB) + 4, 'text-anchor': 'end' }); t.textContent = v + ' MB'; axis.appendChild(t);
  }
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const tt = t0 + ((t1 - t0) * i) / ticks;
    const t = el('text', { x: x(tt), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }); t.textContent = fmtTime(tt); axis.appendChild(t);
  }
  svg.appendChild(grid); svg.appendChild(axis);

  const last = samples[samples.length - 1];
  const ends = [];
  for (const s of series) {
    const d = samples.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p[s.key]).toFixed(1)).join(' ');
    svg.appendChild(el('path', { class: 'line', d, stroke: s.color }));
    ends.push({ s, y: y(last[s.key]) });
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
  const dots = series.map((s) => { const c = el('circle', { class: 'dot', r: 4, fill: s.color }); hover.appendChild(c); return c; });
  svg.appendChild(hover);
  const hit = el('rect', { x: M.left, y: M.top, width: w, height: h, fill: 'transparent' });
  svg.appendChild(hit);
  hit.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const t = t0 + ((ev.clientX - rect.left - M.left) / w) * (t1 - t0);
    let p = samples[0];
    for (const s of samples) if (Math.abs(s.t - t) < Math.abs(p.t - t)) p = s;
    cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t));
    series.forEach((s, i) => { dots[i].setAttribute('cx', x(p.t)); dots[i].setAttribute('cy', y(p[s.key])); });
    hover.setAttribute('visibility', 'visible');
    const stopped = breaks.some((b) => p.t >= b.start && p.t <= (b.end ?? state.now));
    tooltip.innerHTML = '<b>' + fmtTime(p.t) + '</b>' + (stopped ? ' (stopped)' : '') +
      '<br>Private Bytes: ' + fmtMB(p.privateBytes) + '<br>Working Set: ' + fmtMB(p.workingSet);
    tooltip.style.display = 'block';
    const left = Math.min(x(p.t) + 12, W - tooltip.offsetWidth - 4);
    tooltip.style.left = left + 'px'; tooltip.style.top = M.top + 'px';
  });
  hit.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); tooltip.style.display = 'none'; });
}

function update() {
  const s = state.session, samples = s.samples, last = samples[samples.length - 1];
  document.getElementById('sub').textContent = s.name + ' (PID ' + s.pid + ')' + (s.exited ? ' - process exited' : '');
  document.getElementById('privNow').textContent = last ? fmtMB(last.privateBytes) : '-';
  document.getElementById('privPeak').textContent = samples.length ? fmtMB(Math.max(...samples.map((p) => p.privateBytes))) : '-';
  document.getElementById('wsNow').textContent = last ? fmtMB(last.workingSet) : '-';
  const rows = samples.slice(-30).reverse().map((p) => '<tr><td>' + fmtTime(p.t) + '</td><td>' + fmtMB(p.privateBytes) + '</td><td>' + fmtMB(p.workingSet) + '</td></tr>');
  document.getElementById('table').innerHTML = '<tr><th>Time</th><th>Private Bytes</th><th>Working Set</th></tr>' + rows.join('');
  draw();
}

window.addEventListener('message', (e) => { if (e.data.type === 'data') { state = e.data; update(); } });
window.addEventListener('resize', () => state && draw());
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
