// Object IDs ("Make Object ID", netcoredbg patch 0008). Users write "$1" as in Visual Studio; C# allows no digit
// right after '$', so the relay sends netcoredbg the identifier "__DOTNETX86_OBJID_1" and shows "$1" in what comes back.
// Kept free of the vscode module.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Custom DAP request: gives the object behind a variablesReference an ID; answers { id }. */
export const MAKE_OBJECT_ID_REQUEST = 'dotnetX86.makeObjectId';

const DEBUGGER_PREFIX = '__DOTNETX86_OBJID_';

/** "$1" -> "__DOTNETX86_OBJID_1" outside string literals ("$1" inside quotes, and interpolated $"..." strings, stay as they are). */
export function toDebuggerObjectIds(expression: string): string {
    if (!expression.includes('$')) {
        return expression;
    }
    let result = '';
    let quote: string | undefined;
    for (let i = 0; i < expression.length; i++) {
        const c = expression[i];
        if (quote) {
            result += c;
            if (c === '\\' && i + 1 < expression.length) {
                result += expression[++i];
            } else if (c === quote) {
                quote = undefined;
            }
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            result += c;
            continue;
        }
        const next = expression[i + 1] ?? '';
        const previous = expression[i - 1] ?? '';
        if (c === '$' && next >= '0' && next <= '9' && !/[\w$]/.test(previous)) {
            result += DEBUGGER_PREFIX;
            continue;
        }
        result += c;
    }
    return result;
}

/** "__DOTNETX86_OBJID_1" coming back from netcoredbg (a child's evaluateName, an error message) -> "$1". */
export function toClientObjectIds(text: string): string {
    return text.split(DEBUGGER_PREFIX).join('$');
}

/** Arguments of a request to netcoredbg with object IDs in its expressions / breakpoint conditions rewritten. */
export function requestWithDebuggerObjectIds(command: string | undefined, args: any): any {
    if ((command === 'evaluate' || command === 'setExpression') && typeof args.expression === 'string' && args.expression.includes('$')) {
        return { ...args, expression: toDebuggerObjectIds(args.expression) };
    }
    if (command === 'setBreakpoints' && Array.isArray(args.breakpoints) && args.breakpoints.some((b: any) => typeof b.condition === 'string' && b.condition.includes('$'))) {
        return { ...args, breakpoints: args.breakpoints.map((b: any) => (typeof b.condition === 'string' ? { ...b, condition: toDebuggerObjectIds(b.condition) } : b)) };
    }
    return args;
}

/** A response from netcoredbg with "__DOTNETX86_OBJID_N" in its error message / evaluateNames shown as "$N". */
export function responseWithClientObjectIds<T extends { type: string; message?: string; body?: any }>(message: T): T {
    if (message.type !== 'response') {
        return message;
    }
    let out = message;
    if (typeof out.message === 'string' && out.message.includes(DEBUGGER_PREFIX)) {
        out = { ...out, message: toClientObjectIds(out.message) };
    }
    const variables = out.body?.variables;
    if (Array.isArray(variables) && variables.some((v: any) => typeof v.evaluateName === 'string' && v.evaluateName.includes(DEBUGGER_PREFIX))) {
        const mapped = variables.map((v: any) => (typeof v.evaluateName === 'string' ? { ...v, evaluateName: toClientObjectIds(v.evaluateName) } : v));
        out = { ...out, body: { ...out.body, variables: mapped } };
    }
    return out;
}
