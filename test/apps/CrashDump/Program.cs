// E2E test app for crash dumps (crashDump.test.ts): waits forever inside an exception filter, the exception still being
// thrown. The test writes a dump of this state and opens it.
using System;
using System.Collections.Generic;
using System.Threading;

class Order
{
    public int Id;
    public string Customer;
    public decimal Amount;
}

static class Program
{
    static readonly List<Order> Orders = new List<Order>();

    static void Main(string[] args)
    {
        for (int i = 1; i <= 3; i++)
        {
            Orders.Add(new Order { Id = i, Customer = "C" + i, Amount = i * 15.5m });
        }
        Process(Orders[1], "batch-7");
    }

    static void Process(Order order, string batch)
    {
        int retries = 3;
        try
        {
            Validate(order);
        }
        catch (Exception e) when (Hang(e, retries)) // @filter
        {
        }
    }

    static void Validate(Order order)
    {
        decimal limit = 20m;
        if (order.Amount > limit)
        {
            throw new InvalidOperationException("Amount " + order.Amount + " exceeds " + limit); // @throw
        }
    }

    static bool Hang(Exception e, int retries)
    {
        Console.WriteLine("waiting");
        Console.Out.Flush();
        Thread.Sleep(Timeout.Infinite); // @hang
        return false;
    }
}
