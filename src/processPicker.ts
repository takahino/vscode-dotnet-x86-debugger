import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ProcessInfo {
    pid: string;
    name: string;
    title?: string;
}

interface ProcessItem extends vscode.QuickPickItem {
    pid?: string;
    showAll?: boolean;
}

/**
 * Lists 32-bit .NET (Core) processes: those with coreclr.dll loaded, as seen from a 32-bit PowerShell.
 * A 64-bit process cannot enumerate the modules of 32-bit processes, and a 32-bit one fails on 64-bit processes,
 * so the WOW64 PowerShell keeps exactly the processes this debugger can attach to.
 */
export function listX86DotnetProcesses(): Promise<ProcessInfo[]> {
    const ps32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script =
        'Get-Process | ForEach-Object { try { if ($_.Modules.ModuleName -contains "coreclr.dll") { "{0}`t{1}`t{2}" -f $_.Id, $_.ProcessName, $_.MainWindowTitle } } catch {} }';
    return new Promise((resolve, reject) => {
        cp.execFile(ps32, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(new Error(vscode.l10n.t('Could not list processes: {0}', err.message)));
                return;
            }
            resolve(
                stdout
                    .split(/\r?\n/)
                    .filter((l) => l.trim())
                    .map((l) => {
                        const [pid, name, title] = l.split('\t');
                        return { pid, name, title: title || undefined };
                    }),
            );
        });
    });
}

/** "${command:pickProcess}": x86 .NET processes first, with a way to fall back to every process. */
export async function pickProcess(): Promise<string | undefined> {
    const quickPick = vscode.window.createQuickPick<ProcessItem>();
    quickPick.placeholder = vscode.l10n.t('Select the x86 process to attach to');
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.busy = true;
    quickPick.show();

    const showAllItem: ProcessItem = { label: vscode.l10n.t('$(list-unordered) Show all processes...'), showAll: true, alwaysShow: true };
    try {
        const processes = await listX86DotnetProcesses();
        quickPick.items = [
            ...processes
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => ({ label: p.name, description: p.pid, detail: p.title, pid: p.pid })),
            showAllItem,
        ];
        if (processes.length === 0) {
            quickPick.placeholder = vscode.l10n.t('No x86 .NET process is running. Start the app, or show all processes.');
        }
    } catch (e) {
        void vscode.window.showWarningMessage(e instanceof Error ? e.message : String(e));
        quickPick.items = [showAllItem];
    }
    quickPick.busy = false;

    const picked = await new Promise<ProcessItem | undefined>((resolve) => {
        quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
        quickPick.onDidHide(() => resolve(undefined));
    });
    quickPick.dispose();
    if (picked?.showAll) {
        return pickFromAllProcesses();
    }
    return picked?.pid;
}

async function pickFromAllProcesses(): Promise<string | undefined> {
    const items = await listAllProcesses();
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select the x86 process to attach to'),
        matchOnDescription: true,
    });
    return picked?.pid;
}

function listAllProcesses(): Promise<ProcessItem[]> {
    return new Promise((resolve, reject) => {
        cp.execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(new Error(vscode.l10n.t('Could not list processes: {0}', err.message)));
                return;
            }
            const items = stdout
                .split(/\r?\n/)
                .map((line) => line.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)))
                .filter((cols): cols is string[] => !!cols && cols.length >= 2)
                .map(([name, pid]) => ({ label: name, description: pid, pid }))
                .sort((a, b) => a.label.localeCompare(b.label));
            resolve(items);
        });
    });
}
