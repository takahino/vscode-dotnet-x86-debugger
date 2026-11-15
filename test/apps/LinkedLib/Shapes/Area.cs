namespace LinkedLib.Shapes;

public static class Area
{
    public static double Circle(double radius)
    {
        var squared = radius * radius; // @circle-squared
        return System.Math.PI * squared;
    }
}
