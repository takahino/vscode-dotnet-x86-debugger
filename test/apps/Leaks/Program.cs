using System.Collections.Generic;
using System.Drawing;

static class Program
{
    static void Main()
    {
        // 5 fonts kept and never disposed: the leak.
        var kept = new List<Font>();
        for (int i = 0; i < 5; i++)
        {
            kept.Add(new Font("Arial", 10 + i));
        }
        // 3 fonts disposed and dropped, 1 disposed and kept: not leaks.
        for (int i = 0; i < 3; i++)
        {
            new Font("Arial", 20).Dispose();
        }
        var disposed = new Font("Arial", 9);
        disposed.Dispose();
        var brushes = new List<Brush> { new SolidBrush(Color.Red), new SolidBrush(Color.Blue) };
        var bitmap = new Bitmap(10, 10);
        System.Console.WriteLine(kept.Count + brushes.Count + bitmap.Width); // @leaks
        System.GC.KeepAlive(disposed);
    }
}
