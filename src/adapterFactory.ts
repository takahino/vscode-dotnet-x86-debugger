import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DapProxy, ExceptionFilterText } from './dapProxy';
import { findWriteLines } from './writeSites';

/** Labels for netcoredbg's exception filters, shown in the Breakpoints view. */
function exceptionFilterTexts(): Record<string, ExceptionFilterText> {
    const conditionDescription = vscode.l10n.t('Exception types to break on, e.g. "System.NullReferenceException, System.InvalidOperationException". Start with "!" to break on every type except these.');
    return {
        all: {
            label: vscode.l10n.t('All Exceptions (when thrown)'),
            description: vscode.l10n.t('Break whenever an exception is thrown, even if it is caught later.'),
            conditionDescription,
        },
        'user-unhandled': {
            label: vscode.l10n.t('User-Unhandled Exceptions'),
            description: vscode.l10n.t('Break when an exception is not handled by user code.'),
            conditionDescription,
        },
    };
}

/** Lines of the workspace's C# files that assign to `name`, for the "Break on Value Change" emulation. */
async function findWriteSites(name: string): Promise<{ path: string; line: number }[]> {
    const files = await vscode.workspace.findFiles('**/*.cs', '**/{bin,obj,node_modules,.git}/**', 5000);
    const sites: { path: string; line: number }[] = [];
    for (const uri of files) {
        try {
            const text = await fs.promises.readFile(uri.fsPath, 'utf8');
            for (const line of findWriteLines(text, name)) {
                sites.push({ path: uri.fsPath, line });
            }
        } catch {
            // Unreadable file: skip it.
        }
    }
    return sites;
}

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
            {
                exceptionFilters: exceptionFilterTexts(),
                exceptionLog: vscode.workspace.getConfiguration('dotnetX86.exceptionLog').get<boolean>('enabled', true),
                findWriteSites,
            },
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
                    vscode.l10n.t("netcoredbg in the dotnetX86.debuggerPath setting was not found: {0}. Fix the path, or clear it to use the bundled one.", configured),
                );
            }
            return configured;
        }
        const bundled = path.join(this.extensionPath, BUNDLED_DEBUGGER_DIR, 'netcoredbg.exe');
        if (!fs.existsSync(bundled)) {
            throw new Error(
                vscode.l10n.t("The bundled netcoredbg (x86) was not found: {0}. Build it with scripts\\build-netcoredbg.ps1 and rebuild the VSIX, or set dotnetX86.debuggerPath.", bundled),
            );
        }
        return bundled;
    }
}
