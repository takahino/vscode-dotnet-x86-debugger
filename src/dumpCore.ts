// Recursively walks DAP "variables" into a typed tree, then renders it as JSON or C#.
// Kept free of the vscode module so it can be exercised directly against a debug adapter.

export interface DapVariable {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
    /** Expression that reaches this value, when the debugger provides one. */
    evaluateName?: string;
}

export type DapRequest = (command: string, args: Record<string, unknown>) => PromiseLike<{ variables?: DapVariable[] }>;

export interface DumpOptions {
    maxDepth: number;
    maxNodes: number;
    isCancelled?: () => boolean;
    /**
     * Formats values of FORMATTED_TYPES (e.g. DateTime) in one evaluation (`x.ToString()`) instead of walking
     * their many members. Returns debugger-formatted text, or undefined to walk the value as usual.
     */
    formatValue?: (variable: DapVariable) => PromiseLike<string | undefined>;
}

/** Collected value. `text` is the value as the debugger formatted it (e.g. "\"abc\"", "42", "{Person}"). */
export type DumpNode =
    | { kind: 'leaf'; type?: string; text: string }
    | { kind: 'object'; type?: string; text: string; members: [string, DumpNode][] }
    | { kind: 'list'; type?: string; items: DumpNode[] }
    | { kind: 'dict'; type?: string; entries: [DumpNode, DumpNode][] }
    | { kind: 'truncated'; type?: string; text: string }
    | { kind: 'error'; type?: string; text: string; message: string };

export interface CollectResult {
    node: DumpNode;
    nodes: number;
    /** True when maxDepth / maxNodes cut the walk short somewhere. */
    truncated: boolean;
}

export type DumpValue = null | boolean | number | string | DumpValue[] | { [key: string]: DumpValue };

export interface DumpResult {
    value: DumpValue;
    nodes: number;
    truncated: boolean;
}

/** Value types whose members are not useful on their own; shown via ToString() when DumpOptions.formatValue is given. */
const FORMATTED_TYPES = new Set(['System.DateTime', 'System.DateTimeOffset', 'System.TimeSpan', 'System.Guid']);

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

export async function collectTree(request: DapRequest, root: DapVariable, options: DumpOptions): Promise<CollectResult> {
    const state = { nodes: 0, truncated: false };

    const fetchChildren = async (variable: DapVariable): Promise<DapVariable[]> =>
        (await request('variables', { variablesReference: variable.variablesReference })).variables ?? [];

    const walkItems = async (items: DapVariable[], depth: number): Promise<DumpNode[]> => {
        const result: DumpNode[] = [];
        for (const item of items) {
            result.push(await walk(item, depth));
        }
        return result;
    };

    /**
     * Shows List<T> / Dictionary<TKey, TValue> like Visual Studio's "Results View" instead of their internals.
     * Returns undefined when the members don't look like one of those collections.
     */
    const walkCollection = async (variable: DapVariable, children: DapVariable[], depth: number): Promise<DumpNode | undefined> => {
        const byName = new Map(children.map((c) => [c.name, c]));

        const items = byName.get('_items');
        const size = Number(byName.get('_size')?.value);
        if (items?.variablesReference && Number.isInteger(size)) {
            return { kind: 'list', type: variable.type, items: await walkItems((await fetchChildren(items)).slice(0, size), depth) };
        }

        const entries = byName.get('_entries');
        const count = Number(byName.get('_count')?.value);
        if (entries?.variablesReference && Number.isInteger(count)) {
            const result: [DumpNode, DumpNode][] = [];
            for (const entry of (await fetchChildren(entries)).slice(0, count)) {
                const fields = new Map((await fetchChildren(entry)).map((f) => [f.name, f]));
                const key = fields.get('key');
                const value = fields.get('value');
                // Removed entries stay in the array with next < -1 (free list).
                if (!key || !value || Number(fields.get('next')?.value) < -1) {
                    continue;
                }
                result.push([await walk(key, depth), await walk(value, depth)]);
            }
            return { kind: 'dict', type: variable.type, entries: result };
        }
        return undefined;
    };

    const walk = async (variable: DapVariable, depth: number): Promise<DumpNode> => {
        state.nodes++;
        if (options.formatValue && variable.evaluateName && variable.type && FORMATTED_TYPES.has(variable.type)) {
            const text = await options.formatValue(variable);
            if (text !== undefined) {
                return { kind: 'leaf', type: variable.type, text };
            }
        }
        if (!variable.variablesReference) {
            return { kind: 'leaf', type: variable.type, text: variable.value };
        }
        if (depth >= options.maxDepth || state.nodes >= options.maxNodes) {
            state.truncated = true;
            return { kind: 'truncated', type: variable.type, text: variable.value };
        }
        if (options.isCancelled?.()) {
            throw new DumpCancelledError();
        }

        let children: DapVariable[];
        try {
            children = (await fetchChildren(variable)).filter((c) => !isNoise(c));
            const collection = await walkCollection(variable, children, depth + 1);
            if (collection !== undefined) {
                return collection;
            }
        } catch (e) {
            if (e instanceof DumpCancelledError) {
                throw e;
            }
            return { kind: 'error', type: variable.type, text: variable.value, message: e instanceof Error ? e.message : String(e) };
        }

        if (children.length > 0 && children.every((c) => INDEX_NAME.test(c.name))) {
            return { kind: 'list', type: variable.type, items: await walkItems(children, depth + 1) };
        }
        // A boxed primitive (e.g. `object o = 42`) only exposes its "m_value" field.
        if (children.length === 1 && children[0].name === 'm_value' && !children[0].variablesReference) {
            return { kind: 'leaf', type: variable.type, text: children[0].value };
        }
        // An enum only exposes its underlying "value__" field; its own value text is the member name (e.g. "High").
        if (children.length === 1 && children[0].name === 'value__') {
            return { kind: 'leaf', type: variable.type, text: variable.value };
        }

        const members: [string, DumpNode][] = [];
        for (const c of children) {
            members.push([c.name, await walk(c, depth + 1)]);
        }
        return { kind: 'object', type: variable.type, text: variable.value, members };
    };

    const node = await walk(root, 0);
    return { node, nodes: state.nodes, truncated: state.truncated };
}

export async function dumpVariable(request: DapRequest, root: DapVariable, options: DumpOptions): Promise<DumpResult> {
    const result = await collectTree(request, root, options);
    return { value: toJson(result.node), nodes: result.nodes, truncated: result.truncated };
}

export class DumpCancelledError extends Error {
    constructor() {
        super('cancelled');
    }
}

export function toJson(node: DumpNode): DumpValue {
    switch (node.kind) {
        case 'leaf': {
            // netcoredbg prints chars as "65 'A'"; JSON gets just the character.
            const charMatch = node.type === 'char' ? /^\d+ '(.*)'$/.exec(node.text) : null;
            return charMatch ? charMatch[1] : parseLeaf(node.text);
        }
        case 'truncated':
            return `${node.text} (not expanded: limit reached)`;
        case 'error':
            return `${node.text} <error: ${node.message}>`;
        case 'list':
            return node.items.map(toJson);
        case 'dict': {
            const result: { [key: string]: DumpValue } = {};
            for (const [key, value] of node.entries) {
                // JSON keys are strings: string keys are used as-is, anything else by its JSON text (e.g. 1 -> "1").
                const keyValue = toJson(key);
                result[typeof keyValue === 'string' ? keyValue : JSON.stringify(keyValue)] = toJson(value);
            }
            return result;
        }
        case 'object': {
            const result: { [key: string]: DumpValue } = {};
            if (node.type) {
                result['$type'] = node.type;
            }
            for (const [name, member] of node.members) {
                result[name] = toJson(member);
            }
            return result;
        }
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
