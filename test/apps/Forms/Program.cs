using System.Windows.Forms;

static class Program
{
    [System.STAThread]
    static void Main()
    {
        var form = new Form { Name = "mainForm", Text = "Forms test", Width = 500, Height = 300 };
        var panel = new Panel { Name = "panel1", Left = 20, Top = 20, Width = 300, Height = 150 };
        var button = new Button { Name = "okButton", Text = "OK", Left = 40, Top = 50 };
        panel.Controls.Add(button);
        form.Controls.Add(panel);
        var timer = new Timer { Interval = 500 };
        timer.Tick += (s, e) =>
        {
            timer.Stop(); // @shown
            form.Close();
        };
        form.Shown += (s, e) => timer.Start();
        Application.Run(form);
    }
}
