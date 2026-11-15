import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { FREEZE_THREAD_REQUEST } from './dapProxy';
import { StackNode, ThreadStack, buildStackGraph } from './parallelStacksCore';

/** Frames read per thread: deep enough for UI event chains and thread pools. */
const MAX_FRAMES = 60;

/**
 * Parallel Stacks (as in Visual Studio): the call stacks of all threads merged into boxes, with each thread's
 * Freeze / Thaw. Read while the program is stopped; the panel follows every stop.
 */
export class ParallelStacks implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    /** Frozen threads by debug session id (netcoredbg patch 0010). */
    private readonly frozen = new Map<string, Set<number>>();

    constructor() {
        this.disposables.push(
            vscode.debug.onDidChangeActiveStackItem(() => this.panel?.visible && void this.refresh()),
            vscode.debug.onDidTerminateDebugSession((s) => this.frozen.delete(s.id)),
        );
    }

    async show(): Promise<void> {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('dotnetX86.parallelStacks', vscode.l10n.t('Parallel Stacks (.NET x86)'), vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
            this.panel.onDidDispose(() => (this.panel = undefined));
            this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
        }
        this.panel.reveal(undefined, true);
        await this.refresh();
    }

    /** Freeze / Thaw from the Call Stack view (a thread item) or the panel. */
    async setFrozen(arg: { threadId?: number; sessionId?: string } | undefined, frozen: boolean): Promise<void> {
        const session = this.session(arg?.sessionId);
        const threadId = arg?.threadId ?? (vscode.debug.activeStackItem as { threadId?: number } | undefined)?.threadId;
        if (!session || threadId === undefined) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Stop the program and select a thread in the Call Stack view.'));
            return;
        }
        try {
            await session.customRequest(FREEZE_THREAD_REQUEST, { threadId, frozen });
            const set = this.frozen.get(session.id) ?? new Set<number>();
            if (frozen) {
                set.add(threadId);
            } else {
                set.delete(threadId);
            }
            this.frozen.set(session.id, set);
            await this.refresh();
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not change thread {0}: {1}', threadId, e instanceof Error ? e.message : String(e)));
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.panel?.dispose();
    }

    private session(id?: string): vscode.DebugSession | undefined {
        const s = id ? [vscode.debug.activeDebugSession].find((x) => x?.id === id) ?? vscode.debug.activeDebugSession : vscode.debug.activeDebugSession;
        return s?.type === DEBUG_TYPE ? s : undefined;
    }

    private async refresh(): Promise<void> {
        if (!this.panel) {
            return;
        }
        const session = this.session();
        const item = vscode.debug.activeStackItem;
        if (!session || !item) {
            this.panel.webview.html = page(this.panel.webview, `<p class="hint">${esc(vscode.l10n.t('Stop the program to see the stacks of its threads.'))}</p>`);
            return;
        }
        let threads: ThreadStack[];
        try {
            const list: { id: number; name: string }[] = (await session.customRequest('threads'))?.threads ?? [];
            threads = await Promise.all(list.map(async (t) => {
                const frames = await session.customRequest('stackTrace', { threadId: t.id, startFrame: 0, levels: MAX_FRAMES }).then((r) => r?.stackFrames ?? [], () => []);
                return { id: t.id, name: t.name, frames };
            }));
        } catch (e) {
            this.panel.webview.html = page(this.panel.webview, `<p class="hint">${esc(e instanceof Error ? e.message : String(e))}</p>`);
            return;
        }
        const frozen = this.frozen.get(session.id) ?? new Set<number>();
        const names = new Map(threads.map((t) => [t.id, t.name]));
        const graph = buildStackGraph(threads);
        const t = {
            threads: vscode.l10n.t('{0} threads'),
            thread: vscode.l10n.t('1 thread'),
            freeze: vscode.l10n.t('Freeze'),
            thaw: vscode.l10n.t('Thaw'),
            list: vscode.l10n.t('Threads'),
            refresh: vscode.l10n.t('Refresh'),
            hint: vscode.l10n.t('Callers are at the bottom; a box splits where the threads go different ways. Click a frame to open it. A frozen thread stays suspended when the program continues.'),
        };
        const box = (n: StackNode): string => {
            const label = n.threadIds.length === 1 ? t.thread : t.threads.replace('{0}', String(n.threadIds.length));
            const who = n.threadIds.map((id) => names.get(id) ?? `#${id}`).join(', ');
            const current = n.threadIds.includes((item as { threadId?: number }).threadId ?? -1) ? ' current' : '';
            // Innermost frame on top, as in Visual Studio.
            const frames = [...n.frames].reverse().map((f) => {
                const open = f.source?.path && f.line ? ` data-path="${esc(f.source.path)}" data-line="${f.line}"` : '';
                return `<div class="frame${open ? ' link' : ''}"${open} title="${esc(f.name)}">${esc(f.name)}</div>`;
            }).join('');
            const children = n.children.length ? `<div class="row">${n.children.map(box).join('')}</div>` : '';
            return `<div class="node">${children}<div class="box${current}"><div class="head" title="${esc(who)}">${esc(label)}</div>${frames}</div></div>`;
        };
        const rows = threads.map((th) => {
            const isFrozen = frozen.has(th.id);
            const top = th.frames.find((f) => f.source?.path) ?? th.frames[0];
            return `<tr><td>${th.id}</td><td>${esc(th.name)}</td><td class="mono">${esc(top?.name ?? '')}</td>` +
                `<td><button data-thread="${th.id}" data-frozen="${isFrozen ? 0 : 1}">${esc(isFrozen ? t.thaw : t.freeze)}</button></td></tr>`;
        }).join('');
        this.panel.webview.html = page(this.panel.webview,
            `<div class="bar"><button id="refresh">${esc(t.refresh)}</button><span class="hint">${esc(t.hint)}</span></div>` +
            `<div class="graph"><div class="row">${graph.map(box).join('')}</div></div>` +
            `<h3>${esc(t.list)}</h3><table>${rows}</table>`);
    }

    private async onMessage(m: { type?: string; path?: string; line?: number; threadId?: number; frozen?: boolean }): Promise<void> {
        if (m.type === 'open' && m.path && m.line) {
            const doc = await vscode.workspace.openTextDocument(m.path);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(m.line - 1, 0, m.line - 1, 0) });
        } else if (m.type === 'freeze' && m.threadId !== undefined) {
            await this.setFrozen({ threadId: m.threadId }, Boolean(m.frozen));
        } else if (m.type === 'refresh') {
            await this.refresh();
        }
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(_webview: vscode.Webview, body: string): string {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 12px; }
  .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .hint { color: var(--vscode-descriptionForeground); }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 10px; cursor: pointer; }
  .graph { overflow: auto; padding-bottom: 8px; }
  /* Callers at the bottom: each node puts its children above its own box. */
  .row { display: flex; gap: 12px; align-items: flex-end; }
  .node { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .box { border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editorWidget-background); min-width: 180px; max-width: 360px; }
  .box.current { border-color: var(--vscode-focusBorder); border-width: 2px; }
  .head { padding: 3px 8px; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background); }
  .frame { padding: 2px 8px; font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); }
  .frame.link { color: var(--vscode-foreground); cursor: pointer; }
  .frame.link:hover { background: var(--vscode-list-hoverBackground); }
  table { border-collapse: collapse; }
  td { padding: 2px 10px 2px 0; }
  .mono { font-family: var(--vscode-editor-font-family); }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; }
</style></head><body>${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-path], [data-thread], #refresh');
    if (!el) return;
    if (el.id === 'refresh') vscode.postMessage({ type: 'refresh' });
    else if (el.dataset.path) vscode.postMessage({ type: 'open', path: el.dataset.path, line: Number(el.dataset.line) });
    else vscode.postMessage({ type: 'freeze', threadId: Number(el.dataset.thread), frozen: el.dataset.frozen === '1' });
  });
</script></body></html>`;
}
