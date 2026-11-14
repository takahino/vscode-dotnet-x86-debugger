import * as cp from 'child_process';
import * as vscode from 'vscode';

interface ProcessItem extends vscode.QuickPickItem {
    pid: string;
}

/** Lists running processes via tasklist for "${command:pickProcess}". */
export async function pickProcess(): Promise<string | undefined> {
    const items = await listProcesses();
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'アタッチする x86 プロセスを選択',
        matchOnDescription: true,
    });
    return picked?.pid;
}

function listProcesses(): Promise<ProcessItem[]> {
    return new Promise((resolve, reject) => {
        cp.execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                reject(new Error(`プロセス一覧を取得できませんでした: ${err.message}`));
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
