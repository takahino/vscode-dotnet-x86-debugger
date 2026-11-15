# Check the environment

The debugger itself is bundled. What it needs from this machine:

| | Needed for |
|---|---|
| **.NET Runtime x86** (8 or later) | The debugger runs on it — always needed, also for .NET Framework apps |
| **.NET Desktop Runtime x86** | WinForms / WPF apps on .NET 5 or later |
| **.NET SDK** (x64 is fine) | Building with `dotnet build` |

The x86 runtimes go to `C:\Program Files (x86)\dotnet`. The *.NET Desktop Runtime x86* installer contains both runtimes.

**Check Environment** lists what is installed and what is missing, and checks the projects of the open folder too.
