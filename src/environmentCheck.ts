import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE, x86DotnetRoots } from './configProvider';
import { findProjects } from './launchSetup';
import { findX86Runtimes, programCandidates, projectIssues, setProperty } from './projectSetupCore';

const DOWNLOAD_URL = 'https://dotnet.microsoft.com/download/dotnet';

type Level = 'ok' | 'warning' | 'error' | 'info';

interface Fix {
    label: string;
    /** What the page posts back to do it. */
    action: { type: 'url'; url: string } | { type: 'command'; command: string } | { type: 'property'; file: string; name: string; value: string } | { type: 'open'; file: string };
}

interface Item {
    level: Level;
    title: string;
    detail?: string;
    fixes?: Fix[];
}

/**
 * Environment check: whether this machine and the open projects are ready for x86 .NET debugging, with a button for
 * each problem that can be fixed from here.
 */
export class EnvironmentCheck implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    /** The fix behind each button of the page shown; the page only posts back an index. */
    private fixes: Fix['action'][] = [];

    constructor(private readonly extensionPath: string) {}

    async show(): Promise<void> {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('dotnetX86.environment', vscode.l10n.t('Environment Check (.NET x86)'), vscode.ViewColumn.Active, { enableScripts: true });
            this.panel.onDidDispose(() => (this.panel = undefined));
            this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
        }
        this.panel.reveal();
        await this.refresh();
    }

    dispose(): void {
        this.panel?.dispose();
    }

    private async refresh(): Promise<void> {
        if (!this.panel) {
            return;
        }
        this.render([], vscode.l10n.t('Checking…'));
        const sections = [
            { title: vscode.l10n.t('This machine'), items: await this.machineItems() },
            ...await this.projectSections(),
        ];
        this.render(sections, '');
    }

    private render(sections: { title: string; items: Item[] }[], status: string): void {
        if (this.panel) {
            const { html, fixes } = page(sections, status);
            this.fixes = fixes;
            this.panel.webview.html = html;
        }
    }

    private async machineItems(): Promise<Item[]> {
        const t = vscode.l10n.t;
        const items: Item[] = [];
        if (process.platform !== 'win32') {
            items.push({ level: 'error', title: t('Windows is required'), detail: t('x86 .NET programs can only be debugged on Windows.') });
            return items;
        }
        const debuggerExe = path.join(this.extensionPath, 'debugger', 'netcoredbg-x86', 'netcoredbg.exe');
        items.push(fs.existsSync(debuggerExe)
            ? { level: 'ok', title: t('Bundled debugger (netcoredbg x86)'), detail: debuggerExe }
            : { level: 'error', title: t('The bundled debugger is missing'), detail: t('{0} was not found. Reinstall the extension.', debuggerExe) });

        const runtimes = findX86Runtimes(x86DotnetRoots());
        const download = { label: t('Download page'), action: { type: 'url' as const, url: DOWNLOAD_URL } };
        if (!runtimes.netCore.length) {
            items.push({
                level: 'error', title: t('x86 .NET Runtime not found'),
                detail: t('The debugger runs on the x86 .NET runtime (8 or later), also for .NET Framework apps. Install the .NET Desktop Runtime for x86 (it includes the .NET Runtime), or set DOTNET_ROOT(x86).'),
                fixes: [download],
            });
        } else {
            const newest = Number(runtimes.netCore[0].split('.')[0]);
            items.push(newest >= 8
                ? { level: 'ok', title: t('x86 .NET Runtime {0}', runtimes.netCore.join(', ')), detail: runtimes.root }
                : { level: 'error', title: t('x86 .NET Runtime {0} is too old', runtimes.netCore[0]), detail: t('The debugger needs the x86 .NET runtime 8 or later.'), fixes: [download] });
            items.push(runtimes.windowsDesktop.length
                ? { level: 'ok', title: t('x86 .NET Desktop Runtime {0}', runtimes.windowsDesktop.join(', ')), detail: t('For WinForms / WPF apps on .NET 5 or later.') }
                : { level: 'warning', title: t('x86 .NET Desktop Runtime not found'), detail: t('WinForms / WPF apps on .NET 5 or later need it to run as x86. Console apps and .NET Framework apps do not.'), fixes: [download] });
        }

        const sdks = await listSdks();
        items.push(sdks.length
            ? { level: 'ok', title: t('.NET SDK {0}', sdks.slice(-3).reverse().join(', ')), detail: t('Used by the build task (dotnet build).') }
            : { level: 'warning', title: t('.NET SDK not found'), detail: t('"dotnet build" is not available on PATH, so the build task cannot run. Install the .NET SDK (x64 is fine) or build another way.'), fixes: [download] });
        return items;
    }

    private async projectSections(): Promise<{ title: string; items: Item[] }[]> {
        const t = vscode.l10n.t;
        const sections: { title: string; items: Item[] }[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const items: Item[] = [];
            const projects = (await findProjects(folder)).filter((p) => p.executable);
            if (!projects.length) {
                items.push({ level: 'info', title: t('No executable C# project found'), detail: t('Open the folder that contains your .csproj (OutputType Exe or WinExe).') });
            }
            for (const p of projects) {
                const rel = path.relative(folder.uri.fsPath, p.file);
                const issues = projectIssues(p);
                const open = { label: t('Open .csproj'), action: { type: 'open' as const, file: p.file } };
                if (issues.includes('not-x86')) {
                    items.push({
                        level: 'error', title: t('{0}: not built as x86', rel),
                        detail: t('Without <PlatformTarget>x86</PlatformTarget> the exe runs as a 64-bit process on 64-bit Windows, which this debugger cannot debug.'),
                        fixes: [{ label: t('Add <PlatformTarget>x86</PlatformTarget>'), action: { type: 'property', file: p.file, name: 'PlatformTarget', value: 'x86' } }, open],
                    });
                }
                if (issues.includes('windows-pdb')) {
                    items.push({
                        level: 'error', title: t('{0}: writes a Windows PDB', rel),
                        detail: t('The debugger reads Portable PDBs only; with a Windows PDB ("full" / "pdbonly") breakpoints are never hit.'),
                        fixes: [{ label: t('Set <DebugType>portable</DebugType>'), action: { type: 'property', file: p.file, name: 'DebugType', value: 'portable' } }, open],
                    });
                }
                if (!issues.length) {
                    const dir = path.dirname(p.file);
                    const built = p.targetFrameworks.some((tfm) => programCandidates(p, tfm).some((c) => fs.existsSync(path.join(dir, c))));
                    items.push(built
                        ? { level: 'ok', title: t('{0}: ready ({1})', rel, p.targetFrameworks.join(', ')) }
                        : { level: 'info', title: t('{0}: ready, not built yet', rel), detail: t('The build task builds it when you start debugging.') });
                }
            }
            const configs = vscode.workspace.getConfiguration('launch', folder.uri).get<{ type?: string }[]>('configurations') ?? [];
            if (projects.length) {
                items.push(configs.some((c) => c.type === DEBUG_TYPE)
                    ? { level: 'ok', title: t('launch.json has a .NET x86 configuration') }
                    : {
                        level: 'warning', title: t('No .NET x86 configuration in launch.json'),
                        detail: t('Generate one from the projects, with a build task.'),
                        fixes: [{ label: t('Generate launch.json'), action: { type: 'command', command: 'dotnetX86.generateLaunchJson' } }],
                    });
            }
            sections.push({ title: t('Workspace: {0}', folder.name), items });
        }
        return sections;
    }

    private async onMessage(m: { type?: string; index?: number }): Promise<void> {
        const a = typeof m.index === 'number' ? this.fixes[m.index] : undefined;
        if (m.type === 'refresh') {
            await this.refresh();
            return;
        }
        if (m.type !== 'fix' || !a) {
            return;
        }
        try {
            if (a.type === 'url') {
                await vscode.env.openExternal(vscode.Uri.parse(a.url));
                return;
            }
            if (a.type === 'open') {
                await vscode.window.showTextDocument(vscode.Uri.file(a.file), { viewColumn: vscode.ViewColumn.Beside });
                return;
            }
            if (a.type === 'command') {
                await vscode.commands.executeCommand(a.command);
            } else {
                // Through a workspace edit, so that the change can be undone and an open editor stays in sync.
                const doc = await vscode.workspace.openTextDocument(a.file);
                const text = setProperty(doc.getText(), a.name, a.value);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            }
            await this.refresh();
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not apply the fix: {0}', e instanceof Error ? e.message : String(e)));
        }
    }
}

/** Installed .NET SDK versions (oldest first) from `dotnet --list-sdks`; empty when dotnet is not on PATH. */
function listSdks(): Promise<string[]> {
    return new Promise((resolve) => {
        childProcess.execFile('dotnet', ['--list-sdks'], { timeout: 15_000, windowsHide: true }, (error, stdout) => {
            resolve(error ? [] : stdout.split(/\r?\n/).map((l) => l.split(' ')[0]).filter((v) => /^\d/.test(v)));
        });
    });
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(sections: { title: string; items: Item[] }[], status: string): { html: string; fixes: Fix['action'][] } {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const icon: Record<Level, string> = { ok: '✔', warning: '⚠', error: '✖', info: 'ℹ' };
    const fixes: Fix['action'][] = [];
    const body = sections.map((s) => `<h2>${esc(s.title)}</h2><ul>` + s.items.map((i) => {
        const buttons = (i.fixes ?? []).map((f) => {
            fixes.push(f.action);
            return `<button data-fix="${fixes.length - 1}">${esc(f.label)}</button>`;
        }).join('');
        return `<li class="${i.level}"><span class="icon">${icon[i.level]}</span><div><div class="title">${esc(i.title)}</div>` +
            (i.detail ? `<div class="detail">${esc(i.detail)}</div>` : '') + (buttons ? `<div class="fixes">${buttons}</div>` : '') + '</div></li>';
    }).join('') + '</ul>').join('');
    const problems = sections.flatMap((s) => s.items).filter((i) => i.level === 'error' || i.level === 'warning').length;
    const summary = status || (problems ? vscode.l10n.t('{0} problem(s) to look at.', problems) : vscode.l10n.t('Everything is ready. Press F5 to start debugging.'));
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); padding: 8px 20px; max-width: 900px; }
  h1 { font-size: 18px; font-weight: 600; }
  h2 { font-size: 14px; font-weight: 600; margin: 20px 0 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; gap: 10px; padding: 6px 0; }
  .icon { width: 16px; text-align: center; flex: none; }
  .ok .icon { color: var(--vscode-testing-iconPassed, #388a34); }
  .warning .icon { color: var(--vscode-editorWarning-foreground, #bf8803); }
  .error .icon { color: var(--vscode-editorError-foreground, #e51400); }
  .info .icon { color: var(--vscode-editorInfo-foreground, #1a85ff); }
  .detail { color: var(--vscode-descriptionForeground); margin-top: 2px; word-break: break-all; }
  .fixes { margin-top: 6px; display: flex; gap: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 12px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .bar { display: flex; gap: 12px; align-items: center; }
</style></head><body>
<h1>${esc(vscode.l10n.t('.NET x86 Debugger: Environment Check'))}</h1>
<div class="bar"><span>${esc(summary)}</span><button class="secondary" id="refresh">${esc(vscode.l10n.t('Check Again'))}</button></div>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    if (el.id === 'refresh') vscode.postMessage({ type: 'refresh' });
    else vscode.postMessage({ type: 'fix', index: Number(el.dataset.fix) });
  });
</script></body></html>`;
    return { html, fixes };
}
