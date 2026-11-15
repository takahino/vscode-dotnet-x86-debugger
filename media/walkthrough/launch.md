# Create launch.json

**Generate launch.json** reads the `.csproj` files of the folder and writes:

- a launch configuration per executable project and target framework, with the real output path (`bin/x86/Debug/<tfm>/<name>.exe`)
- an attach configuration that lists the running x86 .NET processes
- a `build` task in `tasks.json` (`dotnet build -p:Platform=x86`), run before each launch

Pressing **F5** without a launch.json does the same.
