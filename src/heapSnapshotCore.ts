// Heap snapshots: instance counts and sizes per type (netcoredbg patch 0011) and their change between two snapshots.
// No vscode dependency, so it can be unit tested.

/** Custom DAP request (netcoredbg patch 0011): `{ types: HeapType[] }` of the stopped program, largest first. */
export const HEAP_STATS_REQUEST = 'dotnetX86.heapStats';

/** One type on the GC heap, as `dotnetX86.heapStats` returns it. */
export interface HeapType {
    name: string;
    count: number;
    size: number;
}

export interface HeapRow extends HeapType {
    countDelta: number;
    sizeDelta: number;
    /** Not on the heap at the baseline. */
    added: boolean;
}

/**
 * Every type of `current` with its change since `baseline`, plus the types that are gone (count 0) so that freed
 * objects show up too. Without a baseline nothing has changed.
 */
export function diffHeap(current: HeapType[], baseline?: HeapType[]): HeapRow[] {
    const before = new Map((baseline ?? []).map((t) => [t.name, t]));
    const rows: HeapRow[] = current.map((t) => {
        const b = before.get(t.name);
        before.delete(t.name);
        if (!baseline) {
            return { ...t, countDelta: 0, sizeDelta: 0, added: false };
        }
        return { ...t, countDelta: t.count - (b?.count ?? 0), sizeDelta: t.size - (b?.size ?? 0), added: !b };
    });
    for (const b of before.values()) {
        rows.push({ name: b.name, count: 0, size: 0, countDelta: -b.count, sizeDelta: -b.size, added: false });
    }
    return rows;
}

export function heapTotals(types: HeapType[]): { count: number; size: number } {
    return types.reduce((a, t) => ({ count: a.count + t.count, size: a.size + t.size }), { count: 0, size: 0 });
}

export function formatBytes(bytes: number): string {
    const abs = Math.abs(bytes);
    if (abs < 1024) {
        return `${bytes} B`;
    }
    const [value, unit] = abs < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];
    return `${value.toFixed(1)} ${unit}`;
}
