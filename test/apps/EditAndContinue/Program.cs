// E2E test app for Edit and Continue (src/test/e2e/editAndContinue.test.ts).
using System;

static class Program
{
    static int Compute(int x)
    {
        return x + 1; // @compute
    }

    static void Main()
    {
        int total = 0;
        for (int i = 0; i < 3; i++)
        {
            int r = Compute(10);
            total += r; // @loop
        }
        Console.WriteLine("total " + total);
    }
}
