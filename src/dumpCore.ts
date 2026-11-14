// Recursively walks DAP "variables" and builds a JSON-friendly tree.
// Kept free of the vscode module so it can be exercised directly against a debug adapter.

export interface DapVariable {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
}

export type DapRequest = (command: string, args: Record<string, unknown>) => PromiseLike<{ variables?: DapVariable[] }>;

export interface DumpOptions {
    maxDepth: number;
    maxNodes: number;
    isCancelled?: () => boolean;
}

export type DumpValue = null | boolean | number | string | DumpValue[] | { [key: string]: DumpValue };

export interface DumpResult {
    value: DumpValue;
    nodes: number;
    /** True when maxDepth / maxNodes cut the walk short somewhere. */
    truncated: boolean;
}

/** netcoredbg packs statics into a fake child; it is skipped to keep dumps focused on the instance. */
const STATIC_MEMBERS = 'Static members';
const INDEX_NAME = /^\[\d+\]$/;
/** Indexers ("Item") are listed as properties and fail with this exception when read without arguments. */
const INDEXER_ERROR_TYPE = 'System.Reflection.TargetParameterCountException';

/**
 * Members that only add noise to a dump: statics, failed indexers and explicit interface implementations
 * (e.g. "System.Collections.ICollection.SyncRoot", which points back to the collection itself).
 */
function isNoise(member: DapVariable): boolean {
    return member.name === STATIC_MEMBERS || member.type === INDEXER_ERROR_TYPE || (member.name.includes('.') && !INDEX_NAME.test(member.name));
}

export async function dumpVariable(request: DapRequest, root: DapVariable, options: DumpOptions): Promise<DumpResult> {
    const state = { nodes: 0, truncated: false };

    const fetchChildren = async (variable: DapVariable): Promise<DapVariable[]> =>
        (await request('variables', { variablesReference: variable.variablesReference })).variables ?? [];

    const walkItems = async (items: DapVariable[], depth: number): Promise<DumpValue[]> => {
        const result: DumpValue[] = [];
        for (const item of items) {
            result.push(await walk(item, depth));
        }
        return result;
    };

    /**
     * Shows List<T> / Dictionary<TKey, TValue> like Visual Studio's "Results View" instead of their internals.
     * Returns undefined when the members don't look like one of those collections.
     */
    const walkCollection = async (children: DapVariable[], depth: number): Promise<DumpValue | undefined> => {
        const byName = new Map(children.map((c) => [c.name, c]));

        const items = byName.get('_items');
        const size = Number(byName.get('_size')?.value);
        if (items?.variablesReference && Number.isInteger(size)) {
            return walkItems((await fetchChildren(items)).slice(0, size), depth);
        }

        const entries = byName.get('_entries');
        const count = Number(byName.get('_count')?.value);
        if (entries?.variablesReference && Number.isInteger(count)) {
            const result: { [key: string]: DumpValue } = {};
            for (const entry of (await fetchChildren(entries)).slice(0, count)) {
                const fields = new Map((await fetchChildren(entry)).map((f) => [f.name, f]));
                const key = fields.get('key');
                const value = fields.get('value');
                // Removed entries stay in the array with next < -1 (free list).
                if (!key || !value || Number(fields.get('next')?.value) < -1) {
                    continue;
                }
                const keyValue = parseLeaf(key.value);
                result[typeof keyValue === 'string' ? keyValue : key.value] = await walk(value, depth);
            }
            return result;
        }
        return undefined;
    };

    const walk = async (variable: DapVariable, depth: number): Promise<DumpValue> => {
        state.nodes++;
        if (!variable.variablesReference) {
            return parseLeaf(variable.value);
        }
        if (depth >= options.maxDepth || state.nodes >= options.maxNodes) {
            state.truncated = true;
            return `${variable.value} (not expanded: limit reached)`;
        }
        if (options.isCancelled?.()) {
            throw new DumpCancelledError();
        }

        let children: DapVariable[];
        try {
            children = (await fetchChildren(variable)).filter((c) => !isNoise(c));
            const collection = await walkCollection(children, depth + 1);
            if (collection !== undefined) {
                return collection;
            }
        } catch (e) {
            if (e instanceof DumpCancelledError) {
                throw e;
            }
            return `${variable.value} <error: ${e instanceof Error ? e.message : String(e)}>`;
        }

        if (children.length > 0 && children.every((c) => INDEX_NAME.test(c.name))) {
            return walkItems(children, depth + 1);
        }
        // A boxed primitive (e.g. `object o = 42`) only exposes its "m_value" field.
        if (children.length === 1 && children[0].name === 'm_value' && !children[0].variablesReference) {
            return parseLeaf(children[0].value);
        }

        const obj: { [key: string]: DumpValue } = {};
        if (variable.type) {
            obj['$type'] = variable.type;
        }
        for (const c of children) {
            obj[c.name] = await walk(c, depth + 1);
        }
        return obj;
    };

    const value = await walk(root, 0);
    return { value, nodes: state.nodes, truncated: state.truncated };
}

export class DumpCancelledError extends Error {
    constructor() {
        super('cancelled');
    }
}

/** Converts a debugger-formatted leaf value ("\"abc\"", "42", "true", "null") into a JSON value. */
export function parseLeaf(value: string): DumpValue {
    if (value === 'null') {
        return null;
    }
    if (value === 'true' || value === 'false') {
        return value === 'true';
    }
    if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) {
        const n = Number(value);
        // Keep the original text when converting would lose precision (e.g. long, decimal).
        return Number.isSafeInteger(n) || !Number.isInteger(n) ? n : value;
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value) as string;
        } catch {
            return value.slice(1, -1);
        }
    }
    return value;
}
