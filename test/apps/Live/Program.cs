using System.Windows.Forms;

static class App
{
    public static int Counter;
    public static string Status = "starting";
    public static Form MainForm;

    [System.STAThread]
    static void Main()
    {
        MainForm = new Form { Name = "mainForm", Text = "Live 0", Width = 400, Height = 200 };
        var timer = new Timer { Interval = 100 };
        timer.Tick += (s, e) =>
        {
            Counter++;
            Status = Counter % 2 == 0 ? "even" : "odd";
            MainForm.Text = "Live " + Counter;
            if (Counter >= 150)
            {
                MainForm.Close();
            }
        };
        MainForm.Shown += (s, e) => timer.Start();
        Application.Run(MainForm);
    }
}
