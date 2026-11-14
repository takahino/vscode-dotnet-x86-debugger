# .NET x86 Debugger for VS Code

Debug **32-bit (x86) .NET applications** — for example WinForms apps built with `<PlatformTarget>x86</PlatformTarget>` — in Visual Studio Code.

The C# extension's debugger (vsdbg) is shipped only for x64 / arm64, so it cannot debug 32-bit processes.
This extension bundles an **x86 build of [netcoredbg](https://github.com/Samsung/netcoredbg)** (MIT) and registers it as the `dotnet-x86` debug type.

[日本語](README.jp.md) · **New to it? Read the [illustrated guide](https://takahino.github.io/vscode-dotnet-x86-debugger/usage.html)** ([docs/usage.html](docs/usage.html))

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

   The process list shows only x86 .NET processes (with their window titles); choose *Show all processes...* for the rest.
   To attach as soon as an app starts (e.g. one launched by another program), give its name instead:

   ```jsonc
   {
     "name": ".NET x86 Attach (wait for process)",
     "type": "dotnet-x86",
     "request": "attach",
     "processName": "MyApp",
     "waitTimeout": 120
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
| `dotnetX86.stepHistory.enabled` | Record every stop in the Step History view (default `true`). |
| `dotnetX86.exceptionLog.enabled` | Record every thrown exception in the Exception Log view without stopping (default `true`). |
| `dotnetX86.perfTips.enabled` | Show the elapsed time at the stopped line after a step / continue (default `true`). |
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

### Inline values

While stopped, values are shown at the end of the lines of the current method, like Visual Studio's inline values:
locals and parameters, and fields (`_count`, `this._count`). Properties are not shown, since reading them runs getters.
Turn this off with the VS Code setting `debug.inlineValues`.

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

### Step history

The **Step History (.NET x86)** view in Run and Debug records the location and the local variables at every stop,
newest first. Values that changed since the previous stop in the same method are marked *changed* / *new*, so you can
look back at "the value three steps ago" (it is a history to browse; execution does not run backwards).
Click an entry to open its location. Turn it off with `dotnetX86.stepHistory.enabled`.

### Value trend

Right-click a line in a C# file and choose **Track Value at This Line...**, then enter expressions separated by `;`
(e.g. `total; items.Count`). Each time the line runs, the values are recorded without stopping and charted hit by hit,
one small chart per expression (**.NET x86: Show Value Trend**). It is a logpoint whose message starts with `#track:`,
so it is removed like any breakpoint.

### Hit count breakpoints

Edit a breakpoint and choose **Hit Count**, then enter `5` or `==5` (stop on the 5th hit), `>=5` / `>5`
(from the 5th / after the 5th hit) or `%5` (every 5th hit). It can be combined with a condition (hits are counted
only when the condition is true) and with a log message.

### Temporary, dependent and when-changed breakpoints

Right-click a line in a C# editor:

- **Add Temporary Breakpoint** — stops once, then the breakpoint removes itself (condition `#once`).
- **Add Dependent Breakpoint...** — active only after the program has stopped at another breakpoint you pick (condition `#after File.cs:12`).
- **Add Breakpoint When Value Changes...** — stops only when an expression has a different value than the last time the line ran; the old and new values are written to the Debug Console (condition `#changed expr`).

You can also type these markers as the condition of any breakpoint. They can be combined with a hit count.

### Pinned values

Right-click a line and choose **Pin Value to Line...** to show an expression at the end of that line. It is evaluated
again in the selected stack frame every time the program stops, and the pins are kept with the workspace.
Use **Unpin Value from Line** or **Clear All Pinned Values** to remove them.

### WinForms Controls view

While stopped, the **WinForms Controls** view in Run and Debug lists `Application.OpenForms` and their controls as a tree
(name, type and text; hidden controls are greyed out). Hover a control for its bounds, enabled state, dock and tab index.
Right-click it to **Dump Control** or **Copy Expression** (e.g. `System.Windows.Forms.Application.OpenForms[0].Controls[1]`,
which you can paste into the Watch view). Every value is read by evaluating an expression, so children are read only when
you expand a node.

### Debug session report

Run **.NET x86: Export Debug Session Report** (or the button in the Step History view title) to open a Markdown report of
the last session: program, start / end time and exit code, every stop with the values that changed, the exceptions
(with a count per type), section timings (min / avg / max), tracked values and the modules with symbols. Save it or paste
it into a bug report.

### Debug.WriteLine

Output from `Debug.WriteLine`, `Trace.WriteLine` and `Debugger.Log` appears in the Debug Console, with a link to the source line.

### Exception breakpoints

The Breakpoints view shows **All Exceptions (when thrown)** and **User-Unhandled Exceptions**. Right-click one and
choose **Edit Condition** to limit it to exception types, e.g. `System.NullReferenceException, System.InvalidOperationException`;
start with `!` to break on every type except those.

### Memory / CPU graph

Run **.NET x86: Show Memory / CPU Graph** from the Command Palette (or set `dotnetX86.memoryGraph.autoOpen` to `true`)
to see the debuggee's **Private Bytes** and **Working Set**, plus its **CPU usage** (% of all cores, as in Task Manager)
in a second chart, once per second, like the process memory / CPU graphs of Visual Studio's Diagnostic Tools. Periods stopped at a breakpoint or step are shaded; hover to read the values,
and open *Data table* for the latest samples.

### Break on Value Change

Right-click a field, property or local variable in the Variables view and choose **Break on Value Change**.
Execution stops right after the value changes, showing `old → new`. netcoredbg has no data breakpoints, so this is
emulated: the extension finds the lines of the workspace's C# files that assign that name (`x = …`, `x += …`, `x++`, …),
checks the value before and after each of them, and stops only when it changed. Writes through `ref` / `out`,
from other objects (`other.x = …`) or from code outside the workspace are not detected.

### Set Next Statement

While stopped, right-click a line of the method that is executing and choose **Jump to Cursor** (Set Next Statement)
to move execution there: run a line again or skip lines, as in Visual Studio. Lines outside the executing method,
or moving into / out of a catch / finally block, are refused.

### PerfTips

After a step or continue, the stopped line shows the elapsed time (e.g. `≤ 12 ms elapsed`). It includes the debugger's
own overhead, hence "≤".

### Section timing

Right-click a line and choose **Start Timer Here...**, then right-click a later line and choose **End Timer Here...**.
Each pass from start to end is measured without stopping and charted in the **Value Trend** view (`⏱ name (ms)`),
also written to the Debug Console. Each pass includes a few milliseconds of debugger overhead.

### Exception log

The **Exception Log (.NET x86)** view lists every exception thrown in the debuggee, including ones that are caught
and swallowed, with type, message and the first location in your code (click to open it). They are also written to the
Debug Console like Visual Studio's `Exception thrown: …` lines. Execution only stops where your exception settings say so.
Apps that throw very many exceptions run slower while it is on (`dotnetX86.exceptionLog.enabled`).

### Autos and Modules views

- **Autos (.NET x86)**: the variables used on the current and the previous line of the selected frame, as in Visual Studio.
- **Modules (.NET x86)**: the loaded assemblies and whether their symbols (PDB) were loaded; right-click to copy the path
  or reveal the file.

### More commands in the Variables view context menu

| Command | What it does |
|---|---|
| **View as Table** | Shows a `List<T>`, array, `Dictionary` or `DataTable` as a table: click a header to sort, filter rows, and copy or save it as CSV. Object items get one column per member; dates are shown with `ToString()`. Up to 1,000 rows of a DataTable are read. |
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

