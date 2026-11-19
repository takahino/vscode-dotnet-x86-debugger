# Contributing

## Building from source

Prerequisites: Node.js, Git, a .NET SDK (test apps and the decompiler helper), and for the debug engine Rust (`rustup`, targets
`i686-pc-windows-msvc` and `x86_64-pc-windows-msvc`) with the MSVC linker (Visual Studio Build Tools, *Desktop development with C++*).
The debug engine **dotnet-x86dbg** lives in its own repository; clone it next to this one (`..\dotnet-x86dbg`).

```powershell
# Build the debug engine (x86 and x64, into debugger\dotnet-x86dbg-x86 / -x64), compile, package the VSIX and install it
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# Only create the VSIX (out\dotnet-x86-debugger.vsix)
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipInstall

# Only (re)build and place the engine; -EngineRepo when it is elsewhere, -SkipBuild to copy its dist\ as it is
powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1 -EngineRepo ..\dotnet-x86dbg
```

`scripts\build-engine.ps1` runs the engine's `build.ps1` (which also fetches `dbgshim.dll` from NuGet, version pinned) and copies
`dotnet-x86dbg.exe`, `dbgshim.dll` and the Edit and Continue helper (`encdelta\`, C#; built with the .NET SDK 9 or later, and run at debug time with the Roslyn of the user's SDK) of both bitnesses. ICorDebug needs a debugger of the program's bitness, so the extension
starts the x86 or the x64 engine per session (`ENGINE_ARCHITECTURE_KEY` in `configProvider.ts`). CI and the release workflow
check out `<owner>/dotnet-x86dbg` at `ENGINE_REF`; to move to a newer engine, change `ENGINE_REF` and run the E2E tests.

To debug the extension itself, open this folder in VS Code and run **Run Extension** (F5).

### The engine API

What the extension and the engine exchange is defined in `src/engineProtocol.ts` (TypeScript types with JSDoc). After changing it,
run `npm run docs:api` to regenerate [docs/engine-api.html](docs/engine-api.html) and [docs/engine-api.json](docs/engine-api.json);
a unit test fails while they are stale, and checks that every custom request and event the extension uses is listed.
`node scripts/gen-engine-api.js --engine ..\dotnet-x86dbg` also compares the document with the requests the engine dispatches.

### Tests

```powershell
npm test          # unit tests of the logic that needs no debugger (fast)
npm run test:e2e  # end-to-end tests: the real engine debugs the apps in test\apps (x86)
$env:DOTNETX86_E2E_ARCH = 'x64'; npm run test:e2e   # the same with the x64 engine and the apps built for x64
```

The E2E tests need the engine (`scripts\build-engine.ps1`), the decompiler helper (`scripts\build-decompiler.ps1`), the .NET SDK
and the .NET (Desktop) runtime of the bitness under test. They find the lines they stop at by `// @name` markers in the test apps.
Set `DOTNETX86_SKIP_UI_TESTS=1` to skip the WinForms tests where no desktop is available, and `DOTNETX86_E2E_DEBUGGER` to run
them against another engine (for example netcoredbg, to compare). The [CI workflow](.github/workflows/ci.yml) runs the unit
tests and the E2E tests of both bitnesses on every push.

Unit tests live in `src/test/unit` and test the modules that are kept free of the `vscode` module (`*Core.ts` and the like):
write the logic of a feature there and keep the VS Code side thin, so it can be tested this way. The DAP relay (`dapProxy.ts`) is
tested against `fakeDebugger.ts`, a stand-in for the engine that answers DAP from a script (`FakeScenario`: the stops in turn, with
their frames and expression values); `fakeClient.ts` plays VS Code. Use it for anything the relay decides on its own (hidden
breakpoints, logpoints, markers, the exception log, the SQL log, the event trace) and check what reached VS Code and what the stand-in
was sent (`sentToDebugger()`). What depends on the engine's own behavior (binding, evaluation, stepping) belongs in the E2E tests.

## Releasing

1. Update `version` in `package.json` and `CHANGELOG.md`, run `npm run docs:api` (the engine API document shows the version), and commit.
2. Push a tag that matches the version:

   ```powershell
   git tag v2.0.0
   git push origin v2.0.0
   ```

The [Release workflow](.github/workflows/release.yml) builds the debug engine (x86 and x64) at `ENGINE_REF`, packages the VSIX
and creates a GitHub Release with `dotnet-x86-debugger-<version>.vsix` and `install-vsix.ps1`.
Running the workflow manually (*workflow_dispatch*) only uploads the files as a build artifact.
