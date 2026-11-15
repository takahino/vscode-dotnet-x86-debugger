using System.Drawing;

static class Program
{
    static void Main()
    {
        var bitmap = new Bitmap(120, 80);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.Clear(Color.White);
            g.FillEllipse(Brushes.OrangeRed, 10, 10, 60, 60);
        }
        Image image = bitmap;
        var icon = SystemIcons.Information;
        System.Console.WriteLine($"{image.Width} {icon.Width}"); // @images
    }
}
