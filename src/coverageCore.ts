/**
 * Coverage marks for the editor (no vscode dependency): turns the engine's line states (`dotnetX86.coverage { file }`)
 * into the lines to color as run, partly run (some branch outcomes not taken) and not run.
 */

export const COVERAGE_CHANGED_EVENT = 'dotnetX86.coverageChanged';
export const COVERAGE_REQUEST = 'dotnetX86.coverage';

/** One line of `dotnetX86.coverage { file }`. */
export interface CoverageLine {
    line: number;
    hit: boolean;
    branchesCovered?: number;
    branchesValid?: number;
    uncountableBranches?: number;
}

export interface CoverageMarks {
    /** 0-based lines. */
    hit: number[];
    /** 0-based lines, with the branch counts for the hover. */
    partial: { line: number; covered: number; valid: number }[];
    missed: number[];
}

/** Sorts the lines into the three marks. A line that ran but did not take every branch outcome is partly run. */
export function coverageMarks(lines: readonly CoverageLine[]): CoverageMarks {
    const marks: CoverageMarks = { hit: [], partial: [], missed: [] };
    for (const l of lines) {
        if (!Number.isInteger(l.line) || l.line < 1) {
            continue;
        }
        const line = l.line - 1;
        const valid = l.branchesValid ?? 0;
        const covered = l.branchesCovered ?? 0;
        if (!l.hit) {
            marks.missed.push(line);
        } else if (valid > 0 && covered < valid) {
            marks.partial.push({ line, covered, valid });
        } else {
            marks.hit.push(line);
        }
    }
    return marks;
}

/** Whether two file paths are the same file (Windows: case and slashes do not matter). */
export function samePath(a: string, b: string): boolean {
    return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
}

/** The summary of `dotnetX86.coverageChanged` / `dotnetX86.coverage` (`lines 56% · branches 40%`). */
export function coverageSummary(body: { lineRate?: number; branchRate?: number; linesValid?: number; branchesValid?: number }, labels: { lines: string; branches: string }): string {
    const percent = (rate: number | undefined) => `${Math.round((rate ?? 0) * 100)}%`;
    const parts = [`${labels.lines} ${percent(body.lineRate)}`];
    if ((body.branchesValid ?? 0) > 0) {
        parts.push(`${labels.branches} ${percent(body.branchRate)}`);
    }
    return parts.join(' · ');
}
