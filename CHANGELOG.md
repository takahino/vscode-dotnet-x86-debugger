# Changelog

## Unreleased

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
