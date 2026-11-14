// "Step Into Specific": the method calls of the current statement, in the order they run.
// Kept free of the vscode module.

export interface CallTarget {
    /** As written, e.g. "order.Save" or "Calc.Add". */
    label: string;
    /** The method name netcoredbg's function breakpoint is set on. */
    method: string;
    /** 1-based column of the method name in its line, and that line's index in the statement (0 = the stopped line). */
    column: number;
    lineOffset: number;
}

/** Words followed by "(" that are not method calls. */
const NOT_CALLS = new Set([
    'if', 'while', 'for', 'foreach', 'switch', 'catch', 'using', 'lock', 'return', 'typeof', 'sizeof', 'nameof', 'default',
    'checked', 'unchecked', 'fixed', 'when', 'await', 'throw', 'base', 'this', 'stackalloc', 'is', 'as', 'in', 'out', 'ref',
]);
/** A statement rarely runs over more lines than this. */
const MAX_STATEMENT_LINES = 10;

/**
 * Calls in the statement that starts at `lines[index]` (it continues on the next lines until ";", "{" or "}"), in the
 * order they are entered: a call runs after its arguments, so `Outer(Inner1(), Inner2())` gives Inner1, Inner2, Outer.
 * Constructors ("new T(...)") are left out: netcoredbg cannot set a breakpoint on them by name.
 */
export function findCallTargets(lines: string[], index: number): CallTarget[] {
    const statement: string[] = [];
    for (let i = index; i < lines.length && i < index + MAX_STATEMENT_LINES; i++) {
        const code = blankOutLiteralsAndComments(lines[i]);
        statement.push(code);
        if (/[;{}]\s*$/.test(code)) {
            break;
        }
    }
    const text = statement.join('\n');

    const found: { target: CallTarget; end: number }[] = [];
    const call = /([A-Za-z_]\w*(?:\s*(?:\?\.|\.)\s*[A-Za-z_]\w*)*)\s*(<[^<>()]*>)?\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = call.exec(text)) !== null) {
        const chain = match[1].replace(/\s+/g, '');
        const parts = chain.split(/\?\.|\./);
        const method = parts[parts.length - 1];
        const before = text.slice(0, match.index).trimEnd();
        if (NOT_CALLS.has(method) || /\bnew$/.test(before)) {
            continue;
        }
        const open = match.index + match[0].length - 1;
        const close = matchingParen(text, open);
        const nameAt = match.index + match[1].lastIndexOf(method);
        const lineOffset = text.slice(0, nameAt).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', nameAt - 1) + 1;
        found.push({
            target: { label: chain, method, column: nameAt - lineStart + 1, lineOffset },
            end: close < 0 ? Number.MAX_SAFE_INTEGER : close,
        });
        // Calls inside the argument list are found by continuing right after the "(".
        call.lastIndex = open + 1;
    }
    found.sort((a, b) => a.end - b.end);

    // The function breakpoint is set by name: the same method twice would stop at its first call anyway.
    const seen = new Set<string>();
    return found.map((f) => f.target).filter((t) => (seen.has(t.method) ? false : (seen.add(t.method), true)));
}

/** Replaces string / char literal contents and a trailing // comment with spaces (columns stay the same). */
function blankOutLiteralsAndComments(line: string): string {
    let result = '';
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === '\\' && quote !== '@') {
                result += '  ';
                i++;
                continue;
            }
            if (c === (quote === '@' ? '"' : quote)) {
                quote = undefined;
                result += c;
                continue;
            }
            result += ' ';
            continue;
        }
        if (c === '/' && line[i + 1] === '/') {
            return result + ' '.repeat(line.length - i);
        }
        if (c === '"' || c === "'") {
            quote = c === '"' && line[i - 1] === '@' ? '@' : c;
        }
        result += c;
    }
    return result;
}

function matchingParen(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') {
            depth++;
        } else if (text[i] === ')' && --depth === 0) {
            return i;
        }
    }
    return -1;
}
