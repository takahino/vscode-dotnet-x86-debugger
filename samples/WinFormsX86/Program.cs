using System;
using System.Drawing;
using System.Windows.Forms;

namespace WinFormsX86
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

    internal sealed class MainForm : Form
    {
        private readonly Label _label = new Label { AutoSize = true, Location = new Point(12, 12) };
        private readonly Button _button = new Button { Text = "Count", Location = new Point(12, 48), Width = 120 };
        private int _count;

        public MainForm()
        {
            Text = "WinFormsX86 - " + (Environment.Is64BitProcess ? "64bit" : "32bit");
            ClientSize = new Size(320, 100);
            Controls.Add(_label);
            Controls.Add(_button);
            _button.Click += OnButtonClick;
            UpdateLabel();
        }

        private void OnButtonClick(object? sender, EventArgs e)
        {
            _count++; // set a breakpoint here
            UpdateLabel();
        }

        private void UpdateLabel()
        {
            _label.Text = $"Is64BitProcess={Environment.Is64BitProcess}  Count={_count}";
        }
    }
}
