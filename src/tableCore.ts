// Turns collected collections (List<T>, arrays, Dictionary<TKey, TValue>) into rows and columns for the table view.
// Kept free of the vscode module so it can be tested directly.

import { DumpNode, parseLeaf } from './dumpCore';

export interface Table {
    columns: string[];
    rows: string[][];
}

/** Display text of a single value: strings without quotes, objects by their debugger text (or DebuggerDisplay). */
export function cellText(node: DumpNode): string {
    switch (node.kind) {
        case 'leaf': {
            if (node.type === 'char') {
                const m = /^\d+ '(.*)'$/.exec(node.text);
                if (m) {
                    return m[1];
                }
            }
            const value = parseLeaf(node.text);
            return value === null ? 'null' : String(value);
        }
        case 'error':
            return `<error: ${node.message}>`;
        case 'list':
            return `[${node.items.length}]`;
        case 'dict':
            return `{${node.entries.length}}`;
        default:
            // DataTable cells hold DBNull.Value for missing values.
            return node.type === 'System.DBNull' ? 'DBNull' : node.text;
    }
}

/** Builds a table from a list / dictionary node; returns undefined for anything else. */
export function buildTable(node: DumpNode): Table | undefined {
    if (node.kind === 'list') {
        return rowsFromItems(node.items.map((item, i) => ({ label: String(i), item })), 'Index');
    }
    if (node.kind === 'dict') {
        return rowsFromItems(node.entries.map(([key, value]) => ({ label: cellText(key), item: value })), 'Key');
    }
    return undefined;
}

/** Object items become one column per member (union over all items); other items get a single "Value" column. */
function rowsFromItems(items: { label: string; item: DumpNode }[], labelColumn: string): Table {
    const members: string[] = [];
    for (const { item } of items) {
        if (item.kind === 'object') {
            for (const [name] of item.members) {
                if (!members.includes(name)) {
                    members.push(name);
                }
            }
        }
    }
    if (members.length === 0) {
        return { columns: [labelColumn, 'Value'], rows: items.map(({ label, item }) => [label, cellText(item)]) };
    }
    return {
        columns: [labelColumn, ...members],
        rows: items.map(({ label, item }) => {
            if (item.kind !== 'object') {
                return [label, ...members.map((_, i) => (i === 0 ? cellText(item) : ''))];
            }
            const byName = new Map(item.members);
            return [label, ...members.map((m) => (byName.has(m) ? cellText(byName.get(m)!) : ''))];
        }),
    };
}

/** RFC 4180 CSV (CRLF line breaks, quotes doubled). */
export function toCsv(table: Table): string {
    const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return [table.columns, ...table.rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';
}
