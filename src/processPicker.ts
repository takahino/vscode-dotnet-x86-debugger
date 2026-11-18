import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ProcessInfo {
    pid: string;
    name: string;
    title?: string;
    /** The bitness the process runs as: the engine of the same bitness attaches to it. */
    architecture: 'x86' | 'x64';
}

interface ProcessItem extends vscode.QuickPickItem {
    pid?: string;
    showAll?: boolean;
}

/**
 * .NET processes of one bitness: those with coreclr.dll (.NET) or clr.dll (.NET Framework 4) loaded, as seen from the
 * PowerShell of that bitness. A process sees only the modules of its own bitness in another process (a 64-bit one sees
 * the WOW64 layer of a 32-bit process, a 32-bit one nothing of a 64-bit process), so each list holds exactly the
 * processes the engine of that bitness can attach to, and the two lists never overlap.
 */
function listDotnetProcessesOf(architecture: 'x86' | 'x64'): Promise<ProcessInfo[]> {
    const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', architecture === 'x86' ? 'SysWOW64' : 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script =
        'Get-Process | ForEach-Object { try { $m = $_.Modules.ModuleName; if ($m -contains "coreclr.dll" -or $m -contains "clr.dll") { "{0}`t{1}`t{2}" -f $_.Id, $_.ProcessName, $_.MainWindowTitle } } catch {} }';
    return new Promise((resolve, reject) => {
        cp.execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
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
                        return { pid, name, title: title || undefined, architecture };
                    }),
            );
        });
    });
}

/** The x86 and x64 .NET processes. */
export async function listDotnetProcesses(): Promise<ProcessInfo[]> {
    const [x86, x64] = await Promise.all([listDotnetProcessesOf('x86'), listDotnetProcessesOf('x64')]);
    return [...x86, ...x64];
}

/**
 * The bitness of a process to attach to. A .NET process is found in one of the lists; any other process (its runtime
 * not loaded yet, or not .NET) gets the x86 engine, which refuses it with the reason when it does not fit.
 */
export async function processArchitecture(pid: number): Promise<'x86' | 'x64'> {
    try {
        const x64 = await listDotnetProcessesOf('x64');
        return x64.some((p) => Number(p.pid) === pid) ? 'x64' : 'x86';
    } catch {
        return 'x86';
    }
}
/** "${command:pickProcess}": the x86 and x64 .NET processes first, with a way to fall back to every process. */
export async function pickProcess(): Promise<string | undefined> {
    const quickPick = vscode.window.createQuickPick<ProcessItem>();
    quickPick.placeholder = vscode.l10n.t('Select the .NET process to attach to');
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.busy = true;
    quickPick.show();

    const showAllItem: ProcessItem = { label: vscode.l10n.t('$(list-unordered) Show all processes...'), showAll: true, alwaysShow: true };
    try {
        const processes = await listDotnetProcesses();
        quickPick.items = [
            ...processes
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => ({ label: p.name, description: `${p.pid} · ${p.architecture}`, detail: p.title, pid: p.pid })),
            showAllItem,
        ];
        if (processes.length === 0) {
            quickPick.placeholder = vscode.l10n.t('No .NET process is running. Start the app, or show all processes.');
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
        placeHolder: vscode.l10n.t('Select the .NET process to attach to'),
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
