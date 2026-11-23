# Feature Tour

A WinForms app for trying every feature of the netdbg. One button is one demo; the lines to stop on are
marked with `[n]` comments in [Demos.cs](Demos.cs). [日本語](README.jp.md)

The same source is built for **.NET 10** and **.NET Framework 4.8** (both x86), so each demo can be tried on either runtime.

## Start

1. Open this folder (`samples/FeatureTour`) in VS Code.
2. In Run and Debug choose **Feature Tour (.NET 10, x86)** or **Feature Tour (.NET Framework 4.8, x86)** and press F5.
   The `build` task builds both targets. A machine that can build this sample (.NET 10 Desktop Runtime x86 and .NET Framework) needs no extra runtime for the debugger.
3. The window title shows the runtime and `(32-bit)`.

## Demos

| # | Button | What to try |
|---|---|---|
| 1 | Loop: breakpoints / logpoints / hit count | At `[1]`: a **conditional breakpoint** `order.Amount > 1500`, a **hit count** `>=150`, or a **logpoint** `i={i} total={total}` (Debug Console). While stopped: **inline values** at the line ends, the **Autos** view, **Pin Value to Line...** on `total`, **Step History** after a few F10s. On `bigOrders++`: **Add Breakpoint When Value Changes...** with `bigOrders`. |
| 2a / 2b | Save (without import) / Import, then save | Put a breakpoint on `Import();` (`[2]`), then on the `Log` line of `Save` use **Add Dependent Breakpoint...** and pick it: 2a does not stop, 2b does. **Add Temporary Breakpoint** on the same line stops once and removes itself. |
| 3 | Return values | Stop at `[3]` and step over (F10): Variables and Autos show `MainForm.IsValid returned` / `HasStock returned` (only `IsValid` when it is false: `&&` short-circuits), and both `Points` and `Bonus` on the next `[3]` line. The `decimal rounded` line shows the limit: values returned through a hidden buffer are not shown. |
| 4 | Who changes the status? | Stop at `[4]`, expand `this` in Variables, right-click `_status` > **Break on Value Change**, continue: it stops after each assignment with `New → Approved`. On about half the runs (when the clock second is even) a surprise `Cancel()` shows up. |
| 5 | Invoice (set next statement) | `taxRate` is 0.8 instead of 0.08. Stop on the `tax` line, set `taxRate` to `0.08` (**Set Value**), right-click the `tax` line > **Jump to Cursor**, step over again. |
| 6 | Exceptions (thrown and swallowed) | Nothing shows on screen, but the **Exception Log** view lists the `FormatException`s and the `NullReferenceException`, with links to the lines. In Breakpoints, enable **All Exceptions** and right-click > **Edit Condition** `System.FormatException` to stop only on those. |
| 7 | Debug.WriteLine / Trace | The three messages appear in the **Debug Console**, with a link to the line. |
| 8 | Slow load (PerfTips / timing) | Step over the `[8]` lines: **PerfTips** shows the elapsed time at the line end. Right-click `LoadCustomers();` > **Start Timer Here...**, the `Log` line below > **End Timer Here...**, click again: the **Value Trend** chart shows round 3 is slow. |
| 9 | Sensor (value trend) | Right-click the `[9]` line > **Track Value at This Line...** with `temperature; average`, click: the chart shows 100 values without stopping. |
| 10 | Customer data (Variables view) | Stop at `[10]`. Right-click in Variables: `customer` > **Dump Variable**, **Copy as C# Initializer**, **Take Snapshot**; `orders` or `table` > **View as Table**; `json`, `xml`, `longText` > **View String**. Step over two lines, then `customer` > **Compare with Snapshot**. `Order` and `Customer` use `[DebuggerDisplay]`. |
| 11a–c | Memory / CPU | Run **.NET x86: Show Memory / CPU Graph** first. 11a keeps 50 MB per click (Private Bytes stays up, like a leak), 11b frees it, 11c keeps one core busy for 3 s. |
| 12 | Inspect controls | Stop at `[12]` and open the **WinForms Controls** view: under `hiddenControlsGroup` / `innerPanel` find `disabledBox` (disabled), `hiddenLabel` (hidden, greyed out) and `lostButton` (bounds outside its 200 × 60 parent). Hover for the bounds, right-click > **Dump Control**. |

## Also try

- **Attach**: start `bin/x86/Debug/<target>/FeatureTour.exe` from Explorer, then **Attach (pick a process)**.
  Or start **Attach (wait for FeatureTour to start)** first and launch the app afterwards.
- **Modules** view: `FeatureTour` has *symbols loaded*; framework assemblies do not.
- **Export Debug Session Report** (button in the Step History view title) after trying a few demos: stops, changed values,
  exceptions, timings and modules in one Markdown file.
