using System;
using System.Collections.Generic;
using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;

namespace FeatureTour
{
    // One method per demo button. The comments starting with "[n]" mark the lines that README.md refers to.
    internal sealed partial class MainForm
    {
        private readonly List<Order> _orders = SampleData.CreateOrders(200);
        private OrderStatus _status = OrderStatus.New;
        private bool _imported;
        private static readonly List<byte[]> KeptMemory = new List<byte[]>();

        // ---- 1. Breakpoints, conditions, hit counts, logpoints, inline values, pinned values, step history ----
        private void RunLoop()
        {
            decimal total = 0;
            int bigOrders = 0;
            for (int i = 0; i < _orders.Count; i++)
            {
                Order order = _orders[i];
                total += order.Amount;              // [1] breakpoint here: condition "order.Amount > 1500", hit count ">=150", or a logpoint "i={i} total={total}"
                if (order.Amount > 1500)
                {
                    bigOrders++;                    // [1] "Add Breakpoint When Value Changes..." with "bigOrders"
                }
            }
            Log(string.Format("1. {0} orders, total {1:N2}, {2} big orders", _orders.Count, total, bigOrders));
        }

        // ---- 2. Temporary / dependent breakpoints ----
        private void SaveWithoutImport()
        {
            Save(_orders[0]);
            Save(_orders[1]);
        }

        private void ImportThenSave()
        {
            Import();                               // [2] put a normal breakpoint here ...
            Save(_orders[2]);
        }

        private void Import()
        {
            _imported = true;
            Log("2. imported");
        }

        private void Save(Order order)
        {
            // [2] ... and a dependent breakpoint on the next line ("Add Dependent Breakpoint...", pick the line above):
            // it stops only for saves after an import. A "temporary" breakpoint here stops once and disappears.
            Log(string.Format("2. saved order #{0} (imported: {1})", order.Id, _imported));
        }

        // ---- 3. Return values ----
        private void CheckOrders()
        {
            int accepted = 0;
            foreach (Order order in _orders.Take(5))
            {
                if (IsValid(order) && HasStock(order))   // [3] breakpoint here, then Step Over (F10): Variables shows "MainForm.IsValid returned"
                {
                    accepted++;
                }
                int points = Bonus(Points(order));      // [3] two calls on one line: both return values are listed
                Log(string.Format("3. order #{0}: {1} points", order.Id, points));
            }
            Log("3. accepted " + accepted);
            // Note: on x86, methods returning decimal, DateTime, Nullable<T> or structs larger than 4 bytes pass the value
            // through a hidden buffer, and their return values are not shown (try stepping over this line).
            decimal rounded = Math.Round(_orders[0].Amount, 0);
            Log("3. rounded " + rounded);
        }

        private static bool IsValid(Order order)
        {
            return order.Lines.Count > 0 && order.Amount < 900;   // big orders need approval: false for some
        }

        private static bool HasStock(Order order)
        {
            return order.Quantity >= 10;
        }

        private static int Points(Order order)
        {
            return (int)(order.Amount / 100);
        }

        private static int Bonus(int points)
        {
            return points >= 5 ? points * 2 : points;
        }

        // ---- 4. Break on value change ----
        private void RunWorkflow()
        {
            _status = OrderStatus.New;              // [4] breakpoint here; in Variables expand "this", right-click "_status" > "Break on Value Change"
            Approve();
            Ship();
            if (DateTime.Now.Second % 2 == 0)
            {
                Cancel();                           // a "surprise" change, on about half the runs (even seconds)
            }
            Log("4. final status: " + _status);
        }

        private void Approve()
        {
            _status = OrderStatus.Approved;
        }

        private void Ship()
        {
            _status = OrderStatus.Shipped;
        }

        private void Cancel()
        {
            _status = OrderStatus.Cancelled;
        }

        // ---- 5. Set next statement ----
        private void CalculateInvoice()
        {
            decimal subtotal = _orders[0].Amount;
            decimal taxRate = 0.8m;                 // [5] bug: should be 0.08. Stop on the next line, set taxRate to 0.08 in Variables,
            decimal tax = subtotal * taxRate;       //     then right-click this line > "Jump to Cursor" and step over it again
            decimal total = subtotal + tax;
            Log(string.Format("5. subtotal {0:N2} + tax {1:N2} = {2:N2}", subtotal, tax, total));
        }

        // ---- 6. Exceptions ----
        private void ThrowAndSwallow()
        {
            string[] inputs = { "10", "x12", "30", "" };
            int sum = 0;
            foreach (string input in inputs)
            {
                try
                {
                    sum += int.Parse(input, CultureInfo.InvariantCulture);   // [6] FormatException for "x12" and "": caught below
                }
                catch (FormatException)
                {
                    // Swallowed: nothing on screen, but the "Exception Log" view lists every throw.
                }
            }
            try
            {
                Order missing = _orders.FirstOrDefault(o => o.Id < 0);
                Log("6. customer " + missing.Customer);                   // NullReferenceException, also swallowed
            }
            catch (Exception)
            {
            }
            Log("6. sum " + sum + " (see the Exception Log view)");
        }

        // ---- 7. Debug / Trace output ----
        private void WriteTrace()
        {
            Debug.WriteLine("7. Debug.WriteLine: shown in the Debug Console, with a link to this line");
            Trace.WriteLine("7. Trace.WriteLine: shown as well");
            Debugger.Log(0, "FeatureTour", "7. Debugger.Log\n");
            Log("7. wrote to Debug / Trace (see the Debug Console)");
        }

        // ---- 8. PerfTips and section timing ----
        private void SlowLoad()
        {
            for (int round = 0; round < 5; round++)
            {
                LoadCustomers();                    // [8] step over: PerfTips shows the time at the end of the line
                LoadOrders(round);                  // [8] right-click > "Start Timer Here..." on LoadCustomers, "End Timer Here..." on the Log line
                Log("8. round " + round + " loaded");
            }
        }

        private static void LoadCustomers()
        {
            Thread.Sleep(60);
        }

        private static void LoadOrders(int round)
        {
            Thread.Sleep(round == 3 ? 400 : 80);    // round 3 is slow: easy to spot on the chart
        }

        // ---- 9. Value trend ----
        private void ReadSensor()
        {
            double temperature = 20;
            var random = new Random(1);
            for (int tick = 0; tick < 100; tick++)
            {
                temperature += Math.Sin(tick / 8.0) + (random.NextDouble() - 0.5);
                double average = temperature / 2 + 10;   // [9] right-click > "Track Value at This Line..." with "temperature; average"
                if (tick == 99)
                {
                    Log(string.Format("9. last temperature {0:F1}, average {1:F1}", temperature, average));
                }
            }
        }

        // ---- 10. Variables view: Dump, C# initializer, string viewer, snapshots, table ----
        private void InspectCustomer()
        {
            Customer customer = SampleData.CreateCustomer();
            List<Order> orders = _orders.Take(30).ToList();
            DataTable table = CreateTable(orders);
            string json = "{\"name\":\"Alice\",\"orders\":[{\"id\":1,\"amount\":120.5},{\"id\":2,\"amount\":80}],\"vip\":true}";
            string xml = "<customer id=\"7\"><name>Alice</name><orders><order id=\"1\"/><order id=\"2\"/></orders></customer>";
            string longText = string.Join(Environment.NewLine, Enumerable.Range(1, 50).Select(n => "line " + n));
            // [10] breakpoint here. In Variables, right-click:
            //      customer > Dump Variable / Copy as C# Initializer / Take Snapshot
            //      orders or table > View as Table;  json, xml, longText > View String
            customer.Orders[0].Amount += 100;       // step over, then customer > Compare with Snapshot
            customer.Address.City = "Osaka";
            Log(string.Format("10. {0}: {1} orders, json {2} chars, table {3} rows", customer.Name, orders.Count, json.Length + xml.Length + longText.Length, table.Rows.Count));
        }

        private static DataTable CreateTable(List<Order> orders)
        {
            var table = new DataTable("Orders");
            table.Columns.Add("Id", typeof(int));
            table.Columns.Add("Customer", typeof(string));
            table.Columns.Add("Amount", typeof(decimal));
            table.Columns.Add("Status", typeof(string));
            foreach (Order order in orders)
            {
                table.Rows.Add(order.Id, order.Customer, order.Amount, order.Status.ToString());
            }
            return table;
        }

        // ---- 11. Memory and CPU graph ----
        private void AllocateMemory()
        {
            // Kept in a static list, like a leak: Private Bytes goes up and stays up (".NET x86: Show Memory / CPU Graph").
            for (int i = 0; i < 50; i++)
            {
                var block = new byte[1024 * 1024];
                block[0] = 1;                       // touch it so the memory is really committed
                KeptMemory.Add(block);
            }
            Log("11. kept " + KeptMemory.Count + " MB");
        }

        private void FreeMemory()
        {
            KeptMemory.Clear();
            GC.Collect();
            Log("11. freed");
        }

        private void BurnCpu()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var watch = Stopwatch.StartNew();
                double x = 0;
                while (watch.ElapsedMilliseconds < 3000)
                {
                    x += Math.Sqrt(watch.ElapsedTicks);
                }
                BeginInvoke(new Action(() => Log("11. CPU busy done (" + x.ToString("E1", CultureInfo.InvariantCulture) + ")")));
            });
            Log("11. CPU busy for 3 s (background thread)");
        }

        // ---- 12. WinForms Controls view ----
        private void InspectControls()
        {
            var summary = new StringBuilder();
            foreach (System.Windows.Forms.Control control in Controls)
            {
                summary.Append(control.Name).Append(' ');
            }
            Log("12. top-level controls: " + summary);   // [12] breakpoint here, then open the "WinForms Controls" view:
                                                        //      find hiddenLabel, disabledBox and lostButton under hiddenControlsGroup
        }
    }
}
