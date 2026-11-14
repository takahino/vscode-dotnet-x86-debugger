import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DapProxy } from './dapProxy';

class ProxyAdapter implements vscode.DebugAdapter {
    private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.emitter.event;
    private readonly proxy: DapProxy;

    constructor(executable: string, args: string[], output: vscode.OutputChannel) {
        this.proxy = new DapProxy(
            executable,
            args,
            path.dirname(executable),
            (m) => this.emitter.fire(m as vscode.DebugProtocolMessage),
            (line) => output.appendLine(line.trimEnd()),
        );
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        this.proxy.fromClient(message as Parameters<DapProxy['fromClient']>[0]);
    }

    dispose(): void {
        this.proxy.dispose();
        this.emitter.dispose();
    }
}

/** Folder (relative to the extension root) holding the bundled x86 build of netcoredbg. */
const BUNDLED_DEBUGGER_DIR = path.join('debugger', 'netcoredbg-x86');

export class X86AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(
        private readonly extensionPath: string,
        private readonly logDir: string,
        private readonly output: vscode.OutputChannel,
    ) {}

    createDebugAdapterDescriptor(): vscode.DebugAdapterDescriptor {
        const debugger_ = this.locateDebugger();
        this.output.appendLine(`[session] using ${debugger_}`);
        const args = ['--interpreter=vscode'];
        // With tracing on, netcoredbg also writes its own log (flushed per line, so it survives a hang or crash).
        if (vscode.workspace.getConfiguration('dotnetX86').get<boolean>('trace')) {
            fs.mkdirSync(this.logDir, { recursive: true });
            const logFile = path.join(this.logDir, `netcoredbg-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
            args.push(`--log=${logFile}`);
            this.output.appendLine(`[trace] netcoredbg log: ${logFile}`);
        }
        // netcoredbg runs behind a DAP relay that adds logpoints (see DapProxy).
        return new vscode.DebugAdapterInlineImplementation(new ProxyAdapter(debugger_, args, this.output));
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
