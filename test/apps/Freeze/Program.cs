using System.Windows.Forms;

static class Program
{
    [System.STAThread]
    static void Main()
    {
        var form = new Form { Text = "Freeze test", Width = 400, Height = 200 };
        var timer = new Timer { Interval = 1500 };
        timer.Tick += (s, e) =>
        {
            timer.Stop();
            Freeze();
        };
        form.Shown += (s, e) => timer.Start();
        Application.Run(form);
    }

    static void Freeze()
    {
        System.Threading.Thread.Sleep(5000); // @freeze
    }
}
