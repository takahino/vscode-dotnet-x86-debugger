import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { HEAP_STATS_REQUEST, HeapType, diffHeap, formatBytes, heapTotals } from './heapSnapshotCore';
import { HANDLE_STATS_REQUEST, ResourceType, diffResources, handleStatsArguments, withKinds } from './resourceLeakCore';

interface Snapshot {
    id: number;
    time: string;
    types: HeapType[];
    /** Objects holding native resources and how many are not disposed; undefined when netcoredbg cannot tell. */
    resources?: ResourceType[];
    /** Whether a garbage collection ran right before it. */
    collected: boolean;
}

/**
 * Heap Snapshots (as Visual Studio's Memory Usage): instance counts and sizes per type on the GC heap, taken while
 * the program is stopped, and the change between two snapshots. The table itself is sorted and filtered in the page.
 */
export class HeapSnapshots implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private snapshots: Snapshot[] = [];
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        // Snapshots belong to one run: a new session starts afresh.
        this.disposables.push(vscode.debug.onDidStartDebugSession((s) => {
            if (s.type === DEBUG_TYPE && !s.parentSession) {
                this.snapshots = [];
                this.render();
            }
        }));
    }

    show(): void {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('netdbg.heapSnapshots', vscode.l10n.t('Heap Snapshots (.NET x86)'), vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
            this.panel.onDidDispose(() => (this.panel = undefined));
            this.panel.webview.onDidReceiveMessage((m: { type?: string; collect?: boolean }) => {
                if (m.type === 'take') {
                    void this.take(m.collect);
                } else if (m.type === 'clear') {
                    this.snapshots = [];
                    this.render();
                }
            });
        }
        this.panel.reveal(undefined, true);
        this.render();
    }

    /** Takes a snapshot of the stopped program; `collect` overrides the netdbg.heapSnapshot.collectGarbage setting. */
    async take(collect?: boolean): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        const item = vscode.debug.activeStackItem as { threadId?: number; frameId?: number } | undefined;
        if (session?.type !== DEBUG_TYPE || item?.threadId === undefined) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Stop the program (a breakpoint or Pause) to take a heap snapshot.'));
            return;
        }
        this.show();
        collect ??= vscode.workspace.getConfiguration('netdbg').get<boolean>('heapSnapshot.collectGarbage', true);
        try {
            let collected = false;
            if (collect) {
                // Visual Studio also collects first, so that the snapshot holds only objects that are still reachable.
                const frameId = item.frameId ?? (await session.customRequest('stackTrace', { threadId: item.threadId, startFrame: 0, levels: 1 }))?.stackFrames?.[0]?.id;
                collected = frameId !== undefined && await session.customRequest('evaluate', { expression: 'System.GC.Collect()', frameId, context: 'repl' }).then(() => true, () => false);
                if (!collected) {
                    void vscode.window.showWarningMessage(vscode.l10n.t('Could not run a garbage collection first (the program must be stopped in managed code); the snapshot also holds unreachable objects.'));
                }
            }
            const types: HeapType[] = (await session.customRequest(HEAP_STATS_REQUEST, {}))?.types ?? [];
            // GDI leak candidates, from the same stop. Optional: the snapshot is still useful without them.
            const resources = await session.customRequest(HANDLE_STATS_REQUEST, handleStatsArguments())
                .then((r: { types?: ResourceType[] }) => withKinds(r?.types ?? []), () => undefined);
            this.snapshots.push({ id: (this.snapshots.at(-1)?.id ?? 0) + 1, time: new Date().toLocaleTimeString(), types, resources, collected });
            this.render();
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not take a heap snapshot: {0}', e instanceof Error ? e.message : String(e)));
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.panel?.dispose();
    }

    private render(): void {
        if (!this.panel) {
            return;
        }
        const list = this.snapshots.map((s) => {
            const totals = heapTotals(s.types);
            return { id: s.id, types: s.types, resources: s.resources, label: vscode.l10n.t('#{0} {1} — {2} objects, {3}{4}', s.id, s.time, totals.count.toLocaleString(), formatBytes(totals.size), s.collected ? '' : vscode.l10n.t(' (no GC)')) };
        });
        const t = {
            take: vscode.l10n.t('Take Heap Snapshot'),
            gc: vscode.l10n.t('Collect garbage first'),
            clear: vscode.l10n.t('Clear'),
            snapshot: vscode.l10n.t('Snapshot'),
            baseline: vscode.l10n.t('Compare with'),
            none: vscode.l10n.t('(none)'),
            filter: vscode.l10n.t('Filter types'),
            increases: vscode.l10n.t('Increases only'),
            type: vscode.l10n.t('Type'),
            count: vscode.l10n.t('Count'),
            countDelta: vscode.l10n.t('Δ Count'),
            size: vscode.l10n.t('Size'),
            sizeDelta: vscode.l10n.t('Δ Size'),
            added: vscode.l10n.t('new'),
            more: vscode.l10n.t('{0} more types; narrow down with the filter.'),
            empty: vscode.l10n.t('Stop the program and take a snapshot. Take another one later to see which types grew in between.'),
            resources: vscode.l10n.t('GDI leak candidates (native resources)'),
            resourcesHint: vscode.l10n.t('Objects that hold a GDI+ object, an icon, a cursor or a window. "Not disposed" still hold it: Dispose was not called (or the window is not destroyed). Take a snapshot, repeat an action a few times, take another: a count that keeps growing is a leak.'),
            kind: vscode.l10n.t('Kind'),
            instances: vscode.l10n.t('Instances'),
            notDisposed: vscode.l10n.t('Not disposed'),
            notDisposedDelta: vscode.l10n.t('Δ Not disposed'),
            candidate: vscode.l10n.t('leak candidate'),
            noResources: vscode.l10n.t('No objects holding native resources.'),
        };
        const collect = vscode.workspace.getConfiguration('netdbg').get<boolean>('heapSnapshot.collectGarbage', true);
        this.panel.webview.html = page({ snapshots: list, text: t, collect });
    }
}

/** The page renders the table itself (sorting, filtering and choosing the two snapshots need no round trip). */
function page(data: unknown): string {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    // Inside a script element "</script>" must not appear; JSON escapes are still valid JavaScript.
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 12px; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 8px; }
  .hint { color: var(--vscode-descriptionForeground); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 12px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  select, input[type=text] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; cursor: pointer; user-select: none; border-bottom: 1px solid var(--vscode-panel-border); padding: 3px 8px; white-space: nowrap; }
  td { padding: 2px 8px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.name { font-family: var(--vscode-editor-font-family); word-break: break-all; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .up { color: var(--vscode-charts-red, #e51400); }
  .down { color: var(--vscode-charts-green, #388a34); }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; margin-left: 6px; font-family: var(--vscode-font-family); }
  h2 { font-size: 13px; margin: 12px 0 4px; }
  #resources { margin-bottom: 14px; }
  #resources table { width: auto; min-width: 60%; }
  .warn::first-letter { color: var(--vscode-editorWarning-foreground); }
</style></head><body>
<div class="bar">
  <button id="take"></button>
  <label><input type="checkbox" id="gc"> <span id="gcLabel"></span></label>
  <button id="clear" class="secondary"></button>
</div>
<div class="bar" id="pickers">
  <label><span id="snapLabel"></span> <select id="snap"></select></label>
  <label><span id="baseLabel"></span> <select id="base"></select></label>
  <input type="text" id="filter">
  <label><input type="checkbox" id="increases"> <span id="incLabel"></span></label>
</div>
<div id="resources"></div>
<div id="content"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const data = ${json};
  const t = data.text;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // The unit-tested functions of heapSnapshotCore.ts, as compiled.
  const diff = ${diffHeap.toString()};
  const diffResources = ${diffResources.toString()};
  const bytes = ${formatBytes.toString()};
  const signed = (n, f) => n > 0 ? '+' + f(n) : n < 0 ? '-' + f(-n) : '';
  const MAX_ROWS = 500;
  // The view state survives re-rendering after each new snapshot.
  const state = Object.assign({ sort: 'sizeDelta', desc: true, filter: '', increases: false }, vscode.getState() || {});

  $('take').textContent = t.take; $('gcLabel').textContent = t.gc; $('clear').textContent = t.clear;
  $('snapLabel').textContent = t.snapshot; $('baseLabel').textContent = t.baseline;
  $('incLabel').textContent = t.increases; $('filter').placeholder = t.filter;
  $('gc').checked = data.collect; $('filter').value = state.filter; $('increases').checked = state.increases;
  $('take').onclick = () => vscode.postMessage({ type: 'take', collect: $('gc').checked });
  $('clear').onclick = () => vscode.postMessage({ type: 'clear' });

  const snaps = data.snapshots;
  if (!snaps.length) {
    $('pickers').style.display = 'none';
    $('content').innerHTML = '<p class="hint">' + esc(t.empty) + '</p>';
  } else {
    // The newest snapshot compared with the one before it, by default.
    $('snap').innerHTML = snaps.map((s, i) => '<option value="' + i + '">' + esc(s.label) + '</option>').join('');
    $('snap').value = String(snaps.length - 1);
    const fillBase = () => {
      const i = Number($('snap').value);
      $('base').innerHTML = '<option value="-1">' + esc(t.none) + '</option>' +
        snaps.map((s, j) => j === i ? '' : '<option value="' + j + '">' + esc(s.label) + '</option>').join('');
      $('base').value = String(i > 0 ? i - 1 : -1);
    };
    fillBase();
    $('snap').onchange = () => { fillBase(); draw(); };
    $('base').onchange = draw;
    $('filter').oninput = () => { state.filter = $('filter').value; draw(); };
    $('increases').onchange = () => { state.increases = $('increases').checked; draw(); };
    draw();
  }

  function draw() {
    vscode.setState(state);
    const snap = snaps[Number($('snap').value)];
    const baseIndex = Number($('base').value);
    const base = baseIndex >= 0 ? snaps[baseIndex] : undefined;
    drawResources(snap, base);
    const filter = state.filter.toLowerCase();
    let rows = diff(snap.types, base && base.types).filter((r) => (!filter || r.name.toLowerCase().includes(filter)) && (!state.increases || r.countDelta > 0 || r.sizeDelta > 0));
    const key = state.sort;
    rows.sort((a, b) => key === 'name' ? a.name.localeCompare(b.name) * (state.desc ? -1 : 1) : (b[key] - a[key]) * (state.desc ? 1 : -1));
    const more = rows.length - MAX_ROWS;
    rows = rows.slice(0, MAX_ROWS);
    const cols = [['name', t.type, ''], ['count', t.count, 'num'], ['countDelta', t.countDelta, 'num'], ['size', t.size, 'num'], ['sizeDelta', t.sizeDelta, 'num']];
    const head = cols.map(([k, label, cls]) => '<th class="' + cls + '" data-sort="' + k + '">' + esc(label) + (k === key ? (state.desc ? ' ▼' : ' ▲') : '') + '</th>').join('');
    const cls = (n) => n > 0 ? 'num up' : n < 0 ? 'num down' : 'num';
    const body = rows.map((r) => '<tr><td class="name">' + esc(r.name) + (r.added ? '<span class="badge">' + esc(t.added) + '</span>' : '') + '</td>' +
      '<td class="num">' + r.count.toLocaleString() + '</td><td class="' + cls(r.countDelta) + '">' + signed(r.countDelta, (n) => n.toLocaleString()) + '</td>' +
      '<td class="num">' + bytes(r.size) + '</td><td class="' + cls(r.sizeDelta) + '">' + signed(r.sizeDelta, bytes) + '</td></tr>').join('');
    $('content').innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>' +
      (more > 0 ? '<p class="hint">' + esc(t.more.replace('{0}', more.toLocaleString())) + '</p>' : '');
    document.querySelectorAll('th[data-sort]').forEach((th) => th.onclick = () => {
      const k = th.dataset.sort;
      state.desc = state.sort === k ? !state.desc : k !== 'name';
      state.sort = k;
      draw();
    });
  }

  // GDI leak candidates: a short table of its own, above all the types (the snapshot has none with an older netcoredbg).
  function drawResources(snap, base) {
    if (!snap.resources) { $('resources').innerHTML = ''; return; }
    const rows = diffResources(snap.resources, base && base.resources);
    const cls = (n) => n > 0 ? 'num up' : n < 0 ? 'num down' : 'num';
    const body = rows.map((r) => '<tr><td class="name">' + esc(r.name) + '</td><td>' + esc(r.kind || '?') + '</td>' +
      '<td class="num">' + r.count.toLocaleString() + '</td><td class="num">' + r.live.toLocaleString() + '</td>' +
      '<td class="' + cls(r.liveDelta) + '">' + signed(r.liveDelta, (n) => n.toLocaleString()) + '</td>' +
      '<td>' + (r.liveDelta > 0 ? '<span class="warn">⚠ ' + esc(t.candidate) + '</span>' : '') + '</td></tr>').join('');
    $('resources').innerHTML = '<h2>' + esc(t.resources) + '</h2><p class="hint">' + esc(t.resourcesHint) + '</p>' +
      (rows.length ? '<table><thead><tr><th>' + esc(t.type) + '</th><th>' + esc(t.kind) + '</th><th class="num">' + esc(t.instances) + '</th>' +
        '<th class="num">' + esc(t.notDisposed) + '</th><th class="num">' + esc(t.notDisposedDelta) + '</th><th></th></tr></thead><tbody>' + body + '</tbody></table>'
        : '<p class="hint">' + esc(t.noResources) + '</p>');
  }
</script></body></html>`;
}
