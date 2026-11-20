import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PROCESS_USAGE_REQUEST } from './dapProxy';
import { isEnabled } from './features';

interface Sample {
    /** ms since the session started */
    t: number;
    privateBytes: number;
    workingSet: number;
    /** CPU usage over the last interval, as % of all logical cores (like Task Manager); null for the first sample. */
    cpu: number | null;
    /** GDI / USER objects of the process (the per-process limit is 10,000 by default) and kernel handles. */
    gdi: number;
    user: number;
    handles: number;
    /** Reserved + committed 32-bit address space, and its largest free block; null when not a 32-bit process. */
    addressUsed: number | null;
    largestFree: number | null;
}

/** One reading of the process (from the engine or the helper), before the CPU usage is worked out. */
interface Reading {
    privateBytes: number;
    workingSet: number;
    /** CPU time since the process started. */
    cpuMs: number;
    gdi: number;
    user: number;
    handles: number;
    addressUsed: number | null;
    largestFree: number | null;
}

/** Facts about the process sent once by the sampler. */
interface ProcessInfo {
    /** A 32-bit process on 64-bit Windows: its address space is measured. */
    wow64: boolean;
    /** 2 GB, or 4 GB for a large-address-aware exe. */
    addressLimit: number;
    gdiQuota: number;
    userQuota: number;
}

interface SessionMemory {
    name: string;
    pid: number;
    startedAt: number;
    info?: ProcessInfo;
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
 * webview, like the process memory / CPU graphs of Visual Studio's Diagnostic Tools. It also draws what Visual Studio
 * does not: GDI / USER objects and handles (WinForms apps crash at 10,000 GDI objects), and how full the 32-bit
 * address space is (an x86 app runs out of it long before the machine runs out of memory).
 */
export class MemoryMonitor implements vscode.DebugAdapterTrackerFactory, vscode.Disposable {
    private current: SessionMemory | undefined;
    private sampler: cp.ChildProcess | undefined;
    /** Stops asking the engine for readings (when the engine reads the usage itself). */
    private stopPolling: (() => void) | undefined;
    private panel: vscode.WebviewPanel | undefined;

    constructor(private readonly extensionPath: string, private readonly output: vscode.OutputChannel) {}

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
        // Turned off: no sampler process for this session.
        if (!isEnabled('memoryGraph', session.workspaceFolder?.uri)) {
            return undefined;
        }
        // The bundled engine reads the usage itself (PROCESS_USAGE_REQUEST): no PowerShell helper then.
        let engineReads = false;
        return {
            onDidSendMessage: (m: { type?: string; event?: string; command?: string; body?: { systemProcessId?: number; dotnetX86SupportsProcessUsage?: boolean } }) => {
                if (m.type === 'response' && m.command === 'initialize') {
                    engineReads = m.body?.dotnetX86SupportsProcessUsage === true;
                }
                if (m.type !== 'event') {
                    return;
                }
                if (m.event === 'process' && m.body?.systemProcessId) {
                    this.start(session, m.body.systemProcessId, engineReads);
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

    private start(debugSession: vscode.DebugSession, pid: number, engineReads: boolean): void {
        this.stopSampler();
        this.current = { name: debugSession.name, pid, startedAt: Date.now(), samples: [], breaks: [], exited: false };
        if (vscode.workspace.getConfiguration('dotnetX86.memoryGraph').get<boolean>('autoOpen')) {
            this.show();
        }
        const record = this.recorder(this.current);
        if (engineReads) {
            this.pollEngine(debugSession, this.current, record);
        } else {
            this.startHelper(pid, this.current, record);
        }
    }

    /** Adds a reading to the session's samples (the CPU usage comes from the change of CPU time since the last one). */
    private recorder(session: SessionMemory): (reading: Reading) => void {
        const cores = Math.max(1, os.cpus().length);
        let previous: { wall: number; cpuMs: number } | undefined;
        return ({ privateBytes, workingSet, cpuMs, gdi, user, handles, addressUsed, largestFree }) => {
            const wall = Date.now();
            const cpu = previous && wall > previous.wall
                ? Math.min(100, Math.max(0, ((cpuMs - previous.cpuMs) / ((wall - previous.wall) * cores)) * 100))
                : null;
            previous = { wall, cpuMs };
            session.samples.push({ t: wall - session.startedAt, privateBytes, workingSet, cpu, gdi, user, handles, addressUsed, largestFree });
            if (session.samples.length > MAX_SAMPLES) {
                session.samples.shift();
            }
            this.post();
        };
    }

    /** The bundled engine reads the usage from the process it debugs: asked once per interval. */
    private pollEngine(debugSession: vscode.DebugSession, session: SessionMemory, record: (reading: Reading) => void): void {
        let asking = false;
        const timer = setInterval(() => {
            if (asking) {
                return; // the engine is busy (e.g. evaluating): skip a beat rather than queue requests
            }
            asking = true;
            debugSession.customRequest(PROCESS_USAGE_REQUEST).then(
                (u) => {
                    asking = false;
                    session.info ??= { wow64: u.wow64 === true, addressLimit: u.addressLimit ?? 0, gdiQuota: u.gdiQuota, userQuota: u.userQuota };
                    record({
                        privateBytes: u.privateBytes, workingSet: u.workingSet, cpuMs: u.cpuMs, gdi: u.gdiObjects, user: u.userObjects, handles: u.handles,
                        addressUsed: u.addressUsed ?? null, largestFree: u.largestFree ?? null,
                    });
                },
                () => {
                    // The process is gone (or the session ended).
                    asking = false;
                    clearInterval(timer);
                    session.exited = true;
                    this.post();
                },
            );
        }, SAMPLE_INTERVAL_MS);
        this.stopPolling = () => clearInterval(timer);
    }

    /** netcoredbg: a PowerShell helper samples the process (one long-running helper is cheaper than a process per sample). */
    private startHelper(pid: number, session: SessionMemory, record: (reading: Reading) => void): void {
        const script = path.join(this.extensionPath, 'resources', 'processSampler.ps1');
        const sampler = cp.spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid), '-IntervalMs', String(SAMPLE_INTERVAL_MS)],
            { windowsHide: true },
        );
        sampler.on('error', (e) => this.output.appendLine(`[memory] could not start PowerShell: ${e.message}`));
        let pending = '';
        sampler.stdout.on('data', (d: Buffer) => {
            pending += d.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
                const [kind, ...fields] = line.trim().split(' ');
                const n = fields.map(Number);
                if (kind === 'info' && n.length === 4 && n.every(Number.isFinite)) {
                    session.info = { wow64: n[0] === 1, addressLimit: n[1], gdiQuota: n[2], userQuota: n[3] };
                    continue;
                }
                if (kind !== 's' || n.length !== 8 || !n.every(Number.isFinite)) {
                    continue;
                }
                const [privateBytes, workingSet, cpuMs, gdi, user, handles, addressUsed, largestFree] = n;
                record({ privateBytes, workingSet, cpuMs, gdi, user, handles, addressUsed: addressUsed < 0 ? null : addressUsed, largestFree: largestFree < 0 ? null : largestFree });
            }
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
        this.stopPolling?.();
        this.stopPolling = undefined;
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
        title: vscode.l10n.t('Process memory, CPU and handles'),
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
        gdiNow: vscode.l10n.t('GDI objects (now)'),
        userNow: vscode.l10n.t('USER objects (now)'),
        handlesNow: vscode.l10n.t('Handles (now)'),
        objectsChart: vscode.l10n.t('GDI / USER objects'),
        handlesChart: vscode.l10n.t('Handles'),
        gdiObjects: vscode.l10n.t('GDI objects'),
        userObjects: vscode.l10n.t('USER objects'),
        quota: vscode.l10n.t('limit {0}'),
        addressNow: vscode.l10n.t('Address space used (now)'),
        largestFreeNow: vscode.l10n.t('Largest free block (now)'),
        addressChart: vscode.l10n.t('32-bit address space (reserved + committed)'),
        addressUsed: vscode.l10n.t('Used'),
        largestFree: vscode.l10n.t('Largest free block'),
        addressLimit: vscode.l10n.t('Limit {0}'),
        largeAddressAware: vscode.l10n.t('large address aware'),
        warnGdi: vscode.l10n.t('GDI objects are at {0} % of the per-process limit ({1}). Past it, drawing fails and the app usually crashes: look for Font / Brush / Pen / Bitmap / Icon objects that are not disposed.'),
        warnUser: vscode.l10n.t('USER objects are at {0} % of the per-process limit ({1}). Past it, windows and menus cannot be created: look for forms and controls that are not disposed.'),
        warnAddress: vscode.l10n.t('The 32-bit address space is {0} % full, and its largest free block is {1}. Large allocations will fail with OutOfMemoryException even with free memory on the machine.'),
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
  :root { --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100; --series-5: #e87ba4; --series-6: #008300; --series-7: #6250d6; --warning: #fab219; }
  body.vscode-dark, body.vscode-high-contrast { --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500; --series-5: #d55181; --series-6: #0ca30c; --series-7: #9085e9; }
  /* Each measure keeps its own slot across the charts (slots 4 and 5 are also below 3:1 on light: end labels, tiles and the table carry them). */
  .limit { stroke: var(--vscode-descriptionForeground); stroke-dasharray: 4 3; stroke-width: 1px; }
  .limit-label { font-size: 11px; fill: var(--vscode-descriptionForeground); }
  .warning { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0; padding: 6px 8px; border-radius: 4px;
             border: 1px solid var(--warning); }
  .warning .icon { color: var(--warning); font-weight: 700; }
  body:not(.wow64) .address { display: none; }
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
<div class="tiles">
  <div class="tile"><div class="label">${escapeHtml(t.gdiNow)}</div><div class="value" id="gdiNow">-</div></div>
  <div class="tile"><div class="label">${escapeHtml(t.userNow)}</div><div class="value" id="userNow">-</div></div>
  <div class="tile"><div class="label">${escapeHtml(t.handlesNow)}</div><div class="value" id="handlesNow">-</div></div>
  <div class="tile address"><div class="label">${escapeHtml(t.addressNow)}</div><div class="value" id="addrNow">-</div></div>
  <div class="tile address"><div class="label">${escapeHtml(t.largestFreeNow)}</div><div class="value" id="freeNow">-</div></div>
</div>
<div id="warnings"></div>
<h2>${escapeHtml(t.memoryChart)}</h2>
<div class="legend">
  <span><span class="swatch" style="background: var(--series-1)"></span>Private Bytes</span>
  <span><span class="swatch" style="background: var(--series-2)"></span>Working Set</span>
  <span><span class="band-swatch"></span>${escapeHtml(t.stoppedLegend)}</span>
</div>
<div class="chart"><svg id="memSvg" height="220" role="img" aria-label="${escapeHtml(t.memoryChart)}"></svg><div class="tooltip" id="memTip"></div></div>
<h2>${escapeHtml(t.cpuChart)}</h2>
<div class="chart"><svg id="cpuSvg" height="160" role="img" aria-label="${escapeHtml(t.cpuChart)}"></svg><div class="tooltip" id="cpuTip"></div></div>
<h2>${escapeHtml(t.objectsChart)}</h2>
<div class="legend">
  <span><span class="swatch" style="background: var(--series-4)"></span>${escapeHtml(t.gdiObjects)}</span>
  <span><span class="swatch" style="background: var(--series-5)"></span>${escapeHtml(t.userObjects)}</span>
  <span><span class="band-swatch"></span>${escapeHtml(t.stoppedLegend)}</span>
</div>
<div class="chart"><svg id="objSvg" height="160" role="img" aria-label="${escapeHtml(t.objectsChart)}"></svg><div class="tooltip" id="objTip"></div></div>
<h2>${escapeHtml(t.handlesChart)}</h2>
<div class="chart"><svg id="handleSvg" height="140" role="img" aria-label="${escapeHtml(t.handlesChart)}"></svg><div class="tooltip" id="handleTip"></div></div>
<section class="address">
<h2>${escapeHtml(t.addressChart)} <span class="sub" id="addrSub"></span></h2>
<div class="chart"><svg id="addrSvg" height="180" role="img" aria-label="${escapeHtml(t.addressChart)}"></svg><div class="tooltip" id="addrTip"></div></div>
</section>
<details><summary>${escapeHtml(t.tableSummary)}</summary><table id="table"></table></details>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const T = ${JSON.stringify(t).replace(/</g, '\\u003c')};
let state;
const MB = 1024 * 1024, GB = 1024 * MB;
const fmtMB = (b) => (b == null ? '-' : (b / MB).toFixed(1) + ' MB');
const fmtGB = (b) => +(b / GB).toFixed(2) + ' GB';
const fmtCount = (v) => (v == null ? '-' : Number(v).toLocaleString());
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
  {
    // The 10,000 limit flattens the lines while far from it: it joins the scale only from half of it on.
    svg: document.getElementById('objSvg'), tip: document.getElementById('objTip'), unit: fmtCount, fmt: fmtCount, scale: 1, minMax: 10,
    limit: () => state.session.info && { value: state.session.info.gdiQuota, label: T.quota.replace('{0}', fmtCount(state.session.info.gdiQuota)) },
    series: [
      { key: 'gdi', name: T.gdiObjects, color: 'var(--series-4)' },
      { key: 'user', name: T.userObjects, color: 'var(--series-5)' },
    ],
  },
  {
    svg: document.getElementById('handleSvg'), tip: document.getElementById('handleTip'), unit: fmtCount, fmt: fmtCount, scale: 1, minMax: 10,
    series: [{ key: 'handles', name: T.handlesChart, color: 'var(--series-6)' }],
  },
  {
    // Always drawn up to the limit: how much room is left is the point of this chart.
    svg: document.getElementById('addrSvg'), tip: document.getElementById('addrTip'), unit: (v) => v + ' GB', fmt: fmtMB, scale: GB, minMax: 0.5,
    limit: () => state.session.info && { value: state.session.info.addressLimit, label: T.addressLimit.replace('{0}', fmtGB(state.session.info.addressLimit)), always: true },
    tipExtra: (p) => p.largestFree == null ? '' : '<br>' + T.largestFree + ': ' + fmtMB(p.largestFree),
    series: [{ key: 'addressUsed', name: T.addressUsed, color: 'var(--series-7)' }],
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
  let rawMax = Math.max(c.minMax, ...values.map((v) => v / c.scale));
  let limit = c.limit ? c.limit() : null;
  if (limit && (limit.always || rawMax >= (limit.value / c.scale) * 0.5)) rawMax = Math.max(rawMax, limit.value / c.scale);
  else limit = null;
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
  if (limit) {
    svg.appendChild(el('line', { class: 'limit', x1: M.left, x2: M.left + w, y1: y(limit.value), y2: y(limit.value) }));
    // Under the line at the right: above it would collide with the top tick label and the heading.
    const t = el('text', { class: 'limit-label', x: M.left + w - 4, y: y(limit.value) + 13, 'text-anchor': 'end' }); t.textContent = limit.label; svg.appendChild(t);
  }

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
      c.series.map((s) => '<br>' + s.name + ': ' + c.fmt(p[s.key])).join('') + (c.tipExtra ? c.tipExtra(p) : '');
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
  const info = s.info, wow64 = !!(info && info.wow64);
  document.body.classList.toggle('wow64', wow64);
  document.getElementById('gdiNow').textContent = last ? fmtCount(last.gdi) : '-';
  document.getElementById('userNow').textContent = last ? fmtCount(last.user) : '-';
  document.getElementById('handlesNow').textContent = last ? fmtCount(last.handles) : '-';
  document.getElementById('addrNow').textContent = last && wow64 ? fmtMB(last.addressUsed) : '-';
  document.getElementById('freeNow').textContent = last && wow64 ? fmtMB(last.largestFree) : '-';
  if (wow64) document.getElementById('addrSub').textContent = '(' + T.addressLimit.replace('{0}', fmtGB(info.addressLimit)) + (info.addressLimit > 2 * GB ? ', ' + T.largeAddressAware : '') + ')';
  showWarnings(last, info);
  const rows = samples.slice(-30).reverse().map((p) => '<tr><td>' + fmtTime(p.t) + '</td><td>' + fmtMB(p.privateBytes) + '</td><td>' + fmtMB(p.workingSet) + '</td><td>' + fmtPct(p.cpu) +
    '</td><td>' + fmtCount(p.gdi) + '</td><td>' + fmtCount(p.user) + '</td><td>' + fmtCount(p.handles) + '</td>' +
    (wow64 ? '<td>' + fmtMB(p.addressUsed) + '</td><td>' + fmtMB(p.largestFree) + '</td>' : '') + '</tr>');
  document.getElementById('table').innerHTML = '<tr><th>' + T.time + '</th><th>Private Bytes</th><th>Working Set</th><th>CPU</th><th>GDI</th><th>USER</th><th>' + T.handlesChart + '</th>' +
    (wow64 ? '<th>' + T.addressUsed + '</th><th>' + T.largestFree + '</th>' : '') + '</tr>' + rows.join('');
  draw();
}

// Status, not identity: an icon and a sentence, with the reserved warning color only on the icon and border.
function showWarnings(last, info) {
  const list = [];
  if (last && info) {
    const pct = (v, of) => Math.round((v / of) * 100);
    if (last.gdi >= info.gdiQuota * 0.8) list.push(T.warnGdi.replace('{0}', pct(last.gdi, info.gdiQuota)).replace('{1}', fmtCount(info.gdiQuota)));
    if (last.user >= info.userQuota * 0.8) list.push(T.warnUser.replace('{0}', pct(last.user, info.userQuota)).replace('{1}', fmtCount(info.userQuota)));
    if (info.wow64 && last.addressUsed != null && (last.addressUsed >= info.addressLimit * 0.85 || last.largestFree < 128 * MB)) {
      list.push(T.warnAddress.replace('{0}', pct(last.addressUsed, info.addressLimit)).replace('{1}', fmtMB(last.largestFree)));
    }
  }
  const box = document.getElementById('warnings');
  box.innerHTML = '';
  for (const text of list) {
    const row = document.createElement('div'); row.className = 'warning'; row.setAttribute('role', 'status');
    const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = '\\u26a0';
    const msg = document.createElement('span'); msg.textContent = text;
    row.append(icon, msg); box.appendChild(row);
  }
}

window.addEventListener('message', (e) => { if (e.data.type === 'data') { state = e.data; update(); } });
window.addEventListener('resize', () => draw());
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
