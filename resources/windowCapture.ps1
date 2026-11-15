# Saves a picture of top-level windows (the forms of the program being debugged) as PNG files.
# Usage: powershell -File windowCapture.ps1 -OutDir <folder> -Windows "<hwnd>=<file name>;<hwnd>=<file name>"
# Prints one line per window on stdout: "<file name>`tok", or "<file name>`t<reason>" (gone, hidden, minimized,
# or "error <message>").
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page.
#
# The debugged program is stopped, so its window thread cannot answer a WM_PRINT (PrintWindow waits for it until the
# time limit) and the window cannot be brought to the front. Instead, as in windowHighlight.ps1, a DWM thumbnail of
# the window - the desktop compositor still has its last image - is shown at the same place on top of everything for
# a moment, and that part of the screen is copied. The picture shows the window as it was, also when it was
# behind VS Code; the window must be on a screen, and what lies outside of it is not in the picture.

param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$Windows
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace DotnetX86
{
    public static class WindowCapture
    {
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct DWM_THUMBNAIL_PROPERTIES
        {
            public int dwFlags;
            public RECT rcDestination;
            public RECT rcSource;
            public byte opacity;
            public bool fVisible;
            public bool fSourceClientAreaOnly;
        }

        const int GA_ROOT = 2;
        const int DWM_TNP_RECTDESTINATION = 0x1, DWM_TNP_RECTSOURCE = 0x2, DWM_TNP_OPACITY = 0x4, DWM_TNP_VISIBLE = 0x8, DWM_TNP_SOURCECLIENTAREAONLY = 0x10;
        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        /// <summary>Time for the compositor to draw the thumbnail before the screen is copied.</summary>
        const int SettleMilliseconds = 400;

        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, int flags);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("dwmapi.dll")] static extern int DwmRegisterThumbnail(IntPtr dest, IntPtr src, out IntPtr thumb);
        [DllImport("dwmapi.dll")] static extern int DwmUnregisterThumbnail(IntPtr thumb);
        [DllImport("dwmapi.dll")] static extern int DwmUpdateThumbnailProperties(IntPtr thumb, ref DWM_THUMBNAIL_PROPERTIES props);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);

        /// <summary>A borderless, topmost window that never takes the focus from VS Code.</summary>
        class Overlay : Form
        {
            public Overlay()
            {
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.Manual;
                ShowInTaskbar = false;
                TopMost = true;
                BackColor = Color.Black;
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    var cp = base.CreateParams;
                    cp.ExStyle |= 0x80 | 0x8 | 0x08000000; // TOOLWINDOW | TOPMOST | NOACTIVATE
                    return cp;
                }
            }
        }

        public static void Setup()
        {
            // Window rectangles of a per-monitor-aware program are in physical pixels; copy the same units.
            SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
            Application.EnableVisualStyles();
        }

        public static string Capture(long handle, string file)
        {
            IntPtr hwnd = new IntPtr(handle);
            if (!IsWindow(hwnd)) return "gone";
            IntPtr root = GetAncestor(hwnd, GA_ROOT);
            if (root == IntPtr.Zero) root = hwnd;
            if (IsIconic(root)) return "minimized";
            if (!IsWindowVisible(root)) return "hidden";
            RECT rr, visible;
            GetWindowRect(root, out rr);
            // The window rectangle includes the invisible resize borders; copy only the visible part.
            if (DwmGetWindowAttribute(root, DWMWA_EXTENDED_FRAME_BOUNDS, out visible, Marshal.SizeOf(typeof(RECT))) != 0) visible = rr;
            int width = visible.Right - visible.Left, height = visible.Bottom - visible.Top;
            if (width <= 0 || height <= 0) return "hidden";

            IntPtr thumbnail = IntPtr.Zero;
            var preview = new Overlay { Bounds = new Rectangle(visible.Left, visible.Top, width, height) };
            try
            {
                preview.Show();
                int hr = DwmRegisterThumbnail(preview.Handle, root, out thumbnail);
                if (hr != 0) return "error DwmRegisterThumbnail failed (0x" + hr.ToString("X") + ")";
                var props = new DWM_THUMBNAIL_PROPERTIES
                {
                    dwFlags = DWM_TNP_RECTDESTINATION | DWM_TNP_RECTSOURCE | DWM_TNP_OPACITY | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY,
                    rcDestination = new RECT { Left = 0, Top = 0, Right = width, Bottom = height },
                    rcSource = new RECT { Left = visible.Left - rr.Left, Top = visible.Top - rr.Top, Right = visible.Right - rr.Left, Bottom = visible.Bottom - rr.Top },
                    opacity = 255,
                    fVisible = true,
                    fSourceClientAreaOnly = false,
                };
                DwmUpdateThumbnailProperties(thumbnail, ref props);
                for (int waited = 0; waited < SettleMilliseconds; waited += 50)
                {
                    Application.DoEvents();
                    Thread.Sleep(50);
                }
                using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                using (var graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(visible.Left, visible.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                    bitmap.Save(file, ImageFormat.Png);
                }
                return "ok";
            }
            catch (Exception e)
            {
                return "error " + e.Message.Replace('\r', ' ').Replace('\n', ' ');
            }
            finally
            {
                if (thumbnail != IntPtr.Zero) DwmUnregisterThumbnail(thumbnail);
                preview.Close();
                preview.Dispose();
            }
        }
    }
}
'@

[DotnetX86.WindowCapture]::Setup()
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($entry in $Windows.Split(';')) {
    if ($entry -eq '') { continue }
    $parts = $entry.Split('=', 2)
    $name = [IO.Path]::GetFileName($parts[1])
    try {
        $answer = [DotnetX86.WindowCapture]::Capture([long]$parts[0], (Join-Path $OutDir $name))
    } catch {
        $answer = 'error ' + $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' ')
    }
    Write-Output ($name + "`t" + $answer)
}
