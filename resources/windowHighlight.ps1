# Draws a frame around a window (a WinForms control of the program being debugged) on the screen.
# Runs as a long-lived helper of the extension: one request per stdin line, "<hwnd>`t<label>", answered with one line
# on stdout: "ok", "gone", "hidden", "minimized" or "error <message>".
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page.
#
# The debugged program is stopped, so its window cannot be brought to the front (Windows asks the window's own,
# frozen thread to do that). Instead a DWM thumbnail of its top-level window - the desktop compositor still has its
# last image - is shown at the same place, on top of everything, and the frame is drawn over that.

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Netdbg
{
    public static class WindowHighlight
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
        const int DisplayMilliseconds = 2500;

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
            readonly bool clickThrough;

            public Overlay(bool clickThrough)
            {
                this.clickThrough = clickThrough;
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.Manual;
                ShowInTaskbar = false;
                TopMost = true;
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    var cp = base.CreateParams;
                    cp.ExStyle |= 0x80 | 0x8 | 0x08000000; // TOOLWINDOW | TOPMOST | NOACTIVATE
                    if (clickThrough)
                    {
                        cp.ExStyle |= 0x80000 | 0x20; // LAYERED | TRANSPARENT: mouse input goes through
                    }
                    return cp;
                }
            }
        }

        static Control invoker;
        static Overlay preview, frame;
        static IntPtr thumbnail = IntPtr.Zero;
        static System.Windows.Forms.Timer closeTimer;

        public static void Run()
        {
            // Window rectangles of a per-monitor-aware program are in physical pixels; draw in the same units.
            SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
            Application.EnableVisualStyles();
            invoker = new Control();
            invoker.CreateControl();
            closeTimer = new System.Windows.Forms.Timer { Interval = DisplayMilliseconds };
            closeTimer.Tick += delegate { CloseOverlays(); };

            var reader = new Thread(ReadRequests) { IsBackground = true };
            reader.Start();
            Application.Run();
        }

        static void ReadRequests()
        {
            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = input.ReadLine()) != null)
            {
                var parts = line.Split(new[] { '\t' }, 2);
                long hwnd;
                string answer = "gone";
                if (long.TryParse(parts[0], out hwnd))
                {
                    string label = parts.Length > 1 ? parts[1] : "";
                    try
                    {
                        answer = (string)invoker.Invoke(new Func<string>(() => Show(new IntPtr(hwnd), label)));
                    }
                    catch (Exception e)
                    {
                        // Always answer: the extension waits for one line per request.
                        answer = "error " + e.GetBaseException().Message.Replace((char)13, (char)32).Replace((char)10, (char)32);
                    }
                }
                Console.Out.WriteLine(answer);
                Console.Out.Flush();
            }
            invoker.BeginInvoke(new Action(Application.Exit));
        }

        static string Show(IntPtr hwnd, string label)
        {
            if (!IsWindow(hwnd)) return "gone";
            if (!IsWindowVisible(hwnd)) return "hidden";
            IntPtr root = GetAncestor(hwnd, GA_ROOT);
            if (root == IntPtr.Zero) root = hwnd;
            if (IsIconic(root)) return "minimized";
            RECT rr, visible, cr;
            GetWindowRect(root, out rr);
            GetWindowRect(hwnd, out cr);
            // The window rectangle includes the invisible resize borders; show only the visible part, 1:1.
            if (DwmGetWindowAttribute(root, DWMWA_EXTENDED_FRAME_BOUNDS, out visible, Marshal.SizeOf(typeof(RECT))) != 0)
            {
                visible = rr;
            }
            CloseOverlays();

            // The program's window as the compositor last saw it, where it really is.
            int width = visible.Right - visible.Left, height = visible.Bottom - visible.Top;
            preview = new Overlay(false) { Bounds = new Rectangle(visible.Left, visible.Top, width, height), BackColor = Color.Black };
            preview.MouseDown += delegate { CloseOverlays(); };
            preview.Show();
            if (DwmRegisterThumbnail(preview.Handle, root, out thumbnail) == 0)
            {
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
            }

            // The frame (with its label above it) on top, letting the mouse through.
            const int border = 3;
            var target = new Rectangle(cr.Left, cr.Top, cr.Right - cr.Left, cr.Bottom - cr.Top);
            string text = string.Format("{0}  {1}{3}{2}", label, target.Width, target.Height, (char)0xD7).Trim();
            var font = new Font("Segoe UI", 9f);
            var textSize = TextRenderer.MeasureText(text, font);
            int labelWidth = textSize.Width + 8, labelHeight = textSize.Height + 4;
            frame = new Overlay(true)
            {
                Bounds = new Rectangle(target.Left - border, target.Top - border - labelHeight, Math.Max(target.Width + border * 2, labelWidth), target.Height + border * 2 + labelHeight),
                BackColor = Color.Magenta,
                TransparencyKey = Color.Magenta,
            };
            frame.Paint += (s, e) =>
            {
                var g = e.Graphics;
                using (var pen = new Pen(Color.Red, border))
                {
                    g.DrawRectangle(pen, border / 2f, labelHeight + border / 2f, target.Width + border, target.Height + border);
                }
                g.FillRectangle(Brushes.Red, 0, 0, labelWidth, labelHeight);
                TextRenderer.DrawText(g, text, font, new Rectangle(4, 0, labelWidth - 4, labelHeight), Color.White, TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            };
            frame.Disposed += delegate { font.Dispose(); };
            frame.Show();
            closeTimer.Stop();
            closeTimer.Start();
            return "ok";
        }

        static void CloseOverlays()
        {
            closeTimer.Stop();
            if (thumbnail != IntPtr.Zero)
            {
                DwmUnregisterThumbnail(thumbnail);
                thumbnail = IntPtr.Zero;
            }
            if (frame != null) { frame.Close(); frame.Dispose(); frame = null; }
            if (preview != null) { preview.Close(); preview.Dispose(); preview = null; }
        }
    }
}
'@

[Netdbg.WindowHighlight]::Run()
