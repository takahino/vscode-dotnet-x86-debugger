import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DOTNET_FRAMEWORK_KEY, findX86CoreClr } from './configProvider';
import { isEnabled } from './features';
import { DapProxy, ExceptionFilterText, ProxyOptions } from './dapProxy';
import { SYMBOL_DIRS_ENV, readDecompiledAssemblies } from './decompilerCore';
import { SourcePathMapper, UnresolvedSource } from './sourceMapCore';
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

interface SourceMapSetup {
    mapper: SourcePathMapper;
    preloadModules: string[];
}

/** Values of a string -> string object; other entries are reported and skipped. */
function stringMap(value: unknown, where: string, output: vscode.OutputChannel): Record<string, string> {
    if (value === undefined || value === null) {
        return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        output.appendLine(`[source map] ${where} ignored: expected an object of "PDB path prefix": "local path prefix".`);
        return {};
    }
    const result: Record<string, string> = {};
    for (const [from, to] of Object.entries(value)) {
        if (typeof to === 'string') {
            result[from] = to;
        } else {
            output.appendLine(`[source map] ${where}: entry "${from}" ignored: the local path must be a string.`);
        }
    }
    return result;
}

function stringArray(value: unknown, where: string, output: vscode.OutputChannel): string[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        output.appendLine(`[source map] ${where} ignored: expected an array of folders.`);
        return [];
    }
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * sourceFileMap / sourceSearchPaths from launch.json merged over the dotnetX86.* settings (launch.json wins on the
 * same prefix; folders from both are searched). VS Code substitutes variables in launch.json only, so the settings'
 * ${workspaceFolder} and ${userHome} are expanded here; relative folders are taken from the workspace folder.
 */
function sourceMapSetup(session: vscode.DebugSession, output: vscode.OutputChannel): SourceMapSetup {
    const config = session.configuration;
    const folder = session.workspaceFolder?.uri.fsPath;
    const settings = vscode.workspace.getConfiguration('dotnetX86', session.workspaceFolder?.uri);
    const expand = (s: string) => s.replace(/\$\{workspaceFolder\}/g, folder ?? '${workspaceFolder}').replace(/\$\{userHome\}/g, os.homedir());
    const absolute = (p: string) => (folder && !path.isAbsolute(p) ? path.resolve(folder, p) : p);

    const fromSettings = stringMap(settings.get('sourceFileMap'), 'dotnetX86.sourceFileMap', output);
    const sourceFileMap: Record<string, string> = {};
    for (const [from, to] of Object.entries(fromSettings)) {
        sourceFileMap[from] = absolute(expand(to));
    }
    for (const [from, to] of Object.entries(stringMap(config.sourceFileMap, 'sourceFileMap', output))) {
        sourceFileMap[from] = absolute(to);
    }
    const sourceSearchPaths = [
        ...stringArray(config.sourceSearchPaths, 'sourceSearchPaths', output),
        ...stringArray(settings.get('sourceSearchPaths'), 'dotnetX86.sourceSearchPaths', output).map(expand),
    ].map(absolute);

    const mapper = new SourcePathMapper({ sourceFileMap, sourceSearchPaths });
    return { mapper, preloadModules: mapper.enabled ? launchedAssemblies(config) : [] };
}

/**
 * The assemblies next to the launched program: their PDB paths are learned before the breakpoints are sent.
 * (A framework-dependent .dll is launched through dotnet.exe with the .dll as its first argument.)
 */
function launchedAssemblies(config: vscode.DebugConfiguration): string[] {
    if (config.request !== 'launch' || typeof config.program !== 'string') {
        return [];
    }
    const args: unknown[] = Array.isArray(config.args) ? config.args : [];
    const hostedDll = path.basename(config.program).toLowerCase() === 'dotnet.exe' && typeof args[0] === 'string' ? args[0] : undefined;
    const dir = path.dirname(hostedDll ?? config.program);
    try {
        return fs.readdirSync(dir)
            .filter((name) => /\.(dll|exe)$/i.test(name))
            .map((name) => path.join(dir, name));
    } catch {
        return [];
    }
}

/** The provider methods the SQL log stops at (none when the SQL log is off). */
function sqlMethods(): string[] {
    if (!isEnabled('sqlLog')) {
        return [];
    }
    const configured = vscode.workspace.getConfiguration('dotnetX86.sqlLog').get<unknown[]>('methods', []);
    return configured.filter((m): m is string => typeof m === 'string' && /^[\w.]+\.\w+\.\w+$/.test(m.trim())).map((m) => m.trim());
}

function missingSourceMessage(unresolved: UnresolvedSource): string {
    if (unresolved.candidates.length > 1) {
        return vscode.l10n.t('Several files match the source {0}: {1}. Narrow "sourceSearchPaths", or add a "sourceFileMap" entry for its folder.', unresolved.pdbPath, unresolved.candidates.join(', '));
    }
    const pdbDir = unresolved.pdbPath.includes('\\') ? path.win32.dirname(unresolved.pdbPath) : path.posix.dirname(unresolved.pdbPath);
    return vscode.l10n.t('Source not found: {0}. Add a parent folder of the source to "sourceSearchPaths", or map its folder in "sourceFileMap" (e.g. "{1}": "<local folder>").', unresolved.pdbPath, pdbDir);
}

class ProxyAdapter implements vscode.DebugAdapter {
    private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.emitter.event;
    private readonly proxy: DapProxy;

    constructor(executable: string, args: string[], output: vscode.OutputChannel, env: Record<string, string>, sourceMap: SourceMapSetup, breakOnExceptionTypes: string[], symbols: Pick<ProxyOptions, 'symbolDirs' | 'sourceLink'>) {
        this.proxy = new DapProxy(
            executable,
            args,
            path.dirname(executable),
            (m) => this.emitter.fire(m as vscode.DebugProtocolMessage),
            (line) => output.appendLine(line.trimEnd()),
            {
                env,
                exceptionFilters: exceptionFilterTexts(),
                exceptionLog: vscode.workspace.getConfiguration('dotnetX86.exceptionLog').get<boolean>('enabled', true),
                exceptionSnapshot: vscode.workspace.getConfiguration('dotnetX86.exceptionLog').get<boolean>('captureLocals', true),
                findWriteSites,
                gotoFailedMessage: vscode.l10n.t('The next statement can only be set to a line in the method that is executing, and not into or out of a catch / finally block.'),
                sourceMapper: sourceMap.mapper,
                preloadModules: sourceMap.preloadModules,
                missingSourceMessage,
                breakOnExceptionTypes,
                sqlMethods: sqlMethods(),
                freezeDescription: (ms) => vscode.l10n.t('UI not responding for {0} s', (ms / 1000).toFixed(1)),
                ...symbols,
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

/**
 * Environment for netcoredbg's .NET Framework support (patch 0007): NETCOREDBG_DESKTOP_CLR launches the program with
 * the .NET Framework CLR, and NETCOREDBG_HOST_CORECLR is the CoreCLR netcoredbg runs its own managed part on.
 * The host is also given for attach, where netcoredbg falls back to .NET Framework when the process has no CoreCLR.
 */
function debuggerEnvironment(config: vscode.DebugConfiguration): Record<string, string> {
    const framework = config.request === 'launch' && config[DOTNET_FRAMEWORK_KEY] === true;
    let hostCoreClr: string | undefined;
    try {
        hostCoreClr = findX86CoreClr();
    } catch (e) {
        if (framework) {
            throw e; // Required to launch a .NET Framework app.
        }
        return {}; // Attach to a .NET Framework process is then unavailable; .NET (Core) does not need it.
    }
    return framework ? { NETCOREDBG_DESKTOP_CLR: '1', NETCOREDBG_HOST_CORECLR: hostCoreClr } : { NETCOREDBG_HOST_CORECLR: hostCoreClr };
}

/** Folder (relative to the extension root) holding the bundled x86 build of netcoredbg. */
const BUNDLED_DEBUGGER_DIR = path.join('debugger', 'netcoredbg-x86');

export class X86AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(
        private readonly extensionPath: string,
        private readonly logDir: string,
        private readonly output: vscode.OutputChannel,
        /** Caches in the extension's storage: decompiled and downloaded symbols (by MVID), Source Link downloads. */
        private readonly caches: { decompiled: string; symbols: string; sources: string },
        /** Exception types checked in the Exception Settings view. */
        private readonly checkedExceptionTypes: () => string[] = () => [],
    ) {}

    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
        const debugger_ = this.locateDebugger();
        this.output.appendLine(`[session] using ${debugger_}`);
        const env = debuggerEnvironment(session.configuration);
        const args = ['--interpreter=vscode'];
        // With tracing on, netcoredbg also writes its own log (flushed per line, so it survives a hang or crash).
        if (vscode.workspace.getConfiguration('dotnetX86').get<boolean>('trace')) {
            fs.mkdirSync(this.logDir, { recursive: true });
            const logFile = path.join(this.logDir, `netcoredbg-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
            args.push(`--log=${logFile}`);
            this.output.appendLine(`[trace] netcoredbg log: ${logFile}`);
        }
        const sourceMap = sourceMapSetup(session, this.output);
        // Decompiled and downloaded symbols: netcoredbg (patch 0009) loads them from these folders by MVID. The variable
        // must be set before netcoredbg starts (in the ProxyAdapter constructor).
        const symbolDirs = [this.caches.decompiled, this.caches.symbols].filter((dir) => hasEntries(dir));
        if (symbolDirs.length) {
            env[SYMBOL_DIRS_ENV] = symbolDirs.join(path.delimiter);
        }
        // Decompiled PDBs name their documents relatively ("Namespace/Type.cs"): map them to the extracted files.
        const decompiled = readDecompiledAssemblies(this.caches.decompiled);
        if (decompiled.length) {
            sourceMap.mapper.addFilePairs(decompiled.flatMap((a) => a.documents.map((d) => ({ pdbPath: d.name, local: d.file }))));
            this.output.appendLine(`[decompiler] symbols of ${decompiled.length} decompiled assemblies are available`);
        }
        const sourceLink = vscode.workspace.getConfiguration('dotnetX86', session.workspaceFolder?.uri).get<boolean>('sourceLink.enabled', true)
            ? { cacheRoot: this.caches.sources }
            : undefined;
        // netcoredbg runs behind a DAP relay that adds logpoints (see DapProxy).
        const adapter = new ProxyAdapter(debugger_, args, this.output, env, sourceMap, this.checkedExceptionTypes(), { symbolDirs, sourceLink });
        if (sourceMap.mapper.enabled) {
            // Generated files under obj\ are never on another machine's disk and are not worth reporting.
            const unresolved = sourceMap.mapper.unresolvedAll().filter((u) => !/[\\/]obj[\\/]/i.test(u.pdbPath));
            this.output.appendLine(`[source map] ${sourceMap.preloadModules.length} assemblies scanned, ${unresolved.length} source(s) not found${sourceMap.mapper.truncated ? ' (search stopped at the file limit: narrow sourceSearchPaths)' : ''}`);
            for (const u of unresolved) {
                this.output.appendLine(`[source map]   not found: ${u.pdbPath}${u.candidates.length > 1 ? ` (ambiguous: ${u.candidates.join(', ')})` : ''}`);
            }
        }
        return new vscode.DebugAdapterInlineImplementation(adapter);
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

/** Whether a cache folder exists and holds anything. */
function hasEntries(dir: string): boolean {
    try {
        return fs.readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}
