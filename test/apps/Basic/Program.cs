// E2E test app. The tests find lines by the "// @name" markers, so keep each marker on the line it describes.
namespace Basic;

public class Line
{
    public string Sku { get; set; }
    public int Quantity { get; set; }
    public decimal Price { get; set; }
}

public class Orders
{
    public string Currency { get; set; } = "JPY";

    public decimal Total(List<Line> lines, decimal rate)
    {
        var sum = lines.Sum(l => l.Quantity * l.Price);
        return sum * (1 + rate); // @total-return
    }

    public static string Label(string sku, int quantity)
    {
        return $"{sku} x{quantity}"; // @label-return
    }

    public async Task<int> CountAsync(int[] values)
    {
        await Task.Delay(10);
        return values.Length; // @count-return
    }
}

public static class Program
{
    public static async Task Main()
    {
        // Logpoints and hit counts.
        var total = 0;
        for (var i = 1; i <= 5; i++)
        {
            total += i; // @loop
        }

        // Exception settings: a FormatException thrown and caught.
        try
        {
            int.Parse("not a number"); // @throw-format
        }
        catch (FormatException)
        {
        }

        // Caller-filtered breakpoints: Log is reached from A, B, A.
        A(); B(); A();

        // Step into a specific call.
        var nested = Outer(Inner1(1), Inner2(2)); // @nested

        // Object IDs and test generation.
        var orders = new Orders();
        var lines = new List<Line> { new Line { Sku = "A-1", Quantity = 2, Price = 150m }, new Line { Sku = "B-2", Quantity = 1, Price = 99.5m } };
        Console.WriteLine(orders.Total(lines, 0.1m));
        Console.WriteLine(Orders.Label("A-1", 3));
        Console.WriteLine(await orders.CountAsync(new[] { 1, 2, 3 }));

        // Source mapping (MappedLib's PDB records C:\fake\src\MappedLib) and decompiling (NoPdbLib has no PDB).
        Console.WriteLine(MappedLib.Calc.Add(1, 2)); // @call-mapped
        Console.WriteLine(NoPdbLib.Pricing.WithTax(100m, 0.1m)); // @call-nopdb
        Console.WriteLine(EmbeddedLib.Greeter.Hello("e2e"));

        Console.WriteLine($"{total} {nested}");
    }

    private static void A() { Log("a"); }

    private static void B() { Log("b"); }

    private static void Log(string text)
    {
        Console.WriteLine(text); // @log
    }

    private static int Inner1(int x)
    {
        return x * 10;
    }

    private static int Inner2(int x)
    {
        return x * 100;
    }

    private static int Outer(int a, int b)
    {
        return a + b;
    }
}
