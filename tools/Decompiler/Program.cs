// Decompiler helper of the .NET x86 Debugger extension.
//
//   DotnetX86.Decompiler <assembly> <cacheRoot>
//
// Decompiles the assembly with the ILSpy engine (ICSharpCode.Decompiler) into <cacheRoot>/<MVID>/:
//   symbols.pdb    Portable PDB whose sequence points point into the decompiled C#. netcoredbg (patch 0009) finds it
//                  by the assembly's MVID, so the assembly's own folder is never written to.
//   src/...        the decompiled C# files (the PDB embeds them; they are written out so the editor can open them).
//   manifest.json  assembly path, MVID and the PDB document name -> source file pairs, for the extension's path mapping.
// Prints the manifest path on success; on failure prints the reason to stderr and exits with 1.

using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.Json;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.DebugInfo;
using ICSharpCode.Decompiler.Metadata;

namespace DotnetX86.Decompiler;

internal static class Program
{
    private static readonly Guid EmbeddedSourceKind = new("0E8A571B-6926-466E-B4AD-8AB04611F5FE");

    private static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("Usage: DotnetX86.Decompiler <assembly> <cacheRoot>");
            return 1;
        }
        try
        {
            Console.WriteLine(Decompile(Path.GetFullPath(args[0]), Path.GetFullPath(args[1])));
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    private static string Decompile(string assemblyPath, string cacheRoot)
    {
        var file = new PEFile(assemblyPath, PEStreamOptions.PrefetchEntireImage);
        var mvid = file.Metadata.GetGuid(file.Metadata.GetModuleDefinition().Mvid);
        var outDir = Path.Combine(cacheRoot, mvid.ToString("D"));
        // A previous run for the same MVID may have been interrupted: start clean.
        if (Directory.Exists(outDir))
        {
            Directory.Delete(outDir, recursive: true);
        }
        Directory.CreateDirectory(outDir);

        var settings = new DecompilerSettings();
        var resolver = new UniversalAssemblyResolver(assemblyPath, throwOnError: false, file.DetectTargetFrameworkId());
        var decompiler = new CSharpDecompiler(file, resolver, settings);
        var pdbPath = Path.Combine(outDir, "symbols.pdb");
        using (var stream = File.Create(pdbPath))
        {
            // With a CodeView entry the PDB takes its id (netcoredbg checks that they match). An assembly built without
            // a PDB has none, and WritePdb then needs an id of its own; netcoredbg finds that PDB by the MVID alone.
            BlobContentId? pdbId = PortablePdbWriter.HasCodeViewDebugDirectoryEntry(file) ? null : new BlobContentId(mvid, 1);
            PortablePdbWriter.WritePdb(file, decompiler, settings, stream, noLogo: true, pdbId: pdbId, progress: null);
        }

        var documents = WriteSources(pdbPath, Path.Combine(outDir, "src"));
        var manifestPath = Path.Combine(outDir, "manifest.json");
        var manifest = new Manifest(assemblyPath, mvid.ToString("D"), pdbPath, documents);
        File.WriteAllText(manifestPath, JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        return manifestPath;
    }

    /// <summary>Writes the source embedded for each PDB document under <paramref name="srcDir"/>.</summary>
    private static List<DocumentEntry> WriteSources(string pdbPath, string srcDir)
    {
        var entries = new List<DocumentEntry>();
        using var provider = MetadataReaderProvider.FromPortablePdbStream(File.OpenRead(pdbPath));
        var reader = provider.GetMetadataReader();
        var root = Path.GetFullPath(srcDir) + Path.DirectorySeparatorChar;
        foreach (var handle in reader.Documents)
        {
            var name = reader.GetString(reader.GetDocument(handle).Name);
            var text = EmbeddedSource(reader, handle);
            if (text == null)
            {
                continue;
            }
            // Document names are relative ("Namespace\Type.cs"); keep every file inside the cache folder.
            var target = Path.GetFullPath(Path.Combine(srcDir, name.TrimStart('\\', '/')));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllText(target, text, new UTF8Encoding(true));
            entries.Add(new DocumentEntry(name, target));
        }
        return entries;
    }

    /// <summary>Embedded source blob: int32 format (0 = raw, otherwise the deflated text's length), then the bytes.</summary>
    private static string? EmbeddedSource(MetadataReader reader, DocumentHandle document)
    {
        foreach (var handle in reader.GetCustomDebugInformation(document))
        {
            var info = reader.GetCustomDebugInformation(handle);
            if (reader.GetGuid(info.Kind) != EmbeddedSourceKind)
            {
                continue;
            }
            var blob = reader.GetBlobBytes(info.Value);
            var format = BitConverter.ToInt32(blob, 0);
            if (format == 0)
            {
                return Encoding.UTF8.GetString(blob, 4, blob.Length - 4);
            }
            using var deflate = new DeflateStream(new MemoryStream(blob, 4, blob.Length - 4), CompressionMode.Decompress);
            using var text = new StreamReader(deflate, Encoding.UTF8);
            return text.ReadToEnd();
        }
        return null;
    }

    private sealed record DocumentEntry(string Name, string File);

    private sealed record Manifest(string Assembly, string Mvid, string Pdb, List<DocumentEntry> Documents);
}
