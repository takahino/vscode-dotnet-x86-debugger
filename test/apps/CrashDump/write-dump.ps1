# For crashDump.test.ts: writes a full dump of a process (dbghelp MiniDumpWriteDump). Run by the 64-bit PowerShell,
# a 32-bit process gives a 64-bit dump (WOW64), as Task Manager and WER write them.
param([int]$ProcessId, [string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DumpWriter {
    [DllImport("dbghelp.dll", SetLastError = true)]
    static extern bool MiniDumpWriteDump(IntPtr process, uint processId, SafeHandle file, uint type, IntPtr exception, IntPtr user, IntPtr callback);
    public static void Write(System.Diagnostics.Process process, string path) {
        using (var file = new System.IO.FileStream(path, System.IO.FileMode.Create)) {
            // MiniDumpWithFullMemory | WithHandleData | WithUnloadedModules | WithFullMemoryInfo | WithThreadInfo
            if (!MiniDumpWriteDump(process.Handle, (uint)process.Id, file.SafeFileHandle, 0x2 | 0x4 | 0x20 | 0x800 | 0x1000, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
"@
[DumpWriter]::Write([System.Diagnostics.Process]::GetProcessById($ProcessId), $Path)