// Data bindings view: the WinForms data bindings of a form, read from the stopped program by evaluating expressions.
// Simple bindings are Control.DataBindings (a property bound to one member of the current item); list bindings are
// the DataSource / DataMember / DisplayMember / ValueMember of ComboBox, ListBox, DataGridView and the like.
// Kept free of the vscode module.

export type Evaluate = (expression: string) => Promise<string>;

/** Where a binding's list stands: the current item's index (0-based) and the number of items. */
export interface Position {
    index: number;
    count: number;
}

/** A BindingSource in between: what it wraps, and how it narrows the list. */
export interface BindingSourceInfo {
    dataSourceType: string;
    dataMember: string;
    filter: string;
    sort: string;
}

export interface SimpleBinding {
    /** "customerForm › detailPanel › ageLabel" */
    control: string;
    controlExpression: string;
    property: string;
    sourceType: string;
    member: string;
    /** The control's property as it is now. */
    controlValue: string;
    /** The bound member of the current item; undefined when it could not be read. */
    sourceValue?: string;
    /** When the control writes back: OnValidation, OnPropertyChanged or Never. */
    updateMode: string;
    formattingEnabled: boolean;
    formatString: string;
    /** false: the binding is not connected (a member that does not exist, or the control has no handle yet). */
    active: boolean;
    position?: Position;
    bindingSource?: BindingSourceInfo;
    /** The control shows something else than the source holds (e.g. an edit not written back yet). */
    differs: boolean;
}

export interface ListBinding {
    control: string;
    controlExpression: string;
    controlType: string;
    sourceType: string;
    dataMember: string;
    displayMember: string;
    valueMember: string;
    selectedValue?: string;
    position?: Position;
    bindingSource?: BindingSourceInfo;
}

export interface DataBindings {
    simple: SimpleBinding[];
    lists: ListBinding[];
    /** Controls visited. */
    controls: number;
    /** The walk stopped at the control limit, or was cancelled. */
    truncated: boolean;
}

/** Field holding the binding's BindToObject (which reads the source): .NET, then .NET Framework. */
const BIND_TO_OBJECT_FIELDS = ['_bindToObject', 'bindToObject'];
const SEPARATOR = ' › ';

/**
 * Reads the bindings of the given controls and all the controls inside them.
 * `roots` are C# expressions that reach a form or control, with the path of their parents ("customerForm › detailPanel").
 */
export async function readDataBindings(
    roots: { expression: string; parent?: string }[],
    evaluate: Evaluate,
    options: { maxControls?: number; onProgress?: (controls: number) => void; cancelled?: () => boolean } = {},
): Promise<DataBindings> {
    const maxControls = options.maxControls ?? 500;
    const result: DataBindings = { simple: [], lists: [], controls: 0, truncated: false };
    const pending: { expression: string; parent?: string }[] = roots.map((r) => ({ ...r }));
    while (pending.length > 0) {
        // About 5 evaluations of ~30 ms per control: a big form takes a while, so the walk can be cut short.
        if (result.controls >= maxControls || options.cancelled?.()) {
            result.truncated = true;
            break;
        }
        const { expression, parent } = pending.shift()!;
        result.controls++;
        options.onProgress?.(result.controls);
        const name = await evaluate(`${expression}.Name`).catch(() => '');
        const typeName = await evaluate(`${expression}.GetType().FullName`).catch(() => '?');
        const own = name || `(${shortTypeName(typeName)})`;
        const label = parent ? `${parent}${SEPARATOR}${own}` : own;

        const count = Number(await evaluate(`${expression}.DataBindings.Count`).catch(() => '0')) || 0;
        for (let i = 0; i < count; i++) {
            result.simple.push(await readSimpleBinding(`${expression}.DataBindings[${i}]`, expression, label, evaluate));
        }
        const list = await readListBinding(expression, label, typeName, evaluate);
        if (list) {
            result.lists.push(list);
        }
        const children = Number(await evaluate(`${expression}.Controls.Count`).catch(() => '0')) || 0;
        // Depth first, in the order of the Controls collections, so a form's rows stay together.
        pending.unshift(...Array.from({ length: children }, (_v, i) => ({ expression: `${expression}.Controls[${i}]`, parent: label })));
    }
    return result;
}

async function readSimpleBinding(binding: string, control: string, label: string, evaluate: Evaluate): Promise<SimpleBinding> {
    const read = (member: string, fallback = '') => evaluate(`${binding}.${member}`).catch(() => fallback);
    const property = await read('PropertyName');
    const sourceType = await read('DataSource.GetType().FullName', '?');
    const formattingEnabled = (await read('FormattingEnabled')) === 'true';
    const formatString = await read('FormatString');
    const controlValue = await displayValue(`${control}.${property}`, evaluate);
    let sourceValue: string | undefined;
    for (const field of BIND_TO_OBJECT_FIELDS) {
        try {
            sourceValue = await displayValue(`${binding}.${field}.GetValue()`, evaluate, true);
            break;
        } catch {
            // the other runtime's field name
        }
    }
    const active = (await read('IsBinding')) === 'true';
    return {
        control: label,
        controlExpression: control,
        property,
        sourceType: prettyTypeName(sourceType),
        member: await read('BindingMemberInfo.BindingMember'),
        controlValue: controlValue ?? '?',
        sourceValue,
        updateMode: await read('DataSourceUpdateMode.ToString()'),
        formattingEnabled,
        formatString,
        active,
        position: await readPosition(`${binding}.BindingManagerBase`, evaluate),
        bindingSource: isBindingSource(sourceType) ? await readBindingSource(`${binding}.DataSource`, evaluate) : undefined,
        differs: active && valuesDiffer(controlValue, sourceValue, formattingEnabled && formatString !== ''),
    };
}

/** The list binding of a control that has a DataSource, or undefined (most controls have no such property). */
async function readListBinding(control: string, label: string, typeName: string, evaluate: Evaluate): Promise<ListBinding | undefined> {
    let sourceType: string;
    try {
        if ((await evaluate(`${control}.DataSource`)) === 'null') {
            return undefined;
        }
        sourceType = await evaluate(`${control}.DataSource.GetType().FullName`);
    } catch {
        return undefined;
    }
    const read = (member: string) => evaluate(`${control}.${member}`).catch(() => '');
    // ListControl (ComboBox, ListBox): DisplayMember / ValueMember, and its CurrencyManager. DataGridView: DataMember.
    let displayMember = '';
    let isListControl = true;
    try {
        displayMember = await evaluate(`${control}.DisplayMember`);
    } catch {
        isListControl = false;
    }
    return {
        control: label,
        controlExpression: control,
        controlType: shortTypeName(typeName),
        sourceType: prettyTypeName(sourceType),
        dataMember: isListControl ? '' : await read('DataMember'),
        displayMember,
        valueMember: isListControl ? await read('ValueMember') : '',
        selectedValue: isListControl ? await displayValue(`${control}.SelectedValue`, evaluate).catch(() => undefined) : undefined,
        position: isListControl
            ? await readPosition(`${control}.DataManager`, evaluate)
            : isBindingSource(sourceType) ? await readPosition(`${control}.DataSource`, evaluate) : undefined,
        bindingSource: isBindingSource(sourceType) ? await readBindingSource(`${control}.DataSource`, evaluate) : undefined,
    };
}

async function readPosition(manager: string, evaluate: Evaluate): Promise<Position | undefined> {
    try {
        const index = Number(await evaluate(`${manager}.Position`));
        const count = Number(await evaluate(`${manager}.Count`));
        return Number.isFinite(index) && Number.isFinite(count) ? { index, count } : undefined;
    } catch {
        return undefined;
    }
}

async function readBindingSource(source: string, evaluate: Evaluate): Promise<BindingSourceInfo> {
    const read = (member: string) => evaluate(`${source}.${member}`).catch(() => '');
    const inner = await read('DataSource.GetType().FullName');
    const orEmpty = (v: string) => (v === 'null' ? '' : v);
    return {
        dataSourceType: inner ? prettyTypeName(inner) : '',
        dataMember: orEmpty(await read('DataMember')),
        filter: orEmpty(await read('Filter')),
        sort: orEmpty(await read('Sort')),
    };
}

function isBindingSource(typeName: string): boolean {
    return typeName === 'System.Windows.Forms.BindingSource';
}

/**
 * A value as the user reads it. netcoredbg shows a boxed or complex value as its type ("{int}", "{Customer}"):
 * ToString() then gives the value itself. With `strict`, an evaluation error is thrown instead of returning undefined.
 */
async function displayValue(expression: string, evaluate: Evaluate, strict = false): Promise<string | undefined> {
    let value: string;
    try {
        value = await evaluate(expression);
    } catch (e) {
        if (strict) {
            throw e;
        }
        return undefined;
    }
    if (/^\{[^{}]+\}$/.test(value)) {
        return evaluate(`${expression}.ToString()`).catch(() => value);
    }
    return value;
}

/**
 * Whether the control shows something else than the source holds. Values are compared as the debugger shows them,
 * ignoring decimal zeros (30 vs 30.0) and case of booleans; a binding with a format string is not compared, since the
 * control shows the formatted text.
 */
export function valuesDiffer(controlValue: string | undefined, sourceValue: string | undefined, formatted: boolean): boolean {
    if (formatted || controlValue === undefined || sourceValue === undefined) {
        return false;
    }
    return normalize(controlValue) !== normalize(sourceValue);
}

function normalize(value: string): string {
    const v = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(v)) {
        return String(Number(v));
    }
    if (/^(true|false)$/i.test(v)) {
        return v.toLowerCase();
    }
    // A null source shows as an empty text box.
    return v === 'null' ? '' : v;
}

/** "System.ComponentModel.BindingList`1[[Customer, Bindings, Version=1.0.0.0, ...]]" -> "BindingList<Customer>". */
export function prettyTypeName(fullName: string): string {
    let i = 0;
    const parse = (): string => {
        let name = '';
        while (i < fullName.length && !'[],'.includes(fullName[i])) {
            name += fullName[i++];
        }
        name = shortTypeName(name.replace(/`\d+$/, '').trim());
        // Generic arguments: [[Arg, Assembly...],[Arg2, ...]]
        if (fullName[i] === '[' && fullName[i + 1] === '[') {
            i++;
            const args: string[] = [];
            while (fullName[i] === '[') {
                i++;
                args.push(parse());
                skipToClose();
                i++; // ]
                if (fullName[i] === ',') {
                    i++;
                }
            }
            i++; // ]
            name += `<${args.join(', ')}>`;
        }
        // Array ranks: [] or [,]
        while (fullName[i] === '[' && /^\[,*\]/.test(fullName.slice(i))) {
            const rank = /^\[,*\]/.exec(fullName.slice(i))![0];
            name += rank;
            i += rank.length;
        }
        return name;
    };
    // Skips the ", Assembly, Version=..." part of a generic argument.
    const skipToClose = () => {
        let depth = 0;
        while (i < fullName.length) {
            const c = fullName[i];
            if (c === '[') {
                depth++;
            } else if (c === ']') {
                if (depth === 0) {
                    return;
                }
                depth--;
            }
            i++;
        }
    };
    return parse();
}

/** "System.Windows.Forms.TextBox" -> "TextBox"; "Outer+Inner" -> "Outer.Inner". */
export function shortTypeName(fullName: string): string {
    return fullName.slice(fullName.lastIndexOf('.') + 1).split('+').join('.');
}
