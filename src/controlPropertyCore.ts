// Changing a WinForms control's property while stopped. netcoredbg refuses to assign through an indexer result
// (Controls[0].Text = ...), but calls the property setter (set_Text) fine; enum arguments fail in its evaluator, so
// enum properties cannot be changed. Kept free of the vscode module.

export type PropertyKind = 'string' | 'bool' | 'int' | 'color' | 'expression';

export const EDITABLE_PROPERTIES: { name: string; kind: PropertyKind }[] = [
    { name: 'Text', kind: 'string' },
    { name: 'Visible', kind: 'bool' },
    { name: 'Enabled', kind: 'bool' },
    { name: 'BackColor', kind: 'color' },
    { name: 'ForeColor', kind: 'color' },
    { name: 'Left', kind: 'int' },
    { name: 'Top', kind: 'int' },
    { name: 'Width', kind: 'int' },
    { name: 'Height', kind: 'int' },
    { name: 'TabIndex', kind: 'int' },
];

/** The C# expression for what the user typed, or why it is not a valid value of that kind. */
export function valueExpression(kind: PropertyKind, input: string): { expression: string } | { error: string } {
    const text = input.trim();
    switch (kind) {
        case 'string':
            return { expression: `"${input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"` };
        case 'bool':
            return /^(true|false)$/i.test(text) ? { expression: text.toLowerCase() } : { error: 'true or false' };
        case 'int':
            return /^-?\d+$/.test(text) ? { expression: text } : { error: 'a whole number' };
        case 'color':
            return colorExpression(text);
        case 'expression':
            return text ? { expression: text } : { error: 'a C# expression' };
    }
}

function colorExpression(text: string): { expression: string } | { error: string } {
    const invalid = { error: 'a color name (Red), #RRGGBB, #AARRGGBB or R,G,B' };
    const hex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
    if (hex) {
        const bytes = hex[1].match(/../g)!.map((h) => parseInt(h, 16));
        return { expression: `System.Drawing.Color.FromArgb(${bytes.join(', ')})` };
    }
    const rgb = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(text);
    if (rgb) {
        const parts = rgb.slice(1).map(Number);
        return parts.every((n) => n <= 255) ? { expression: `System.Drawing.Color.FromArgb(${parts.join(', ')})` } : invalid;
    }
    return /^[A-Za-z]+$/.test(text) ? { expression: `System.Drawing.Color.${text}` } : invalid;
}

/** Calls the property's setter on the control (`target` is a C# expression that reaches the control). */
export function setterExpression(target: string, property: string, value: string): string {
    if (!/^[A-Za-z_]\w*$/.test(property)) {
        throw new Error(`not a property name: ${property}`);
    }
    return `${target}.set_${property}(${value})`;
}

/** The exception type when the setter threw (netcoredbg returns the exception object as the result), else undefined. */
export function failedResult(r: { result?: string; type?: string }): string | undefined {
    return r.type && /Exception$/.test(r.type) && /^\{.*\}$/.test(r.result ?? '') ? r.type : undefined;
}
