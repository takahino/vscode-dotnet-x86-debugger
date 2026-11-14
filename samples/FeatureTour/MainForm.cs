using System;
using System.Drawing;
using System.Windows.Forms;

namespace FeatureTour
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    /// <summary>
    /// The UI is built in code (no designer) so that the control names and nesting are easy to follow in the
    /// "WinForms Controls" view. The demos themselves are in Demos.cs.
    /// </summary>
    internal sealed partial class MainForm : Form
    {
        private readonly TextBox _logBox = new TextBox
        {
            Name = "logBox",
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            Dock = DockStyle.Fill,
            Font = new Font("Consolas", 9f),
        };

        public MainForm()
        {
            Name = "mainForm";
            Text = "Feature Tour - " + RuntimeDescription();
            ClientSize = new Size(1000, 680);
            StartPosition = FormStartPosition.CenterScreen;

            var demos = new FlowLayoutPanel
            {
                Name = "demoPanel",
                Dock = DockStyle.Left,
                Width = 330,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                Padding = new Padding(6),
            };
            demos.Controls.Add(Group("breakpointGroup", "Breakpoints",
                Button("loopButton", "1. Loop: breakpoints / logpoints / hit count", RunLoop),
                Button("saveButton", "2a. Save (without import)", SaveWithoutImport),
                Button("importButton", "2b. Import, then save", ImportThenSave)));
            demos.Controls.Add(Group("stepGroup", "Stepping",
                Button("returnValueButton", "3. Return values", CheckOrders),
                Button("statusButton", "4. Who changes the status?", RunWorkflow),
                Button("invoiceButton", "5. Invoice (set next statement)", CalculateInvoice)));
            demos.Controls.Add(Group("diagnosticsGroup", "Diagnostics",
                Button("exceptionButton", "6. Exceptions (thrown and swallowed)", ThrowAndSwallow),
                Button("traceButton", "7. Debug.WriteLine / Trace", WriteTrace),
                Button("slowButton", "8. Slow load (PerfTips / timing)", SlowLoad),
                Button("sensorButton", "9. Sensor (value trend)", ReadSensor)));
            demos.Controls.Add(Group("dataGroup", "Values",
                Button("customerButton", "10. Customer data (Variables view)", InspectCustomer)));
            demos.Controls.Add(Group("resourceGroup", "Memory / CPU",
                Button("allocateButton", "11a. Allocate +50 MB (kept)", AllocateMemory),
                Button("freeButton", "11b. Free memory", FreeMemory),
                Button("cpuButton", "11c. CPU busy for 3 s", BurnCpu)));
            demos.Controls.Add(Group("controlsGroup", "WinForms",
                Button("inspectButton", "12. Inspect controls", InspectControls)));
            demos.Controls.Add(CreateControlTreeDemo());

            var logGroup = new GroupBox { Name = "logGroup", Text = "Log", Dock = DockStyle.Fill, Padding = new Padding(6) };
            logGroup.Controls.Add(_logBox);

            Controls.Add(logGroup);
            Controls.Add(demos);
            Log("Ready. Each button is one demo; see samples/FeatureTour/README.md (README.jp.md) for what to try.");
        }

        /// <summary>
        /// A small panel with controls that are hard to find on screen: one hidden, one disabled and one placed outside
        /// its parent's bounds. Look for them in the "WinForms Controls" view (demo 12).
        /// </summary>
        private Control CreateControlTreeDemo()
        {
            var group = new GroupBox { Name = "hiddenControlsGroup", Text = "Hard-to-find controls", Width = 300, Height = 90 };
            var inner = new Panel { Name = "innerPanel", Location = new Point(10, 20), Size = new Size(200, 60), BorderStyle = BorderStyle.FixedSingle };
            inner.Controls.Add(new TextBox { Name = "disabledBox", Text = "disabled", Location = new Point(6, 6), Width = 120, Enabled = false });
            inner.Controls.Add(new Label { Name = "hiddenLabel", Text = "You cannot see me", Location = new Point(6, 34), AutoSize = true, Visible = false });
            // Outside the 200 x 60 panel: it exists but never appears.
            inner.Controls.Add(new Button { Name = "lostButton", Text = "Lost", Location = new Point(260, 10), Width = 60 });
            group.Controls.Add(inner);
            return group;
        }

        private static GroupBox Group(string name, string title, params Control[] buttons)
        {
            var group = new GroupBox { Name = name, Text = title, Width = 300, Height = 26 + buttons.Length * 32 };
            for (int i = 0; i < buttons.Length; i++)
            {
                buttons[i].Location = new Point(10, 20 + i * 32);
                group.Controls.Add(buttons[i]);
            }
            return group;
        }

        private static Button Button(string name, string text, Action action)
        {
            var button = new Button { Name = name, Text = text, Width = 280, Height = 28, TextAlign = ContentAlignment.MiddleLeft };
            button.Click += (s, e) => action();
            return button;
        }

        private void Log(string message)
        {
            _logBox.AppendText(DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine);
        }

        private static string RuntimeDescription()
        {
#if NETFRAMEWORK
            string runtime = ".NET Framework " + Environment.Version;
#else
            string runtime = ".NET " + Environment.Version;
#endif
            return runtime + (Environment.Is64BitProcess ? " (64-bit!)" : " (32-bit)");
        }
    }
}
