# Changelog

## Unreleased

- New: **Dump Variable** (Variables view context menu) and **Dump Expression...** (Command Palette) open a whole object
  as JSON. `List<T>` / `Dictionary<TKey, TValue>` are shown as their items.
- Fix: expanding objects with many properties (e.g. a WinForms `Form`) in the Variables view failed with `0x80131305`.
  The bundled netcoredbg is patched to print each member right after it is fetched and to show `<error>`
  for a single failing member instead of failing the whole request.
- Fix: expanding an object with a `void*` field that points to valid memory (e.g. `Form.TaskbarOwner`)
  hung the debugger. `void*` values are now shown as addresses and are not dereferenced.

## 0.1.0

- Initial release.
- `dotnet-x86` debug type: launch / attach for 32-bit (x86) .NET applications.
- Bundles an x86 build of [netcoredbg](https://github.com/Samsung/netcoredbg) 3.2.0-1092.
