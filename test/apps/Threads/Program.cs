using System.Threading;

static class Program
{
    static readonly int[] Counts = new int[2];

    static void Main()
    {
        new Thread(() => Work(0)) { Name = "worker-a", IsBackground = true }.Start();
        new Thread(() => Work(1)) { Name = "worker-b", IsBackground = true }.Start();
        Thread.Sleep(300);
        System.Console.WriteLine("first"); // @first
        Thread.Sleep(400);
        System.Console.WriteLine("second"); // @second
        Thread.Sleep(400);
        System.Console.WriteLine("third"); // @third
        Thread.Sleep(400);
        System.Console.WriteLine("fourth"); // @fourth
    }

    static void Work(int index)
    {
        while (true)
        {
            Interlocked.Increment(ref Counts[index]);
            Thread.Sleep(5);
        }
    }
}
