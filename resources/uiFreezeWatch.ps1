# Watches the windows of one process and reports UI threads that stop answering window messages.
# Long-lived helper of the extension. Usage: uiFreezeWatch.ps1 -ProcessId <pid> -ThresholdMs <ms>
#   stdin:  "pause" (the debugger stopped the program: its windows cannot answer), "resume"
#   stdout: "hung <threadId> <ms>" once per freeze when a UI thread has not answered for ThresholdMs,
#           "exited" when the process is gone.
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$ThresholdMs = 2000
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DotnetX86
{
    public static class UiFreezeWatch
    {
        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

        const uint WM_NULL = 0;
        const uint SMTO_ABORTIFHUNG = 0x2;
        const int PollIntervalMs = 250;
        const uint AnswerTimeoutMs = 200;

        static volatile bool paused;
        /// <summary>Set when the watch resumes: freezes measured before the pause do not count.</summary>
        static volatile bool reset;

        public static void Run(int processId, int thresholdMs)
        {
            var input = new Thread(ReadCommands) { IsBackground = true };
            input.Start();

            Process process;
            try { process = Process.GetProcessById(processId); }
            catch (ArgumentException) { Say("exited"); return; }

            // UI thread -> when it was first seen not answering; and the threads already reported for this freeze.
            var since = new Dictionary<uint, DateTime>();
            var reported = new HashSet<uint>();
            while (!process.HasExited)
            {
                Thread.Sleep(PollIntervalMs);
                if (reset)
                {
                    reset = false;
                    since.Clear();
                    reported.Clear();
                }
                if (paused) continue;

                foreach (var pair in UiThreadWindows((uint)processId))
                {
                    uint thread = pair.Key;
                    IntPtr ignored;
                    bool answered = SendMessageTimeout(pair.Value, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, AnswerTimeoutMs, out ignored) != IntPtr.Zero;
                    if (paused) break; // the debugger stopped the program while we were waiting
                    if (answered)
                    {
                        since.Remove(thread);
                        reported.Remove(thread);
                        continue;
                    }
                    DateTime first;
                    if (!since.TryGetValue(thread, out first))
                    {
                        first = DateTime.UtcNow.AddMilliseconds(-AnswerTimeoutMs);
                        since[thread] = first;
                    }
                    int ms = (int)(DateTime.UtcNow - first).TotalMilliseconds;
                    if (ms >= thresholdMs && reported.Add(thread))
                    {
                        Say("hung " + thread + " " + ms);
                    }
                }
            }
            Say("exited");
        }

        /// <summary>One visible top-level window per thread of the process (enough to ask that thread).</summary>
        static Dictionary<uint, IntPtr> UiThreadWindows(uint processId)
        {
            var windows = new Dictionary<uint, IntPtr>();
            EnumWindows((hwnd, l) =>
            {
                uint owner;
                uint thread = GetWindowThreadProcessId(hwnd, out owner);
                if (owner == processId && IsWindowVisible(hwnd) && !windows.ContainsKey(thread))
                {
                    windows[thread] = hwnd;
                }
                return true;
            }, IntPtr.Zero);
            return windows;
        }

        static void ReadCommands()
        {
            var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                line = line.Trim();
                if (line == "pause") paused = true;
                else if (line == "resume") { reset = true; paused = false; }
            }
            // The extension went away: stop watching.
            Environment.Exit(0);
        }

        static void Say(string line)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }
}
'@

[DotnetX86.UiFreezeWatch]::Run($ProcessId, $ThresholdMs)
