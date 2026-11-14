import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { inspectPe } from './peInfo';

export const DEBUG_TYPE = 'dotnet-x86';

export class X86ConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (process.platform !== 'win32') {
            void vscode.window.showErrorMessage('.NET x86 Debugger は Windows でのみ動作します。');
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

    resolveDebugConfigurationWithSubstitutedVariables(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        try {
            return config.request === 'attach' ? resolveAttach(config) : resolveLaunch(config);
        } catch (e) {
            void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
            return undefined;
        }
    }
}

function resolveLaunch(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
    const program: unknown = config.program;
    if (typeof program !== 'string' || !program) {
        throw new Error('launch.json に "program"（x86 の .exe へのパス）を指定してください。');
    }
    if (!fs.existsSync(program)) {
        throw new Error(`program が見つかりません: ${program}。ビルド済みか、出力パス（bin/x86/...）が正しいか確認してください。`);
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
        throw new Error(`${path.basename(program)} は .NET Framework のアプリと判定されました。この拡張は .NET (Core / 5 以降) のみ対応しています。`);
    }
    if (bitness === 'x64' || bitness === 'anycpu') {
        void vscode.window.showWarningMessage(
            `${path.basename(program)} は 64bit プロセスとして起動します（${bitness}）。` +
                'x86 でデバッグするにはプロジェクトに <PlatformTarget>x86</PlatformTarget> を設定してください。',
        );
    }
    return config;
}

function resolveAttach(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
    const pid = Number(config.processId);
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`processId が不正です: ${config.processId}。数値の PID か "\${command:pickProcess}" を指定してください。`);
    }
    config.processId = pid;
    return config;
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
        'x86 版 dotnet.exe が見つかりません。x86 の .NET ランタイム（Windows Desktop Runtime x86）をインストールするか、DOTNET_ROOT(x86) を設定してください。',
    );
}
