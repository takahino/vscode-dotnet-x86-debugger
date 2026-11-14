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
| `dotnetX86.trace` | Troubleshooting: log the debug adapter traffic to the *.NET x86 Debugger* output channel and write a netcoredbg log (its path is shown there). |
| `dotnetX86.memoryGraph.autoOpen` | Open the memory graph automatically when debugging starts (default `false`). |
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

### DebuggerDisplay

Types with `[DebuggerDisplay("Name = {Name}, Age = {Age}")]` are shown with that text in the Variables view,
hovers and the Watch view, as in Visual Studio (`List<T>` shows `Count = 3`). Member access and method calls work,
`,nq` removes the quotes around strings, and the attribute is inherited. Expressions are evaluated relative to the
object, so complex expressions (operators, casts) fall back to the default `{Type}` text.

### Logpoints

Right-click the editor gutter and choose **Add Logpoint...**, then enter a message such as
`i={i} total={total} in $FUNCTION`. Each time the line runs, the message is written to the Debug Console
and execution continues without stopping. `{expression}` is evaluated in the current frame;
`$FUNCTION` and `$TID` are replaced with the method name and thread id. A condition can be combined with a logpoint.

### Hit count breakpoints

Edit a breakpoint and choose **Hit Count**, then enter `5` or `==5` (stop on the 5th hit), `>=5` / `>5`
(from the 5th / after the 5th hit) or `%5` (every 5th hit). It can be combined with a condition (hits are counted
only when the condition is true) and with a log message.

### Exception breakpoints

The Breakpoints view shows **All Exceptions (when thrown)** and **User-Unhandled Exceptions**. Right-click one and
choose **Edit Condition** to limit it to exception types, e.g. `System.NullReferenceException, System.InvalidOperationException`;
start with `!` to break on every type except those.

### Memory graph

Run **.NET x86: Show Memory Graph** from the Command Palette (or set `dotnetX86.memoryGraph.autoOpen` to `true`)
to see the debuggee's **Private Bytes** and **Working Set** once per second, like the process memory graph of
Visual Studio's Diagnostic Tools. Periods stopped at a breakpoint or step are shaded; hover to read the values,
and open *Data table* for the latest samples.

### More commands in the Variables view context menu

| Command | What it does |
|---|---|
| **Copy as C# Initializer** | Copies the value as C# code (`var order = new Order { Note = "...", People = new List<Person> { ... } };`), handy for test data. Only PascalCase members are emitted; get-only properties are included too, so delete them if the code does not compile. |
| **View String (JSON / XML / HTML / Text)** | Opens a `string` variable in an editor, pretty-printed when it contains JSON, XML or HTML (auto-detected, or pick the format). |
| **Take Snapshot** / **Compare with Snapshot** | Records the variable, then shows a diff against its current value after you step or continue — find out what changed and where. |

### Display language

Menus, settings and messages are shown in English, or in Japanese when VS Code's display language is Japanese
(e.g. with the Japanese Language Pack).

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

