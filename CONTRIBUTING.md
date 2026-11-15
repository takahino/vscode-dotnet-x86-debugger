# Contributing

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

### Tests

```powershell
npm test          # unit tests of the logic that needs no debugger (fast)
npm run test:e2e  # end-to-end tests: the real netcoredbg debugs the apps in test\apps
```

The E2E tests need the bundled netcoredbg (`scripts\build-netcoredbg.ps1`), the decompiler helper
(`scripts\build-decompiler.ps1`), the .NET SDK and the x86 .NET (Desktop) runtime. They find the lines they stop at by
`// @name` markers in the test apps. Set `DOTNETX86_SKIP_UI_TESTS=1` to skip the WinForms test where no desktop is
available. The [CI workflow](.github/workflows/ci.yml) runs both on every push.

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
