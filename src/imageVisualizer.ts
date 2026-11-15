import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { imageInfoExpressions, pngSize, saveAsPngExpression } from './imageCore';
import { VariablesContextArg, targetFromContext } from './variableDump';

/**
 * "View as Image" (Variables / Watch context menu): shows a System.Drawing Image / Bitmap / Icon variable as a picture.
 * The debuggee saves it as a PNG in a temporary folder, which is read and deleted at once.
 */
export async function viewAsImageCommand(arg?: VariablesContextArg): Promise<void> {
    const target = targetFromContext(arg, vscode.l10n.t('View as Image'));
    if (!target) {
        return;
    }
    const frame = vscode.debug.activeStackItem;
    const frameId = frame instanceof vscode.DebugStackFrame ? frame.frameId : undefined;
    const evaluate = async (expression: string): Promise<string> => {
        const r = await target.session.customRequest('evaluate', { expression, frameId, context: 'watch' });
        return String(r?.result ?? '');
    };

    const dir = path.join(os.tmpdir(), 'dotnetx86-images');
    const png = path.join(dir, `${crypto.randomUUID()}.png`);
    try {
        const typeName = (await evaluate(`(${target.expression}).GetType().FullName`)).replace(/^"|"$/g, '');
        fs.mkdirSync(dir, { recursive: true });
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading {0}…', target.expression) }, () =>
            evaluate(saveAsPngExpression(target.expression, typeName, png)),
        );
        const bytes = fs.existsSync(png) ? fs.readFileSync(png) : undefined;
        const size = bytes && pngSize(bytes);
        if (!bytes || !size) {
            void vscode.window.showErrorMessage(
                vscode.l10n.t('{0} cannot be shown as an image (type: {1}). Use it on a System.Drawing Image, Bitmap or Icon, while stopped in your code.', target.expression, typeName || target.root.type || '?'),
            );
            return;
        }
        const info: [string, string][] = [[vscode.l10n.t('Type'), typeName]];
        for (const [label, expression] of Object.entries(imageInfoExpressions(target.expression, typeName))) {
            info.push([label, await evaluate(expression).catch(() => '?')]);
        }
        show(target.expression, bytes, size, info);
    } catch (e) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not read {0} as an image: {1}', target.expression, e instanceof Error ? e.message : String(e)));
    } finally {
        fs.rmSync(png, { force: true });
    }
}

function show(expression: string, png: Buffer, size: { width: number; height: number }, info: [string, string][]): void {
    const panel = vscode.window.createWebviewPanel('dotnetX86.image', vscode.l10n.t('Image: {0}', expression), vscode.ViewColumn.Beside, { enableScripts: true });
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const t = { fit: vscode.l10n.t('Fit'), actual: vscode.l10n.t('Actual size') };
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = info.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
    panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; }
  .bar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; cursor: pointer; }
  button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .zoom { color: var(--vscode-descriptionForeground); margin-left: 6px; }
  .stage { overflow: auto; max-height: calc(100vh - 140px); border: 1px solid var(--vscode-panel-border); }
  /* Checkerboard so transparent pixels show as such. */
  .stage img { display: block; image-rendering: pixelated; background: repeating-conic-gradient(#c8c8c8 0% 25%, #ffffff 0% 50%) 0 0 / 16px 16px; }
  table { margin-top: 10px; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: var(--vscode-descriptionForeground); font-weight: normal; padding: 1px 12px 1px 0; }
</style></head>
<body>
<div class="bar"><button id="fit" class="on">${esc(t.fit)}</button><button id="actual">${esc(t.actual)}</button><button id="out">−</button><button id="in">+</button><span class="zoom" id="zoom"></span></div>
<div class="stage" id="stage"><img id="img" alt="${esc(expression)}" src="data:image/png;base64,${png.toString('base64')}"></div>
<table>${rows}</table>
<script nonce="${nonce}">
  const img = document.getElementById('img'), stage = document.getElementById('stage'), label = document.getElementById('zoom');
  const W = ${size.width}, H = ${size.height};
  let scale = 1, fit = true;
  function apply() {
    if (fit) scale = Math.min(1, (stage.clientWidth - 2) / W, (window.innerHeight - 150) / H) || 1;
    img.style.width = Math.max(1, Math.round(W * scale)) + 'px';
    img.style.height = Math.max(1, Math.round(H * scale)) + 'px';
    label.textContent = W + ' × ' + H + '  ·  ' + Math.round(scale * 100) + '%';
    document.getElementById('fit').className = fit ? 'on' : '';
    document.getElementById('actual').className = !fit && scale === 1 ? 'on' : '';
  }
  document.getElementById('fit').onclick = () => { fit = true; apply(); };
  document.getElementById('actual').onclick = () => { fit = false; scale = 1; apply(); };
  document.getElementById('in').onclick = () => { fit = false; scale = Math.min(32, scale * 2); apply(); };
  document.getElementById('out').onclick = () => { fit = false; scale = Math.max(1 / 32, scale / 2); apply(); };
  window.addEventListener('resize', () => fit && apply());
  apply();
</script>
</body></html>`;
}
