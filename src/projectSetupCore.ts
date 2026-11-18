// First-run setup: reading .csproj files, the debug configurations made from them, and the x86 runtimes installed.
// No vscode dependency, so it can be unit tested.

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectInfo {
    /** Absolute path of the .csproj. */
    file: string;
    /** Assembly name: the exe is `<name>.exe`. */
    name: string;
    sdkStyle: boolean;
    executable: boolean;
    targetFrameworks: string[];
    platformTarget?: string;
    runtimeIdentifier?: string;
    debugType?: string;
    /** Old-style projects: the Debug output folder, with "/" and a trailing "/". */
    outputPath?: string;
}

export type ProjectIssue = 'not-x86' | 'windows-pdb';

/**
 * Reads the properties the debugger cares about. A light XML scan, not MSBuild: values come from the property
 * groups as written (for old-style projects the Debug|x86 or Debug group wins), imports and variables are not followed.
 */
export function parseProject(file: string, text: string): ProjectInfo {
    const sdkStyle = /<Project\b[^>]*\bSdk\s*=/i.test(text);
    // Unconditional groups first, then the Debug ones (x86 before the others), so that a Debug|x86 value wins.
    const groups = [...text.matchAll(/<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi)]
        .map((m) => ({ condition: m[1], body: m[2] }))
        .filter((g) => !/Condition/i.test(g.condition) || /Debug/i.test(g.condition))
        .sort((a, b) => rank(a.condition) - rank(b.condition));
    const prop = (name: string): string | undefined => {
        let value: string | undefined;
        for (const g of groups) {
            const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(g.body);
            if (m) {
                value = m[1];
            }
        }
        return value || undefined;
    };
    const frameworks = prop('TargetFrameworks') ?? prop('TargetFramework');
    const legacyVersion = prop('TargetFrameworkVersion');
    const targetFrameworks = frameworks
        ? frameworks.split(';').map((s) => s.trim()).filter(Boolean)
        : legacyVersion ? [`net${legacyVersion.replace(/^v/i, '').replace(/\./g, '')}`] : [];
    const outputPath = prop('OutputPath');
    return {
        file,
        name: prop('AssemblyName') ?? path.basename(file, path.extname(file)),
        sdkStyle,
        executable: /exe/i.test(prop('OutputType') ?? ''),
        targetFrameworks,
        platformTarget: prop('PlatformTarget'),
        runtimeIdentifier: prop('RuntimeIdentifier'),
        debugType: prop('DebugType'),
        outputPath: outputPath && `${outputPath.replace(/\\/g, '/').replace(/\/*$/, '')}/`,
    };
}

function rank(condition: string): number {
    return !/Condition/i.test(condition) ? 0 : /x86/i.test(condition) ? 2 : 1;
}

/**
 * Where the Debug build puts the exe, relative to the project folder, most likely first. SDK-style projects built with
 * `-p:Platform=x86` (as the generated build task does) get a platform folder; without it they do not.
 */
export function programCandidates(project: ProjectInfo, tfm: string): string[] {
    const exe = `${project.name}.exe`;
    if (!project.sdkStyle) {
        return [`${project.outputPath ?? 'bin/Debug/'}${exe}`];
    }
    const rid = project.runtimeIdentifier ? `${project.runtimeIdentifier}/` : '';
    return [`bin/x86/Debug/${tfm}/${rid}${exe}`, `bin/Debug/${tfm}/${rid}${exe}`];
}

/** What keeps the project from being debugged as x86 with this debugger. */
export function projectIssues(project: ProjectInfo): ProjectIssue[] {
    const issues: ProjectIssue[] = [];
    // Without PlatformTarget an exe is AnyCPU and runs as 64-bit on a 64-bit Windows.
    if (project.platformTarget?.toLowerCase() !== 'x86') {
        issues.push('not-x86');
    }
    // The debugger reads Portable PDBs only; old-style projects default to Windows PDBs.
    const debugType = project.debugType?.toLowerCase() ?? (project.sdkStyle ? 'portable' : 'full');
    if (debugType === 'full' || debugType === 'pdbonly') {
        issues.push('windows-pdb');
    }
    return issues;
}

/**
 * Sets an MSBuild property: every existing value is replaced; without one, it is added to the first property group
 * without a condition. Keeps the file's line endings.
 */
export function setProperty(text: string, name: string, value: string): string {
    const existing = new RegExp(`(<${name}>)[^<]*(</${name}>)`, 'gi');
    if (existing.test(text)) {
        return text.replace(existing, `$1${value}$2`);
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const group = /<PropertyGroup\s*>/i.exec(text);
    if (!group) {
        // No plain group at all: add one right after the <Project ...> element.
        const project = /<Project\b[^>]*>/i.exec(text);
        if (!project) {
            throw new Error('No <Project> element found.');
        }
        const at = project.index + project[0].length;
        return `${text.slice(0, at)}${eol}  <PropertyGroup>${eol}    <${name}>${value}</${name}>${eol}  </PropertyGroup>${text.slice(at)}`;
    }
    const at = group.index + group[0].length;
    return `${text.slice(0, at)}${eol}    <${name}>${value}</${name}>${text.slice(at)}`;
}

export interface LaunchConfiguration {
    name: string;
    type: string;
    request: 'launch' | 'attach';
    [key: string]: unknown;
}

/**
 * A launch configuration per executable project and target framework (the output that exists already, else the most
 * likely one) and one attach. `taskFor` names the build task to run first, if there is one.
 */
export function launchConfigurations(
    projects: ProjectInfo[], workspaceRoot: string, exists: (file: string) => boolean, taskFor: (project: ProjectInfo) => string | undefined,
): LaunchConfiguration[] {
    const executables = projects.filter((p) => p.executable);
    const several = executables.length > 1 || executables.some((p) => p.targetFrameworks.length > 1);
    const configs: LaunchConfiguration[] = [];
    for (const project of executables) {
        const dir = path.dirname(project.file);
        const rel = path.relative(workspaceRoot, dir).replace(/\\/g, '/');
        const base = rel ? `\${workspaceFolder}/${rel}` : '${workspaceFolder}';
        const task = taskFor(project);
        for (const tfm of project.targetFrameworks.length ? project.targetFrameworks : ['']) {
            const candidates = programCandidates(project, tfm);
            const program = candidates.find((c) => exists(path.join(dir, c))) ?? candidates[0];
            configs.push({
                name: several && tfm ? `${project.name} (${tfm}, x86)` : `${project.name} (x86)`,
                type: 'dotnet-x86',
                request: 'launch',
                ...(task ? { preLaunchTask: task } : {}),
                program: `${base}/${program}`,
                args: [],
                cwd: base,
                stopAtEntry: false,
            });
        }
    }
    configs.push({ name: 'Attach (.NET process)', type: 'dotnet-x86', request: 'attach', processId: '${command:pickProcess}' });
    return configs;
}

export interface X86Runtimes {
    /** The x86 dotnet folder in use (the first with a runtime). */
    root?: string;
    host?: string;
    /** Installed versions, newest first. */
    netCore: string[];
    windowsDesktop: string[];
}

/** The x86 .NET runtimes under the first of `roots` that has any (DOTNET_ROOT(x86), then Program Files (x86)\dotnet). */
export function findX86Runtimes(roots: string[]): X86Runtimes {
    const versions = (root: string, framework: string): string[] => {
        try {
            return fs.readdirSync(path.join(root, 'shared', framework)).filter((v) => /^\d/.test(v)).sort(compareVersions).reverse();
        } catch {
            return [];
        }
    };
    for (const root of roots) {
        const netCore = versions(root, 'Microsoft.NETCore.App');
        if (netCore.length) {
            const host = path.join(root, 'dotnet.exe');
            return { root, host: fs.existsSync(host) ? host : undefined, netCore, windowsDesktop: versions(root, 'Microsoft.WindowsDesktop.App') };
        }
    }
    return { root: undefined, host: undefined, netCore: [], windowsDesktop: [] };
}

/** Compares "10.0.5" style versions part by part as numbers ("10.0.5" > "9.0.12"); a non-numeric part counts as 0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) {
            return d;
        }
    }
    return 0;
}
