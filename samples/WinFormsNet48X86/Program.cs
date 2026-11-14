using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace WinFormsNet48X86
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
        private readonly Label _label = new Label { Name = "countLabel", AutoSize = true, Location = new Point(12, 12) };
        private readonly Button _button = new Button { Name = "countButton", Text = "Count", Location = new Point(12, 48), Width = 120 };
        private int _count;

        public MainForm()
        {
            Name = "mainForm";
            Text = "WinFormsNet48X86 - " + (Environment.Is64BitProcess ? "64bit" : "32bit");
            ClientSize = new Size(360, 100);
            Controls.Add(_label);
            Controls.Add(_button);
            _button.Click += OnButtonClick;
            UpdateLabel();
        }

        private void OnButtonClick(object sender, EventArgs e)
        {
            Debug.WriteLine("Before: " + Describe());
            _count++; // set a breakpoint here
            Debug.WriteLine("After : " + Describe());
            UpdateLabel();
        }

        private void UpdateLabel()
        {
            _label.Text = "CLR " + Environment.Version + "  Is64BitProcess=" + Environment.Is64BitProcess + "  Count=" + _count;
        }

        // Step over the Debug.WriteLine lines above to see "MainForm.Describe returned" in the Variables view.
        private string Describe()
        {
            return "count=" + _count;
        }
    }
}
