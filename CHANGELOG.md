# Changelog

## Unreleased

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
