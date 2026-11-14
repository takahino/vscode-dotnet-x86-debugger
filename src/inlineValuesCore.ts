// Finds the C# identifiers whose values VS Code should show inline while stopped.
// A lightweight text heuristic (no parser): kept free of the vscode module so it can be tested directly.

export interface InlineTarget {
    /** 0-based line */
    line: number;
    start: number;
    end: number;
    /** Variable name (lookup) or expression to evaluate. */
    text: string;
    /**
     * lookup: a local / parameter, matched against the frame's variables (no evaluation).
     * evaluate: a field such as `_count` or `this._count` (reading a field never runs user code).
     */
    kind: 'lookup' | 'evaluate';
}

/** How far up to look for the start of the method containing the stopped line. */
const MAX_SCAN_LINES = 300;

const KEYWORDS = new Set(
    (
        'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum ' +
        'event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace ' +
        'new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc ' +
        'static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while ' +
        'var dynamic async await nameof when where yield get set init value record with and or not let from select'
    ).split(' '),
);

/** Statements whose `{` opens a nested block rather than the method body. */
const BLOCK_STATEMENT = /^\s*(}\s*)?(if|else|for|foreach|while|do|switch|try|catch|finally|using|lock|fixed|unchecked|checked|case|default)\b/;

export function findInlineTargets(lines: string[], stoppedLine: number): InlineTarget[] {
    const code = lines.map(stripStringsAndComments);
    const start = findMethodBodyStart(code, stoppedLine);
    const targets: InlineTarget[] = [];
    for (let line = start; line <= stoppedLine && line < code.length; line++) {
        const seen = new Set<string>();
        const text = code[line];
        // Optional `this.` + identifier that is not itself a member of something else (`a.b` only yields `a`).
        const re = /(?<![\w.])(this\.)?([A-Za-z_]\w*)/g;
        for (let m = re.exec(text); m; m = re.exec(text)) {
            const name = m[2];
            const afterIndex = m.index + m[0].length;
            const after = text.slice(afterIndex);
            const isCall = /^\s*\(/.test(after);
            const isGenericType = /^<[A-Za-z_]/.test(after); // `List<int>`; a comparison is `i < 6`
            if (KEYWORDS.has(name) || isCall || isGenericType || isTypeContext(text, m.index)) {
                continue;
            }
            if (m[1] && /^[A-Z]/.test(name)) {
                continue; // this.Property: reading it would run a getter
            }
            const isField = name.startsWith('_') || Boolean(m[1]);
            const expression = m[1] ? `this.${name}` : name;
            if (seen.has(expression)) {
                continue;
            }
            seen.add(expression);
            if (isField) {
                targets.push({ line, start: m.index, end: afterIndex, text: expression, kind: 'evaluate' });
            } else if (/^[a-z]/.test(name)) {
                // camelCase names are locals / parameters by convention; PascalCase ones are types, properties or methods.
                targets.push({ line, start: m.index, end: afterIndex, text: name, kind: 'lookup' });
            }
        }
    }
    return targets;
}

/** Walks up from the stopped line to the `{` that opens the enclosing method body (nested blocks are skipped). */
function findMethodBodyStart(code: string[], stoppedLine: number): number {
    let depth = 0;
    const limit = Math.max(0, stoppedLine - MAX_SCAN_LINES);
    for (let line = stoppedLine; line >= limit; line--) {
        const text = code[line];
        for (let i = text.length - 1; i >= 0; i--) {
            if (text[i] === '}') {
                depth++;
            } else if (text[i] === '{' && --depth < 0) {
                const header = text.slice(0, i).trim() || (code[line - 1] ?? '');
                if (BLOCK_STATEMENT.test(header) || /=>\s*$|=\s*$|new\b[^;]*$/.test(header)) {
                    depth = 0; // a nested block / initializer: keep looking for the method body
                    continue;
                }
                return line;
            }
        }
    }
    return limit;
}

/** True for identifiers that are types in declarations / casts / `new`, e.g. `List<int> x`, `new Person`. */
function isTypeContext(text: string, index: number): boolean {
    const before = text.slice(0, index);
    return /\bnew\s+$/.test(before) || /\b(class|struct|interface|enum|record|is|as|typeof|nameof)\s+$/.test(before);
}

/** Blanks out string / char literal contents and comments, keeping column positions. */
export function stripStringsAndComments(line: string): string {
    let result = '';
    let i = 0;
    while (i < line.length) {
        const c = line[i];
        if (c === '/' && line[i + 1] === '/') {
            return result + ' '.repeat(line.length - i);
        }
        if (c === '"' || c === "'") {
            const verbatim = c === '"' && (line[i - 1] === '@' || (line[i - 1] === '$' && line[i - 2] === '@'));
            let j = i + 1;
            while (j < line.length) {
                if (!verbatim && line[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (line[j] === c) {
                    break;
                }
                j++;
            }
            result += c + ' '.repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : '');
            i = j + 1;
            continue;
        }
        result += c;
        i++;
    }
    return result;
}
