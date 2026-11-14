using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace FeatureTour
{
    // [DebuggerDisplay] decides how an object is shown in Variables, Watch, hovers and Dump Variable.
    [DebuggerDisplay("Order #{Id} {Customer,nq} {Amount}")]
    public sealed class Order
    {
        public int Id { get; set; }
        public string Customer { get; set; }
        public decimal Amount { get; set; }
        public int Quantity { get; set; }
        public OrderStatus Status { get; set; }
        public DateTime OrderedAt { get; set; }
        public List<OrderLine> Lines { get; set; } = new List<OrderLine>();
    }

    public sealed class OrderLine
    {
        public string Product { get; set; }
        public int Quantity { get; set; }
        public decimal UnitPrice { get; set; }
    }

    public enum OrderStatus
    {
        New,
        Approved,
        Shipped,
        Cancelled,
    }

    [DebuggerDisplay("{Name,nq} ({Orders.Count} orders)")]
    public sealed class Customer
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public string Email { get; set; }
        public Address Address { get; set; }
        public List<Order> Orders { get; set; } = new List<Order>();
        public Dictionary<string, string> Tags { get; set; } = new Dictionary<string, string>();
    }

    public sealed class Address
    {
        public string City { get; set; }
        public string Street { get; set; }
        public string PostalCode { get; set; }
    }

    public static class SampleData
    {
        private static readonly string[] Names = { "Alice", "Bob", "Carol", "Dave", "Eve", "Frank" };
        private static readonly string[] Products = { "Pen", "Notebook", "Stapler", "Marker", "Folder" };

        /// <summary>Deterministic orders: the same data on every run, so the walkthrough steps stay valid.</summary>
        public static List<Order> CreateOrders(int count)
        {
            var random = new Random(42);
            var orders = new List<Order>();
            for (int i = 1; i <= count; i++)
            {
                var order = new Order
                {
                    Id = i,
                    Customer = Names[i % Names.Length],
                    Quantity = random.Next(0, 20),
                    Status = OrderStatus.New,
                    OrderedAt = new DateTime(2026, 1, 1).AddHours(i * 7),
                };
                int lineCount = 1 + i % 3;
                for (int j = 0; j < lineCount; j++)
                {
                    order.Lines.Add(new OrderLine
                    {
                        Product = Products[(i + j) % Products.Length],
                        Quantity = 1 + random.Next(5),
                        UnitPrice = Math.Round((decimal)(random.NextDouble() * 300), 2),
                    });
                }
                foreach (var line in order.Lines)
                {
                    order.Amount += line.Quantity * line.UnitPrice;
                }
                orders.Add(order);
            }
            return orders;
        }

        public static Customer CreateCustomer()
        {
            var customer = new Customer
            {
                Id = 7,
                Name = "Alice Example",
                Email = "alice@example.com",
                Address = new Address { City = "Tokyo", Street = "1-2-3 Chiyoda", PostalCode = "100-0001" },
            };
            customer.Orders.AddRange(CreateOrders(3));
            customer.Tags["rank"] = "gold";
            customer.Tags["since"] = "2019";
            return customer;
        }
    }
}
