import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { compareVersions, findX86Runtimes, launchConfigurations, parseProject, programCandidates, projectIssues, setProperty } from '../../projectSetupCore';

const SDK = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
  </PropertyGroup>
</Project>
`;

const OLD_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <AssemblyName>LegacyApp</AssemblyName>
    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>
  </PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)|$(Platform)' == 'Debug|x86' ">
    <PlatformTarget>x86</PlatformTarget>
    <DebugType>full</DebugType>
    <OutputPath>bin\\x86\\Debug\\</OutputPath>
  </PropertyGroup>
</Project>
`;

describe('parseProject', () => {
    it('reads an SDK-style project', () => {
        const p = parseProject('C:/src/App/App.csproj', SDK);
        assert.deepEqual(
            { name: p.name, sdkStyle: p.sdkStyle, executable: p.executable, tfms: p.targetFrameworks, platform: p.platformTarget },
            { name: 'App', sdkStyle: true, executable: true, tfms: ['net10.0-windows'], platform: undefined },
        );
    });

    it('reads several target frameworks and the runtime identifier', () => {
        const p = parseProject('C:/src/App/App.csproj', SDK.replace('<TargetFramework>net10.0-windows</TargetFramework>',
            '<TargetFrameworks>net10.0-windows;net48</TargetFrameworks><RuntimeIdentifier>win-x86</RuntimeIdentifier><AssemblyName>Tool</AssemblyName>'));
        assert.deepEqual([p.name, p.targetFrameworks, p.runtimeIdentifier], ['Tool', ['net10.0-windows', 'net48'], 'win-x86']);
    });

    it('reads an old-style .NET Framework project', () => {
        const p = parseProject('C:/src/Legacy/Legacy.csproj', OLD_STYLE);
        assert.deepEqual(
            { name: p.name, sdkStyle: p.sdkStyle, tfms: p.targetFrameworks, platform: p.platformTarget, debugType: p.debugType, out: p.outputPath },
            { name: 'LegacyApp', sdkStyle: false, tfms: ['net48'], platform: 'x86', debugType: 'full', out: 'bin/x86/Debug/' },
        );
    });

    it('treats a project without OutputType as a library', () => {
        assert.equal(parseProject('C:/src/Lib/Lib.csproj', SDK.replace('<OutputType>WinExe</OutputType>', '')).executable, false);
    });
});

describe('programCandidates', () => {
    it('lists the x86 platform folder first, then the default one', () => {
        assert.deepEqual(programCandidates(parseProject('C:/src/App/App.csproj', SDK), 'net10.0-windows'),
            ['bin/x86/Debug/net10.0-windows/App.exe', 'bin/Debug/net10.0-windows/App.exe']);
    });

    it('adds the runtime identifier folder', () => {
        const p = parseProject('C:/src/App/App.csproj', SDK.replace('</UseWindowsForms>', '</UseWindowsForms><RuntimeIdentifier>win-x86</RuntimeIdentifier>'));
        assert.deepEqual(programCandidates(p, 'net10.0-windows')[0], 'bin/x86/Debug/net10.0-windows/win-x86/App.exe');
    });

    it('uses the output path of an old-style project', () => {
        assert.deepEqual(programCandidates(parseProject('C:/src/Legacy/Legacy.csproj', OLD_STYLE), 'net48'), ['bin/x86/Debug/LegacyApp.exe']);
    });
});

describe('projectIssues', () => {
    it('reports a project that does not run as x86', () => {
        assert.deepEqual(projectIssues(parseProject('C:/src/App/App.csproj', SDK)), ['not-x86']);
    });

    it('reports a Windows PDB', () => {
        assert.deepEqual(projectIssues(parseProject('C:/src/Legacy/Legacy.csproj', OLD_STYLE)), ['windows-pdb']);
    });

    it('has nothing to say about a ready project', () => {
        const p = parseProject('C:/src/App/App.csproj', SDK.replace('</OutputType>', '</OutputType><PlatformTarget>x86</PlatformTarget>'));
        assert.deepEqual(projectIssues(p), []);
    });
});

describe('setProperty', () => {
    it('adds the property to the first unconditional property group', () => {
        const text = setProperty(SDK, 'PlatformTarget', 'x86');
        assert.match(text, /<PropertyGroup>\n {4}<PlatformTarget>x86<\/PlatformTarget>\n {4}<OutputType>/);
        assert.equal(parseProject('C:/a/A.csproj', text).platformTarget, 'x86');
    });

    it('changes every existing value', () => {
        const text = setProperty(OLD_STYLE, 'DebugType', 'portable');
        assert.equal(parseProject('C:/a/A.csproj', text).debugType, 'portable');
        assert.doesNotMatch(text, /<DebugType>full/);
    });

    it('keeps CRLF line endings', () => {
        assert.match(setProperty(SDK.replace(/\n/g, '\r\n'), 'PlatformTarget', 'x86'), /<PropertyGroup>\r\n {4}<PlatformTarget>x86<\/PlatformTarget>\r\n/);
    });
});

describe('launchConfigurations', () => {
    const root = 'C:/src';
    it('makes one launch per executable project and target framework, plus attach', () => {
        const app = parseProject('C:/src/App/App.csproj', SDK.replace('<TargetFramework>net10.0-windows</TargetFramework>', '<TargetFrameworks>net10.0-windows;net48</TargetFrameworks>'));
        const lib = parseProject('C:/src/Lib/Lib.csproj', SDK.replace('<OutputType>WinExe</OutputType>', ''));
        const configs = launchConfigurations([app, lib], root, () => false, () => 'build');
        assert.deepEqual(configs.map((c) => [c.name, c.request, c.program]), [
            ['App (net10.0-windows, x86)', 'launch', '${workspaceFolder}/App/bin/x86/Debug/net10.0-windows/App.exe'],
            ['App (net48, x86)', 'launch', '${workspaceFolder}/App/bin/x86/Debug/net48/App.exe'],
            ['Attach (x86 .NET process)', 'attach', undefined],
        ]);
        assert.equal(configs[0].cwd, '${workspaceFolder}/App');
        assert.equal(configs[0].preLaunchTask, 'build');
    });

    it('prefers an output that already exists', () => {
        const app = parseProject('C:/src/App.csproj', SDK);
        const [launch] = launchConfigurations([app], root, (p) => p === path.join('C:/src', 'bin/Debug/net10.0-windows/App.exe'), () => undefined);
        assert.equal(launch.program, '${workspaceFolder}/bin/Debug/net10.0-windows/App.exe');
        assert.equal(launch.cwd, '${workspaceFolder}');
        assert.equal('preLaunchTask' in launch, false);
    });
});

describe('findX86Runtimes', () => {
    it('lists the runtime versions under the x86 dotnet folders, newest first', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x86rt-'));
        try {
            for (const v of ['8.0.11', '10.0.1']) {
                fs.mkdirSync(path.join(dir, 'shared', 'Microsoft.NETCore.App', v), { recursive: true });
            }
            fs.mkdirSync(path.join(dir, 'shared', 'Microsoft.WindowsDesktop.App', '10.0.1'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'dotnet.exe'), '');
            assert.deepEqual(findX86Runtimes([path.join(dir, 'missing'), dir]), {
                root: dir, host: path.join(dir, 'dotnet.exe'), netCore: ['10.0.1', '8.0.11'], windowsDesktop: ['10.0.1'],
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('has no root when nothing is installed', () => {
        assert.deepEqual(findX86Runtimes([]), { root: undefined, host: undefined, netCore: [], windowsDesktop: [] });
    });
});

describe('compareVersions', () => {
    it('compares the parts as numbers', () => {
        assert.ok(compareVersions('10.0.5', '9.0.12') > 0);
        assert.ok(compareVersions('8.0.2', '8.0.11') < 0);
    });
});
