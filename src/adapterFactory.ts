import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Folder (relative to the extension root) holding the bundled x86 build of netcoredbg. */
const BUNDLED_DEBUGGER_DIR = path.join('debugger', 'netcoredbg-x86');

export class X86AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(
        private readonly extensionPath: string,
        private readonly output: vscode.OutputChannel,
    ) {}

    createDebugAdapterDescriptor(): vscode.DebugAdapterDescriptor {
        const debugger_ = this.locateDebugger();
        this.output.appendLine(`[session] using ${debugger_}`);
        return new vscode.DebugAdapterExecutable(debugger_, ['--interpreter=vscode'], {
            cwd: path.dirname(debugger_),
        });
    }

    private locateDebugger(): string {
        const configured = vscode.workspace.getConfiguration('dotnetX86').get<string>('debuggerPath');
        if (configured) {
            if (!fs.existsSync(configured)) {
                throw new Error(
                    `設定 dotnetX86.debuggerPath の netcoredbg が見つかりません: ${configured}。パスを修正するか、空にして同梱版を使ってください。`,
                );
            }
            return configured;
        }
        const bundled = path.join(this.extensionPath, BUNDLED_DEBUGGER_DIR, 'netcoredbg.exe');
        if (!fs.existsSync(bundled)) {
            throw new Error(
                `同梱の netcoredbg (x86) が見つかりません: ${bundled}。scripts\\build-netcoredbg.ps1 でビルドしてから VSIX を作り直すか、dotnetX86.debuggerPath を設定してください。`,
            );
        }
        return bundled;
    }
}
