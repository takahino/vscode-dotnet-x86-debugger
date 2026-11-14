// Renders a collected DumpNode as a C# expression (object / collection initializers).
// The debugger cannot tell settable properties from read-only ones or fields, so only members with
// public-style names (PascalCase) are emitted; the result is a starting point for test data, not
// guaranteed to compile as-is.

import { DumpNode } from './dumpCore';

const INDENT = '    ';
const PUBLIC_MEMBER_NAME = /^[A-Z][A-Za-z0-9_]*$/;
const NUMERIC_SUFFIX: Record<string, string> = { long: 'L', ulong: 'UL', uint: 'U', float: 'F', double: 'D', decimal: 'M' };
const NUMERIC_TYPES = new Set(['byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'decimal']);

export function toCSharpStatement(name: string, node: DumpNode): string {
    const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'this' ? name : 'value';
    return `var ${variableName} = ${toCSharp(node, '')};\n`;
}

export function toCSharp(node: DumpNode, indent: string): string {
    switch (node.kind) {
        case 'leaf':
            return leafToCSharp(node.type, node.text);
        case 'truncated':
            return `default /* ${node.type ?? '?'}: not expanded (limit reached) */`;
        case 'error':
            return `default /* ${node.type ?? '?'}: ${node.message} */`;
        case 'list': {
            const creation = node.type?.endsWith('[]') ? `new ${node.type}` : `new ${node.type ?? 'object[]'}`;
            return block(creation, node.items.map((item) => toCSharp(item, indent + INDENT)), indent);
        }
        case 'dict': {
            const lines = node.entries.map(
                ([key, value]) => `[${toCSharp(key, indent + INDENT)}] = ${toCSharp(value, indent + INDENT)}`,
            );
            return block(`new ${node.type ?? 'System.Collections.Generic.Dictionary<object, object>'}`, lines, indent);
        }
        case 'object':
            return objectToCSharp(node, indent);
    }
}

function objectToCSharp(node: Extract<DumpNode, { kind: 'object' }>, indent: string): string {
    const member = (name: string) => node.members.find(([n]) => n === name)?.[1];
    const leafText = (name: string) => {
        const m = member(name);
        return m?.kind === 'leaf' ? m.text : undefined;
    };

    // Value types whose public members are not settable get a constructor/factory call instead.
    if (node.type === 'System.DateTime') {
        const ticks = leafText('Ticks');
        const kind = leafText('Kind');
        if (ticks) {
            return `new System.DateTime(${ticks}L${kind ? `, System.DateTimeKind.${kind}` : ''})`;
        }
    }
    if (node.type === 'System.TimeSpan') {
        const ticks = leafText('Ticks') ?? leafText('_ticks');
        if (ticks) {
            return `System.TimeSpan.FromTicks(${ticks}L)`;
        }
    }

    const lines = node.members
        .filter(([name]) => PUBLIC_MEMBER_NAME.test(name))
        .map(([name, value]) => `${name} = ${toCSharp(value, indent + INDENT)}`);
    return block(`new ${node.type ?? 'object'}`, lines, indent);
}

function block(creation: string, lines: string[], indent: string): string {
    if (lines.length === 0) {
        return `${creation} { }`;
    }
    const inner = lines.map((l) => `${indent}${INDENT}${l},`).join('\n');
    return `${creation}\n${indent}{\n${inner}\n${indent}}`;
}

function leafToCSharp(type: string | undefined, text: string): string {
    if (text === 'null') {
        return 'null';
    }
    if (type === 'string') {
        return csharpString(unquote(text));
    }
    if (type === 'char') {
        // netcoredbg prints chars as "97 'a'".
        const match = /^\d+ '(.*)'$/.exec(text);
        return match ? `'${escapeChars(match[1] === "'" ? "\\'" : match[1])}'` : `'\\0' /* ${text} */`;
    }
    if (type === 'bool') {
        return text;
    }
    if (type && NUMERIC_TYPES.has(type)) {
        return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text) ? `${text}${NUMERIC_SUFFIX[type] ?? ''}` : `default /* ${type}: ${text} */`;
    }
    // Enum values are printed as their member names, e.g. "Left" or "Bold | Italic".
    if (type && /^[A-Za-z_][\w]*( \| [A-Za-z_][\w]*)*$/.test(text)) {
        return text
            .split(' | ')
            .map((v) => `${type}.${v}`)
            .join(' | ');
    }
    return `default /* ${type ?? '?'}: ${text} */`;
}

function unquote(text: string): string {
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        try {
            return JSON.parse(text) as string;
        } catch {
            return text.slice(1, -1);
        }
    }
    return text;
}

function csharpString(value: string): string {
    return `"${escapeChars(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`;
}

/** Escapes control characters; backslashes and quotes must already be handled by the caller. */
function escapeChars(value: string): string {
    return value
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/\0/g, '\\0')
        .replace(/[\u0001-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
