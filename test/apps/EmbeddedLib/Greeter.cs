namespace EmbeddedLib;

public static class Greeter
{
    public static string Hello(string name)
    {
        var text = "Hello, " + name; // @hello-text
        return text;
    }
}
