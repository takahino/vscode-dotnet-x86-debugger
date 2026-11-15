// "Break on Event": the handlers attached to a WinForms control's events, read from the stopped program.
// WinForms keeps them in Component.Events, a linked list of (key, handler) entries; the key is a static object such as
// Control.s_clickEvent, which gives the event's name. Kept free of the vscode module.

export interface EventHandler {
    /** "Click", or undefined when the key matched none of the known fields. */
    event?: string;
    declaringType: string;
    method: string;
    /** The name netcoredbg's function breakpoints take ("Program.<>c.<Main>b__0_0"). */
    breakpointName: string;
}

/** A static event key field: its name and an expression that reaches it. */
export interface EventKey {
    field: string;
    expression: string;
}

/** Field names of the event list: .NET (WinForms on .NET Core) and .NET Framework. */
const LAYOUTS = [
    { head: '_head', next: '_next', key: '_key', handler: '_handler' },
    { head: 'head', next: 'next', key: 'key', handler: 'handler' },
];
/** A control rarely has more entries; the bound only guards against a corrupt list. */
const MAX_ENTRIES = 200;

type Evaluate = (expression: string) => Promise<string>;

/** "s_clickEvent" (.NET), "EventClick" / "EVENT_LOAD" (.NET Framework) -> "Click" / "Load". */
export function eventNameFromField(field: string): string | undefined {
    let m = /^s_(\w+)Event$/.exec(field);
    if (m) {
        return m[1][0].toUpperCase() + m[1].slice(1);
    }
    m = /^Event([A-Z]\w*)$/.exec(field);
    if (m) {
        return m[1];
    }
    m = /^EVENT_([A-Z_]+)$/.exec(field);
    if (m) {
        return m[1].toLowerCase().replace(/(^|_)([a-z])/g, (_x, _sep, c: string) => c.toUpperCase());
    }
    return undefined;
}

export function functionBreakpointName(declaringType: string, method: string): string {
    return `${declaringType.split('+').join('.')}.${method}`;
}

/** "Program.OnOkClick", or "lambda in MyApp.MainForm.InitializeComponent" for compiler-generated handlers. */
export function handlerLabel(declaringType: string, method: string): string {
    const lambda = /^<(\w+)>b__/.exec(method);
    if (lambda) {
        const owner = declaringType.replace(/\+<>c(__DisplayClass[\w_]*)?$/, '').split('+').join('.');
        return `lambda in ${owner}.${lambda[1]}`;
    }
    return functionBreakpointName(declaringType, method);
}

const unquote = (s: string) => s.replace(/^"|"$/g, '');

type DapRequest = (command: string, args: Record<string, unknown>) => PromiseLike<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The event key fields of the control's type and its base types, from the "Static members" netcoredbg lists for the
 * control (it includes inherited static fields, with an expression to reach each).
 */
export async function readEventKeys(control: string, frameId: number | undefined, request: DapRequest): Promise<EventKey[]> {
    const value = await request('evaluate', { expression: control, frameId, context: 'watch' });
    if (!value?.variablesReference) {
        return [];
    }
    const members: { name: string; variablesReference: number }[] = (await request('variables', { variablesReference: value.variablesReference }))?.variables ?? [];
    const statics = members.find((m) => m.name === 'Static members');
    if (!statics) {
        return [];
    }
    const fields: { name: string; type?: string; evaluateName?: string }[] = (await request('variables', { variablesReference: statics.variablesReference }))?.variables ?? [];
    return fields
        .filter((f) => f.type === 'object' && f.evaluateName && eventNameFromField(f.name))
        .map((f) => ({ field: f.name, expression: f.evaluateName! }));
}

/** Every handler attached to the control's events (`control` is a C# expression that reaches it). */
export async function readEventHandlers(control: string, keys: EventKey[], evaluate: Evaluate): Promise<EventHandler[]> {
    for (const layout of LAYOUTS) {
        let head: string;
        try {
            head = await evaluate(`${control}.Events.${layout.head}`);
        } catch {
            continue; // the other runtime's field names
        }
        const handlers: EventHandler[] = [];
        let entry = `${control}.Events.${layout.head}`;
        for (let i = 0; i < MAX_ENTRIES && head !== 'null'; i++) {
            const event = await eventOf(`${entry}.${layout.key}`, keys, evaluate);
            for (const delegate of await delegatesOf(`${entry}.${layout.handler}`, evaluate)) {
                const method = unquote(await evaluate(`${delegate}.Method.Name`));
                const declaringType = unquote(await evaluate(`${delegate}.Method.DeclaringType.FullName`));
                handlers.push({ event, declaringType, method, breakpointName: functionBreakpointName(declaringType, method) });
            }
            entry = `${entry}.${layout.next}`;
            head = await evaluate(entry);
        }
        return handlers;
    }
    throw new Error('this control has no readable event list');
}

/** The single delegates of a (possibly multicast) handler. */
async function delegatesOf(handler: string, evaluate: Evaluate): Promise<string[]> {
    if ((await evaluate(`${handler}._invocationList`)) === 'null') {
        return [handler];
    }
    const count = Number(await evaluate(`${handler}._invocationCount`)) || 0;
    return Array.from({ length: count }, (_v, i) => `${handler}._invocationList[${i}]`);
}

async function eventOf(key: string, keys: EventKey[], evaluate: Evaluate): Promise<string | undefined> {
    for (const k of keys) {
        if ((await evaluate(`System.Object.ReferenceEquals(${key}, ${k.expression})`).catch(() => 'false')) === 'true') {
            return eventNameFromField(k.field);
        }
    }
    return undefined;
}
