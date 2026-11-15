// GDI leak candidates: objects holding native resources (GDI+ fonts, brushes, images; icons, cursors and windows)
// on the GC heap, and how many still hold their handle - Dispose not called (netcoredbg patch 0012).
// No vscode dependency, so it can be unit tested.

/** Custom DAP request (netcoredbg patch 0012): `{ types: ResourceType[] }` for the given handle fields. */
export const HANDLE_STATS_REQUEST = 'dotnetX86.handleStats';

/** What the handle is: GDI+ objects live in native memory, icons, cursors and windows are USER objects. */
export type ResourceKind = 'GDI+' | 'USER';

/**
 * The field that holds the native handle, per declaring type, as .NET (System.Drawing.Common 9+, WinForms on .NET)
 * and .NET Framework name it. Dispose sets it to 0. Derived types are found through their base type
 * (Bitmap and Metafile keep Image's handle, SolidBrush keeps Brush's).
 */
export const RESOURCE_FIELDS: { type: string; fields: string[]; kind: ResourceKind }[] = [
    { type: 'System.Drawing.Font', fields: ['_nativeFont', 'nativeFont'], kind: 'GDI+' },
    { type: 'System.Drawing.Brush', fields: ['_nativeBrush', 'nativeBrush'], kind: 'GDI+' },
    { type: 'System.Drawing.Pen', fields: ['_nativePen', 'nativePen'], kind: 'GDI+' },
    { type: 'System.Drawing.Image', fields: ['_nativeImage', 'nativeImage'], kind: 'GDI+' },
    { type: 'System.Drawing.Graphics', fields: ['<NativeGraphics>k__BackingField', 'nativeGraphics'], kind: 'GDI+' },
    { type: 'System.Drawing.Region', fields: ['<NativeRegion>k__BackingField', 'nativeRegion'], kind: 'GDI+' },
    { type: 'System.Drawing.Drawing2D.GraphicsPath', fields: ['_nativePath', 'nativePath'], kind: 'GDI+' },
    { type: 'System.Drawing.StringFormat', fields: ['_nativeFormat', 'nativeFormat'], kind: 'GDI+' },
    { type: 'System.Drawing.Icon', fields: ['_handle', 'handle'], kind: 'USER' },
    { type: 'System.Windows.Forms.Cursor', fields: ['_handle', 'handle'], kind: 'USER' },
    { type: 'System.Windows.Forms.NativeWindow', fields: ['<HWND>k__BackingField', 'handle'], kind: 'USER' },
];

/** The `fields` argument of the request. */
export function handleStatsArguments(): { fields: { type: string; field: string }[] } {
    return { fields: RESOURCE_FIELDS.flatMap((r) => r.fields.map((field) => ({ type: r.type, field }))) };
}

/** One type, as `dotnetX86.handleStats` returns it. */
export interface ResourceType {
    name: string;
    /** Instances on the heap. */
    count: number;
    /** Instances whose handle is not 0: not disposed (or, for a window, not destroyed). */
    live: number;
    /** "System.Drawing.Font._nativeFont" */
    field: string;
    /** Added by withKinds (the request does not return it). */
    kind?: ResourceKind | '?';
}

export interface ResourceRow extends ResourceType {
    /** Change of `live` since the baseline (0 without one). */
    liveDelta: number;
    countDelta: number;
}

export function resourceKind(field: string): ResourceKind | '?' {
    const declaring = field.slice(0, field.lastIndexOf('.'));
    return RESOURCE_FIELDS.find((r) => r.type === declaring)?.kind ?? '?';
}

/** The types of a response with their kind. */
export function withKinds(types: ResourceType[]): ResourceType[] {
    return types.map((t) => ({ ...t, kind: resourceKind(t.field) }));
}

/**
 * Every type of `current` with its change since `baseline` (types that are gone show with 0), the ones that hold
 * more handles than before first: those are the leak candidates. Self-contained, as the page embeds it.
 */
export function diffResources(current: ResourceType[], baseline?: ResourceType[]): ResourceRow[] {
    const before = new Map((baseline ?? []).map((t) => [t.name, t]));
    const rows: ResourceRow[] = current.map((t) => {
        const b = before.get(t.name);
        before.delete(t.name);
        return {
            ...t,
            liveDelta: baseline ? t.live - (b?.live ?? 0) : 0,
            countDelta: baseline ? t.count - (b?.count ?? 0) : 0,
        };
    });
    for (const b of before.values()) {
        rows.push({ ...b, count: 0, live: 0, liveDelta: -b.live, countDelta: -b.count });
    }
    return rows.sort((a, b) => b.liveDelta - a.liveDelta || b.live - a.live || a.name.localeCompare(b.name));
}
