// "View as Image": netcoredbg's evaluator has no `new` or casts, so the image cannot be copied into a stream; the
// debuggee writes it to a PNG file instead (it always runs on this machine). Kept free of the vscode module.

/** C# expression that makes the debuggee write `expression` (an Image or an Icon) to `pngPath` as PNG. */
export function saveAsPngExpression(expression: string, typeName: string, pngPath: string): string {
    // Forward slashes: no escaping needed in the C# string, and .NET accepts them.
    const file = pngPath.split('\\').join('/').split('"').join('');
    const image = typeName === 'System.Drawing.Icon' ? `(${expression}).ToBitmap()` : `(${expression})`;
    return `${image}.Save("${file}", System.Drawing.Imaging.ImageFormat.Png)`;
}

/** Properties shown next to the image, as C# expressions (Icon has no PixelFormat). */
export function imageInfoExpressions(expression: string, typeName: string): Record<string, string> {
    const info: Record<string, string> = { Width: `(${expression}).Width`, Height: `(${expression}).Height` };
    if (typeName !== 'System.Drawing.Icon') {
        info.PixelFormat = `(${expression}).PixelFormat`;
        info.DPI = `(${expression}).HorizontalResolution`;
    }
    return info;
}

/** Width and height of a PNG from its IHDR chunk, or undefined when the bytes are not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | undefined {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.length < 24 || signature.some((b, i) => png[i] !== b)) {
        return undefined;
    }
    const read = (at: number) => ((png[at] << 24) | (png[at + 1] << 16) | (png[at + 2] << 8) | png[at + 3]) >>> 0;
    return { width: read(16), height: read(20) };
}
