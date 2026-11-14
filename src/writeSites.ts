import { stripStringsAndComments } from './inlineValuesCore';

/**
 * 1-based lines of C# source that assign to `name`: `name = …`, compound assignments (`+=`, `??=`, …),
 * `name++` / `++name`, also through `this.name`. Comparisons (`==`) and strings / comments are ignored.
 * Writes through `ref` / `out` arguments are not detected.
 */
export function findWriteLines(text: string, name: string): number[] {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = `(?<![\\w.])(?:this\\.)?${n}(?!\\w)`;
    const assignment = new RegExp(`${target}\\s*(?:[-+*/%&|^]|<<|>>|\\?\\?)?=(?!=)`);
    const postIncrement = new RegExp(`${target}\\s*(?:\\+\\+|--)`);
    const preIncrement = new RegExp(`(?:\\+\\+|--)\\s*(?:this\\.)?${n}(?!\\w)`);
    const lines: number[] = [];
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = stripStringsAndComments(raw);
        if (assignment.test(line) || postIncrement.test(line) || preIncrement.test(line)) {
            lines.push(i + 1);
        }
    });
    return lines;
}
