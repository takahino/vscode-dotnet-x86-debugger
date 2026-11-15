# Samples one process once per interval for the memory / CPU / handles graph of the extension.
# Long-lived helper. Usage: processSampler.ps1 -ProcessId <pid> [-IntervalMs <ms>]
#   stdout: "info <wow64 0|1> <addressLimit> <gdiQuota> <userQuota>" once at the start,
#           "s <privateBytes> <workingSet> <cpuMs> <gdi> <user> <handles> <addressUsed> <largestFree>" per sample
#           (addressUsed / largestFree are -1 when the process is not a 32-bit process on 64-bit Windows),
#           "exited" when the process is gone.
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace DotnetX86
{
    public static class ProcessSampler
    {
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_MEMORY_COUNTERS_EX
        {
            public uint cb, PageFaultCount;
            public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
                QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MEMORY_BASIC_INFORMATION
        {
            public UIntPtr BaseAddress, AllocationBase;
            public uint AllocationProtect;
            public UIntPtr RegionSize;
            public uint State, Protect, Type;
        }

        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow64);
        [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern bool GetProcessHandleCount(IntPtr h, out uint count);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll")] static extern UIntPtr VirtualQueryEx(IntPtr h, UIntPtr address, out MEMORY_BASIC_INFORMATION info, UIntPtr length);
        [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, out PROCESS_MEMORY_COUNTERS_EX counters, uint cb);
        [DllImport("user32.dll")] static extern uint GetGuiResources(IntPtr h, uint flags);

        const uint PROCESS_QUERY_INFORMATION = 0x0400, PROCESS_VM_READ = 0x0010, SYNCHRONIZE = 0x00100000;
        const uint GR_GDIOBJECTS = 0, GR_USEROBJECTS = 1;
        const uint MEM_FREE = 0x10000;
        const ushort IMAGE_FILE_LARGE_ADDRESS_AWARE = 0x0020;
        const long GB = 1L << 30;

        public static void Run(int pid, int intervalMs)
        {
            IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, false, pid);
            if (h == IntPtr.Zero) { throw new InvalidOperationException("OpenProcess failed: " + Marshal.GetLastWin32Error()); }
            try
            {
                bool wow64;
                if (!IsWow64Process(h, out wow64)) { wow64 = false; }
                // A 32-bit process on 64-bit Windows has 2 GB of address space, or 4 GB when its exe is large address aware.
                long limit = wow64 ? (IsLargeAddressAware(h) ? 4 * GB : 2 * GB) : 0;
                Console.Out.WriteLine("info {0} {1} {2} {3}", wow64 ? 1 : 0, limit, Quota("GDIProcessHandleQuota"), Quota("USERProcessHandleQuota"));
                Console.Out.Flush();
                while (WaitForSingleObject(h, 0) != 0)
                {
                    PROCESS_MEMORY_COUNTERS_EX m;
                    GetProcessMemoryInfo(h, out m, (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS_EX)));
                    long creation, exit, kernel, user;
                    GetProcessTimes(h, out creation, out exit, out kernel, out user);
                    uint handles;
                    if (!GetProcessHandleCount(h, out handles)) { handles = 0; }
                    long used = -1, largestFree = -1;
                    if (wow64) { WalkAddressSpace(h, limit, out used, out largestFree); }
                    Console.Out.WriteLine("s {0} {1} {2} {3} {4} {5} {6} {7}",
                        m.PrivateUsage.ToUInt64(), m.WorkingSetSize.ToUInt64(), (kernel + user) / 10000,
                        GetGuiResources(h, GR_GDIOBJECTS), GetGuiResources(h, GR_USEROBJECTS), handles, used, largestFree);
                    Console.Out.Flush();
                    Thread.Sleep(intervalMs);
                }
                Console.Out.WriteLine("exited");
                Console.Out.Flush();
            }
            finally { CloseHandle(h); }
        }

        /// <summary>Reserved + committed bytes below the limit, and the largest free block (what a big allocation needs).</summary>
        static void WalkAddressSpace(IntPtr h, long limit, out long used, out long largestFree)
        {
            used = 0; largestFree = 0;
            long address = 0;
            MEMORY_BASIC_INFORMATION info;
            uint size = (uint)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
            while (address < limit && VirtualQueryEx(h, new UIntPtr((ulong)address), out info, new UIntPtr(size)) != UIntPtr.Zero)
            {
                long start = (long)info.BaseAddress.ToUInt64();
                long end = Math.Min(start + (long)info.RegionSize.ToUInt64(), limit);
                if (end <= address) { break; }
                if (info.State == MEM_FREE) { largestFree = Math.Max(largestFree, end - start); }
                else { used += end - start; }
                address = end;
            }
        }

        static bool IsLargeAddressAware(IntPtr h)
        {
            try
            {
                var name = new StringBuilder(1024);
                uint length = (uint)name.Capacity;
                if (!QueryFullProcessImageName(h, 0, name, ref length)) { return false; }
                using (var r = new BinaryReader(File.OpenRead(name.ToString())))
                {
                    r.BaseStream.Seek(0x3C, SeekOrigin.Begin);
                    // PE signature (4 bytes), then IMAGE_FILE_HEADER: Characteristics is at offset 18.
                    r.BaseStream.Seek(r.ReadInt32() + 4 + 18, SeekOrigin.Begin);
                    return (r.ReadUInt16() & IMAGE_FILE_LARGE_ADDRESS_AWARE) != 0;
                }
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        /// <summary>The per-process limit of GDI / USER objects (10,000 unless changed in the registry).</summary>
        static int Quota(string name)
        {
            object value = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows", name, null);
            return value is int ? (int)value : 10000;
        }
    }
}
'@

[DotnetX86.ProcessSampler]::Run($ProcessId, $IntervalMs)
