# .NET x86 Debugger for VS Code

Debug **32-bit (x86) .NET applications** — for example WinForms apps built with `<PlatformTarget>x86</PlatformTarget>` — in Visual Studio Code.

The C# extension's debugger (vsdbg) is shipped only for x64 / arm64, so it cannot debug 32-bit processes.
This extension bundles an **x86 build of [netcoredbg](https://github.com/Samsung/netcoredbg)** (MIT) and registers it as the `dotnet-x86` debug type.

[日本語](README.jp.md)

## Requirements

- Windows (x64)
- The **x86 .NET runtime** for your app, e.g. *.NET Desktop Runtime (x86)* for WinForms / WPF
  (installed under `C:\Program Files (x86)\dotnet`)
- A .NET SDK to build your project

## Installation

1. Download `dotnet-x86-debugger-<version>.vsix` and `install-vsix.ps1` from
   [Releases](https://github.com/takahino/vscode-dotnet-x86-debugger/releases) into the same folder.
2. Run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File install-vsix.ps1
   ```

   Alternatively, run **Extensions: Install from VSIX...** in VS Code and select the `.vsix`.

3. Reload VS Code (**Developer: Reload Window**).

## Usage

1. Make your project 32-bit:

   ```xml
   <PropertyGroup>
     <TargetFramework>net10.0-windows</TargetFramework>
     <PlatformTarget>x86</PlatformTarget>
   </PropertyGroup>
   ```

2. Add a configuration to `.vscode/launch.json`:

   ```jsonc
   {
     "name": ".NET x86 Launch",
     "type": "dotnet-x86",
     "request": "launch",
     "preLaunchTask": "build",
     "program": "${workspaceFolder}/bin/x86/Debug/net10.0-windows/MyApp.exe",
     "args": [],
     "cwd": "${workspaceFolder}",
     "stopAtEntry": false
   }
   ```

   To attach to a running process:

   ```jsonc
   {
     "name": ".NET x86 Attach",
     "type": "dotnet-x86",
     "request": "attach",
     "processId": "${command:pickProcess}"
   }
   ```

3. Press F5.

See [`samples/WinFormsX86`](samples/WinFormsX86) for a complete example including `tasks.json`.

### Launch options

| Option | Description |
|---|---|
| `program` | Path to the x86 `.exe`. A framework-dependent `.dll` is also accepted and is started with the x86 `dotnet.exe`. |
| `args` | Command line arguments. |
| `cwd` | Working directory. |
| `env` | Environment variables. |
| `stopAtEntry` | Break at the entry point. |
| `justMyCode` | Only debug user code (default `true`). |
| `enableStepFiltering` | Step over properties and operators (default `true`). |

### Settings

| Setting | Description |
|---|---|
| `dotnetX86.debuggerPath` | Use another x86 `netcoredbg.exe` instead of the bundled one. |
| `dotnetX86.dump.maxDepth` | Nesting depth expanded by *Dump Variable* (default `3`). |
| `dotnetX86.dump.maxNodes` | Stop expanding once this many values have been collected (default `2000`). |

### Dump Variable

While stopped, right-click a variable in the **Variables** view and choose **Dump Variable**,
or run **.NET x86: Dump Expression...** from the Command Palette, to open the whole object as JSON in an editor.

```json
{
  "p": {
    "$type": "Person",
    "Name": "Alice",
    "Friends": [ { "$type": "Person", "Name": "Bob" } ],
    "Scores": { "math": 90 }
  }
}
```

- `List<T>` and `Dictionary<TKey, TValue>` are shown as their items, like Visual Studio's *Results View*.
- Static members, explicit interface implementations and indexers are omitted.
- Property getters run while dumping, as in the Variables view. Large objects such as a `Form` hit the limits above
  (a notification tells you so); raise them in the settings if needed.

## Limitations

- **.NET Framework is not supported.** netcoredbg supports .NET (Core) / .NET 5+ only.
- The debuggee always runs with its output in the Debug Console (`console: integratedTerminal` is not available).
- Windows only.

## Building from source

Prerequisites: Node.js, Git, a .NET SDK, and Visual Studio 2022 or later with the *Desktop development with C++* workload.

```powershell
# Build netcoredbg for x86 (into debugger\netcoredbg-x86), compile, package the VSIX and install it into VS Code
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# Only create the VSIX (out\dotnet-x86-debugger.vsix)
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipInstall
```

`scripts\build-netcoredbg.ps1` clones netcoredbg (pinned tag) and only the required parts of `dotnet/runtime`
into a short working directory (`%LOCALAPPDATA%\ncdbg` by default) to stay under the Windows `MAX_PATH` limit.
Local fixes to netcoredbg are kept in [`patches/netcoredbg`](patches/netcoredbg) and applied automatically.

To debug the extension itself, open this folder in VS Code and run **Run Extension** (F5).

## Releasing

1. Update `version` in `package.json` and `CHANGELOG.md`, and commit.
2. Push a tag that matches the version:

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

The [Release workflow](.github/workflows/release.yml) builds netcoredbg (x86), packages the VSIX and creates a GitHub Release
with `dotnet-x86-debugger-<version>.vsix` and `install-vsix.ps1`.
Running the workflow manually (*workflow_dispatch*) only uploads the files as a build artifact.

## License

[MIT](LICENSE). Bundled third-party components are listed in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).

