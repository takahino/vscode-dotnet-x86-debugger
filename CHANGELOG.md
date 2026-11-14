# Changelog

## Unreleased

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
