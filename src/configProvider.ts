import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { inspectPe } from './peInfo';
import { listX86DotnetProcesses } from './processPicker';

export const DEBUG_TYPE = 'dotnet-x86';

export class X86ConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (process.platform !== 'win32') {
            void vscode.window.showErrorMessage(vscode.l10n.t(".NET x86 Debugger works on Windows only."));
            return undefined;
        }
        // F5 without launch.json: ask VS Code to open launch.json with our initial configuration.
        if (!config.type && !config.request && !config.name) {
            return null;
        }
        config.type = DEBUG_TYPE;
        config.request ??= 'launch';
        if (config.request === 'launch') {
            config.cwd ??= '${workspaceFolder}';
        }
        return config;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | undefined> {
        try {
            return config.request === 'attach' ? await resolveAttach(config) : resolveLaunch(config);
        } catch (e) {
            void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
            return undefined;
        }
    }
}

function resolveLaunch(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
    const program: unknown = config.program;
    if (typeof program !== 'string' || !program) {
        throw new Error(vscode.l10n.t("Set \"program\" (the path to the x86 .exe) in launch.json."));
    }
    if (!fs.existsSync(program)) {
        throw new Error(vscode.l10n.t("program not found: {0}. Check that the project is built and the output path (bin/x86/...) is correct.", program));
    }

    const isDll = path.extname(program).toLowerCase() === '.dll';
    if (isDll) {
        // A framework-dependent .dll must be hosted by the x86 dotnet.exe to run as 32-bit.
        config.args = [program, ...(Array.isArray(config.args) ? config.args : [])];
        config.program = findX86DotnetHost();
        return config;
    }

    const { bitness, managed } = inspectPe(program);
    // .NET 5+ produces a native apphost exe; a managed exe means .NET Framework, which netcoredbg cannot debug.
    if (managed) {
        throw new Error(vscode.l10n.t("{0} looks like a .NET Framework app. This extension supports .NET (Core / 5 and later) only.", path.basename(program)));
    }
    if (bitness === 'x64' || bitness === 'anycpu') {
        void vscode.window.showWarningMessage(
            vscode.l10n.t("{0} will run as a 64-bit process ({1}). To debug it as x86, set <PlatformTarget>x86</PlatformTarget> in the project.", path.basename(program), bitness),
        );
    }
    return config;
}

async function resolveAttach(config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    if (config.processId === undefined && typeof config.processName === 'string' && config.processName.trim()) {
        const pid = await waitForProcess(config.processName.trim(), Number(config.waitTimeout ?? 120));
        if (pid === undefined) {
            return undefined; // cancelled
        }
        config.processId = pid;
    }
    const pid = Number(config.processId);
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(vscode.l10n.t("Invalid processId: {0}. Specify a numeric PID or \"${command:pickProcess}\".", String(config.processId)));
    }
    config.processId = pid;
    return config;
}

/**
 * Waits until an x86 .NET process with this name (with or without ".exe") is running with its runtime loaded,
 * then returns its PID. Returns undefined when the user cancels; throws on timeout.
 */
async function waitForProcess(processName: string, timeoutSeconds: number): Promise<number | undefined> {
    const wanted = processName.replace(/.exe$/i, '').toLowerCase();
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Waiting for {0} to start (x86 .NET)…', processName),
            cancellable: true,
        },
        async (_progress, token) => {
            const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
            while (!token.isCancellationRequested) {
                const found = (await listX86DotnetProcesses()).find((p) => p.name.toLowerCase() === wanted);
                if (found) {
                    return Number(found.pid);
                }
                if (Date.now() > deadline) {
                    throw new Error(vscode.l10n.t('{0} did not start within {1} seconds. Start the app, or raise "waitTimeout" in launch.json.', processName, timeoutSeconds));
                }
                await new Promise((r) => setTimeout(r, 500));
            }
            return undefined;
        },
    );
}

function findX86DotnetHost(): string {
    const candidates = [
        process.env['DOTNET_ROOT(x86)'],
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'dotnet'),
    ].filter((p): p is string => !!p);
    for (const dir of candidates) {
        const exe = path.join(dir, 'dotnet.exe');
        if (fs.existsSync(exe)) {
            return exe;
        }
    }
    throw new Error(
        vscode.l10n.t("The x86 dotnet.exe was not found. Install the x86 .NET runtime (Windows Desktop Runtime x86) or set DOTNET_ROOT(x86)."),
    );
}
