# Check the environment

**netdbg** is bundled and uses no .NET runtime.

If you have the app's source and a machine that can **build that app** (an SDK, and for a framework-dependent app the runtime that matches its target), you do not need an extra runtime for this extension. An x86 build needs that runtime under `C:\Program Files (x86)\dotnet`. **.NET Framework 4.x** needs only .NET Framework to build and debug. **Edit and Continue** needs **.NET SDK 9 or later**.

**Check Environment** lists what is installed and what is missing, and checks the projects of the open folder too.
