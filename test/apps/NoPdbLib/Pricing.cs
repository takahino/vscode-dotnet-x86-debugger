using System;

namespace NoPdbLib;

public static class Pricing
{
    public static decimal WithTax(decimal price, decimal rate)
    {
        var tax = price * rate;
        if (tax < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(rate));
        }
        return price + tax;
    }
}
