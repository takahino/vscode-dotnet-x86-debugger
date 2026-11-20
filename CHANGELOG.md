# Changelog

## 2.0.0

- **New debug engine.** The extension bundles **dotnet-x86dbg** (Rust), a debug engine made for it, instead of netcoredbg. It speaks the
  same DAP and writes values the same way, so every feature works as before; the differences are listed in the README
  ("Differences from netcoredbg (1.x)"). `dotnetX86.debuggerPath` can still point at a netcoredbg.exe (x86 programs).
- New: **x64 and AnyCPU programs.** The engine of the program's bitness is started (an x86 and an x64 engine are bundled): an exe
  runs as it was built, a framework-dependent `.dll` in the dotnet.exe of `architecture` (`x86` by default, or `x64`), and attach
  picks the engine from the process. The process picker lists x86 and x64 .NET processes. The "will run as a 64-bit process"
  warning is gone; the environment check still offers to make a project x86.
- New: **.NET Framework apps without .NET.** The debugger itself no longer needs the x86 .NET runtime (8 or later).
- New: **self-contained single-file apps** can be debugged (when the same .NET runtime version is on the machine).
- New: **expressions with the C# compiler's values and types** — lambdas and LINQ, patterns and `switch` expressions, tuples,
  pointers, generic type arguments of the current method, `await` (waited synchronously), user-defined operators and conversions.
- New: **Change Property...** can change enum properties (`Dock`, `Anchor`): type a member name, or names joined with commas.
- New: `expressionEvaluationOptions.allowImplicitFuncEval` in launch.json (also attach): when false, the Variables view does not run
  property getters and `ToString()` by itself; they run when expanded.
- New: the program's non-ASCII output (Japanese, ...) is read in the console code page instead of being garbled; `DateTime`,
  `TimeSpan`, `Guid` and the like show their `ToString()`; `DebuggerDisplay` also applies to values inside; `DebuggerBrowsable` and
  `DebuggerTypeProxy` of your own types are honored (the original members under Raw View).
- New: **engine API document** — [docs/engine-api.html](docs/engine-api.html) and its JSON Schema, generated from `src/engineProtocol.ts`
  with `npm run docs:api`; a unit test keeps them up to date.
- New: **AI clients (MCP)** — with `dotnetX86.mcp.enabled` (off by default), AI assistants debug the session through MCP: breakpoints,
  stepping, the stack, variables and expressions, and the program's windows (list, screenshot even while stopped, buttons, text,
  mouse and keys). VS Code's AI sees it as the MCP server *.NET x86 Debugger* (VS Code 1.101 or later) and Cursor's AI as *dotnet-x86*;
  **Register the MCP Server with AI Clients** registers it with Claude Code, GitHub Copilot CLI, Codex, Gemini CLI, Claude
  Desktop, Cursor, Windsurf, LM Studio and opencode; **Copy MCP Connection Settings for AI Clients** gives the settings for
  others.
- New: **Edit and Continue** — edit a C# source while debugging and save (or **Apply Code Changes** on the debug toolbar): the
  change is applied without restarting. Changed methods run the new code from their next call, and a stopped method moves to
  the new code at its next statement; methods, fields, properties and classes can be added (.NET and .NET Framework). Changes
  that need a restart and compile errors are shown with their place. Debug builds started by the debugger; needs the .NET SDK 9
  or later. `dotnetX86.editAndContinue.enabled`, `dotnetX86.editAndContinue.applyOnSave`; MCP tool `debug_apply_changes`.
- New: **debugging programs without symbols** — the engine decompiles the program's assemblies that have no PDB to C# by itself
  when you stop or step into them, so an exe shipped without symbols can be debugged in C# (breakpoints, stepping, locals) in the
  same session, with no .NET runtime needed. `decompile` in launch.json and attach (`app` by default, `off`); MCP tool `decompile`.
  The Modules view marks them *decompiled*.
- Changed: **the engine does the extras itself** — logpoints, hit counts and the breakpoint markers (`#once`, `#after`, `#changed`,
  `#caller`), Step Into Target, Break on Value Change, the SQL log, the exception log, the event trace, the UI freeze watch and the
  memory graph's readings, which the extension's relay and PowerShell helpers did. They work the same, with fewer round trips at
  each stop and no PowerShell; Step Into Target lists the calls from the compiled code (also in decompiled sources), and AI clients
  get them through MCP too (`sql_log`, `exception_log`, `event_trace`, `ui_freeze`, `process_usage`). With a netcoredbg in
  `dotnetX86.debuggerPath` the relay still does them.
- New: **crash dumps** — `dumpPath` in launch.json (snippet ".NET x86: Open Crash Dump") opens a .dmp written with full memory
  (Task Manager, WER LocalDumps, procdump -ma) as a stopped program: threads, call stacks with source lines, variables,
  the exception and the heap. It cannot continue, step or run functions. A 32-bit process written by a 64-bit tool opens
  in the x86 engine. No .NET runtime is needed to open a .NET Framework dump.
- New: **child processes** — `childProcesses` in launch.json (also attach): `record` (default) logs the processes the program starts
  with `Process.Start`; `follow` also debugs a .NET child in its own session, from its first line (the child waits until the
  debugger is attached; a .NET Framework child is attached once its runtime has loaded). The engine picks the child's bitness.
- Removed: **Decompile for Debugging** and **Delete Decompiled Symbols** (the bundled ILSpy helper, which needed a .NET 8 runtime and
  worked from the next session). The engine decompiles by itself instead; the symbols the helper left in the extension's storage are
  deleted on first start.
- Docs: README, the illustrated guide and CONTRIBUTING describe the new engine; the README lists the differences from Visual Studio
  and from netcoredbg.
- Build: `scripts/build-engine.ps1` replaces `scripts/build-netcoredbg.ps1` and the netcoredbg patches; CI and the release workflow
  build the engine (`ENGINE_REF`), and CI runs the E2E tests with both the x86 and the x64 engine (`DOTNETX86_E2E_ARCH=x64`).
## 1.2.1

- New: **SQL Log** view — every SQL statement the program runs through an ADO.NET provider (ODP.NET managed / unmanaged, SqlClient, OleDb, Odbc), without stopping: the statement, its parameter values, the caller and the call stack. **Copy SQL with Parameter Values** gives the statement with the values filled in (Oracle `BindByName = false` honored), **Export SQL Log** writes a `.sql` file, and a statement that runs five times or more is flagged (N+1). It hooks the provider, so statements run by a home-made data access component are logged too. `dotnetX86.sqlLog.enabled`, `dotnetX86.sqlLog.methods`.
- New: **Trace Events...** (WinForms Controls right-click) and the **Event Trace** view — which control's event fired, in what order and how far apart, without stopping (`sender`, handler, time, gap); export to a text file. `dotnetX86.eventTrace.enabled`.
- New: **Capture Evidence** — a picture of every open form (the compositor's image of the stopped windows), the control values (including the first cells of DataGridViews), the variables, the call stack and the SQL since the previous capture, saved as `evidence.md` and PNG files in `evidence/<date-time>/`. `dotnetX86.evidence.enabled`, `dotnetX86.evidence.folder`.
- New (netcoredbg patch 0013): function breakpoints can be set with `anyCode`, which also binds in code without symbols and outside Just My Code (at the method entry); `this` and the arguments can be evaluated there. A stop at one does not end a step in progress.
- Tests: unit tests for the SQL log, evidence capture, PE headers, decompiled-symbol manifests, the Source Link map, test-value capture, dumps and event keys; the DAP relay's own logic (logpoints, hit counts, the `#once` / `#caller` / `#changed` markers, value tracking, section timing, the exception log, the SQL log's and the event trace's hidden breakpoints) is now unit-tested against a scripted stand-in for netcoredbg (136 → 207 unit tests).
- Docs: the illustrated guide (English / Japanese) covers the SQL log, evidence capture and the event trace, and its feature list the data bindings, GDI / USER objects and GDI leak candidates; CONTRIBUTING describes how the unit tests are organized.
- New: every feature can be turned off (all on by default) with `dotnetX86.<feature>.enabled`: memoryGraph, inlineValues, autos, modules, exceptionSettings, winforms, heapSnapshot, parallelStacks, valueTrend, pinnedValues, breakpointCommands, variableTools, generateTest, sessionReport. Off removes the views, menu entries and commands, and stops the background work. `stepHistory.enabled` and `exceptionLog.enabled` now hide their views too.

## 1.1.0

- New: **GDI leak candidates** in the Heap Snapshots panel — objects holding native resources (GDI+ fonts, brushes, pens, images, graphics, regions, paths; icons, cursors, windows) per type, how many are not disposed, and the change between two snapshots; growing ones are marked as leak candidates. .NET and .NET Framework (netcoredbg patch 0012, `dotnetX86.handleStats`).
- New: **Show Data Bindings** (WinForms Controls view title / right-click) — a table of the data bindings of the open forms or of a control: simple bindings with the value in the control and in the current item side by side, the position, update mode and format; list bindings (DataSource / DisplayMember / ValueMember) with the selected value. Bindings that are not connected, and controls that show something else than their item holds, are flagged.
- New: the memory / CPU graph also charts **GDI / USER objects** and **handles** (with the per-process limit once a count passes half of it), and for x86 processes the **32-bit address space** in use against its 2 GB / 4 GB limit with the largest free block. Warnings at 80 % of the GDI / USER limit and when the address space is nearly full. The sampler is now `resources/processSampler.ps1`.

## 1.0.0

- New: extension **icon**, and a rewritten README (Marketplace page): quick start, highlights, a feature table by category with pictures; the feature descriptions are grouped the same way. Building, tests and releasing moved to CONTRIBUTING.md.
- New: **Getting Started** walkthrough (Welcome page / **.NET x86: Getting Started**) — check the environment, make the project x86, create launch.json, start debugging.
- New: **Check Environment** — the x86 .NET Runtime / Desktop Runtime, the .NET SDK, and whether each project builds as x86 with a Portable PDB, with one-click fixes of the project file.
- New: **Generate launch.json** — launch configurations from the `.csproj` files (per project and target framework, with the real output path), an attach configuration and a `build` task. F5 without a launch.json does the same instead of inserting a template.
- New: **Heap Snapshots** — objects and bytes per type on the GC heap while stopped, and the change between any two snapshots (sort, filter, increases only), as in Visual Studio's Memory Usage. A garbage collection runs first (`dotnetX86.heapSnapshot.collectGarbage`); netcoredbg patch 0011.
- New: **Parallel Stacks** — all threads' call stacks merged into boxes, as in Visual Studio (Call Stack context menu / Command Palette).
- New: **Freeze / Thaw Thread** — a frozen thread stays suspended when the program continues, also across expression evaluation; shown as `[frozen]` (netcoredbg patch 0010).
- New: **Source Link** — when the program stops in a file that is not on this machine, it is downloaded through the PDB's Source Link map and opened (`dotnetX86.sourceLink.enabled`).
- New: **Download Symbols** (Modules view) — fetches the PDB of an assembly without symbols from the NuGet / Microsoft symbol servers (`dotnetX86.symbolServers`).
- Fix: symbols from **Decompile for Debugging** were not found by the debugger in a real session (the cache folder was given to netcoredbg after it had started).
- New: **Exception snapshots** — each Exception Log entry expands into the call stack and the locals of the first frames of your code at the throw (`dotnetX86.exceptionLog.captureLocals`).
- New: **Break on Event...** in the WinForms Controls view — lists the handlers attached to a control's events (lambdas too) and adds function breakpoints on the picked ones.
- New: **Change Property...** in the WinForms Controls view — change a control's text, visibility, colors, position or size (or any property with a C# expression) in the stopped program. Enum properties cannot be changed (netcoredbg cannot pass enum values).
- New: **View as Image** (Variables / Watch context menu) — shows a System.Drawing Image / Bitmap / Icon as a picture with zoom, size and pixel format.
- New: **Exception Settings** view — check the exception types to stop on when thrown, grouped by namespace as in Visual Studio; add your own, or from an Exception Log entry. Applies at once, also while running.
- Tests: unit tests (`npm test`) and end-to-end tests against the real netcoredbg (`npm run test:e2e`), run by a new CI workflow on every push; the release workflow runs the unit tests before packaging.
- Fix: a parameter without a modifier no longer carries an empty `modifier` field in the generated test's signature data.

## 0.9.0

- New: **Decompile for Debugging** (Modules view) — an assembly without symbols is decompiled with the bundled ILSpy engine into C# with matching symbols, so you can step into it and set breakpoints in it from the next session. Kept in the extension's storage by assembly MVID (netcoredbg patch 0009 loads them from there).
- New: **Step Into Target** (Step Into Specific) — pick which call of the line to step into, listed in the order they run. Emulated with a temporary function breakpoint during a step over.
- New: **Make Object ID** (Variables / Watch context menu) — `$1`, `$2`, ... reach the same object from any method and later stops, in Watch, the Debug Console and breakpoint conditions; the Variables view marks it `{$1}` (netcoredbg patch 0008: weak GC handles, as in Visual Studio).
- New: **Generate Unit Test from Here** (Call Stack context menu) — a test that calls the selected method again with its current arguments and object, in the workspace's test framework (xUnit / NUnit / MSTest).
- New: **UI freeze detection** — when a UI thread does not process window messages for 2 s (`dotnetX86.uiFreeze.thresholdMs`), the program is paused on that thread to show what holds the UI up.
- New: **Highlight on Screen** in the WinForms Controls view (eye icon) — frames the control on the screen with its name and size. The stopped form is shown in front from the desktop compositor's image, so it works even when the form is behind VS Code.
- New: **Caller-filtered breakpoints** (`#caller Orders.Save`, or `#caller !Name` to exclude) — stop only when the line is reached through one of the methods. Editor context menu: *Add Breakpoint Filtered by Caller...*.

## 0.8.0

- New: **`sourceFileMap` / `sourceSearchPaths`** — debug referenced assemblies whose PDB records source paths that do not exist on this machine: replace path prefixes (`/_/` included), or give parent folders to search. Also as `dotnetX86.*` settings for every configuration. The Debug Console says which path to map when a stop has no source.

## 0.7.0

- New: **.NET Framework 4.x** apps (x86) can be launched and attached to, as .NET apps can (netcoredbg patch). The debugger needs the x86 .NET runtime (8 or later) for itself, and the app must produce Portable PDBs; a warning tells how to switch when it finds a Windows PDB.
- The process picker also lists 32-bit .NET Framework processes.

## 0.6.0

- New: **Temporary**, **dependent** and **when-changed** breakpoints (editor context menu, or `#once`, `#after File.cs:12`, `#changed expr` as the condition).
- New: **Pinned values** — pin an expression to an editor line; it is evaluated again every time the program stops.
- New: **WinForms Controls** view — the tree of open forms and their controls (name, type, text, hidden ones greyed out; bounds, enabled, dock and tab index in the tooltip). Right-click a control to dump it or copy its expression.
- New: **Export Debug Session Report** — a Markdown summary of the last session: stops with the values that changed, exceptions, section timings, tracked values and modules (button in the Step History view, or the Command Palette).
- New: **Return values** — after Step Over or Step Out, the values returned by the methods that were called appear at the top of Variables and Autos as `Type.Method returned` (netcoredbg patch).
- Docs: `Debug.WriteLine` / `Trace.WriteLine` output already appears in the Debug Console.

## 0.5.0

- New: **Set Next Statement** (Jump to Cursor / "Set Next Statement" in the editor while stopped) within the executing method (netcoredbg patch 0005).
- New: **Break on Value Change** (Variables view context menu) for fields, properties and locals. netcoredbg has no data breakpoints, so it is emulated: hidden breakpoints at the workspace lines that assign the name, stepping over each and stopping only when the value changed.
- New: **Section timing**: "Start Timer Here..." / "End Timer Here..." measure the time between two lines on every pass (charted in Value Trend).
- New: **Exception log**: every thrown exception (also caught ones) is listed in a view and the Debug Console without stopping; your exception settings still decide where to stop.
- New: **Autos** view: variables used on the current and previous line of the selected frame.
- New: **PerfTips**: elapsed time since the last step / continue at the end of the stopped line.
- New: the attach process picker lists only x86 .NET processes (with window titles); "Show all processes..." falls back to every process.
- New: attach by **processName**: waits until the x86 .NET process starts (`waitTimeout`, default 120 s), then attaches.
- New: **Modules** view (loaded assemblies, symbol status, copy path / reveal in File Explorer).

## 0.4.0

- New: **View as Table** for List<T>, arrays, Dictionary and DataTable (sort, filter, CSV copy / save).
- New: **Step history** view: location and locals at every stop, with changed values marked.
- New: **Value trend**: record expressions at a line on every pass without stopping and chart them hit by hit.
- New: **Inline values** for C# while stopped (locals, parameters and fields; properties are skipped).
- New: **CPU usage graph** below the memory graph (% of all cores, stopped periods shaded).
- New: **Hit count breakpoints** (`N`, `==N`, `>=N`, `>N`, `%N`), also combined with conditions and log messages.
- New: readable, localized exception filter labels; exception breakpoints accept a condition listing exception types.
- Fix: the "failed to start netcoredbg" message was still Japanese-only.

## 0.3.0

- New: Japanese localization. Menus, settings, messages and the memory graph follow VS Code's display language;
  messages that were Japanese-only are now English by default.
- New: **DebuggerDisplay** attribute support in the Variables view, hovers and Watch (netcoredbg patch 0004).
- Build: netcoredbg patches are now re-applied from a clean checkout on every build.
- New: **Memory graph** (Private Bytes / Working Set per second, stopped periods shaded).
- New: **Logpoints** (`{expression}`, `$FUNCTION`, `$TID`). netcoredbg now runs behind a DAP relay in the extension
  that logs the message and resumes, so the stop is never shown.
- New: **Copy as C# Initializer** copies a variable as C# object / collection initializer code.
- New: **View String** opens a string variable pretty-printed as JSON / XML / HTML / text.
- New: **Take Snapshot** / **Compare with Snapshot** show a diff of a variable between two stops.
- Dump: enums are shown by name and chars as the character.

## 0.2.0

- New: **Dump Variable** (Variables view context menu) and **Dump Expression...** (Command Palette) open a whole object
  as JSON. `List<T>` / `Dictionary<TKey, TValue>` are shown as their items.
- Fix: expanding objects with many properties (e.g. a WinForms `Form`) in the Variables view failed with `0x80131305`.
  The bundled netcoredbg is patched to print each member right after it is fetched and to show `<error>`
  for a single failing member instead of failing the whole request.
- Fix: hovering over a variable in the editor showed nothing. netcoredbg did not report `supportsEvaluateForHovers`,
  so VS Code never asked for hover values.
- New: `dotnetX86.trace` setting logs the debug adapter traffic and writes a netcoredbg log for troubleshooting.
- Fix: expanding an object with a `void*` field that points to valid memory (e.g. `Form.TaskbarOwner`)
  hung the debugger. `void*` values are now shown as addresses and are not dereferenced.

## 0.1.0

- Initial release.
- `dotnet-x86` debug type: launch / attach for 32-bit (x86) .NET applications.
- Bundles an x86 build of [netcoredbg](https://github.com/Samsung/netcoredbg) 3.2.0-1092.
