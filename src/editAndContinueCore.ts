// Edit and Continue: the parts without VS Code (deciding when to apply, and how to word the result).

/** Custom request: apply the saved edits of the program's sources to the running program. */
export const APPLY_CHANGES_REQUEST = 'dotnetX86.applyChanges';
/** Custom event: the result of `dotnetX86.applyChanges` (also sent when the change came from MCP). */
export const CHANGES_APPLIED_EVENT = 'dotnetX86.changesApplied';

export type ApplyStatus = 'applied' | 'noChanges' | 'rude' | 'errors' | 'failed';

/** A file and line the engine points at: an edit that cannot be applied, or a compile error. */
export interface ApplyProblem {
    file: string;
    line: number;
    column: number;
    message: string;
}

export interface ApplyChangesResult {
    status: ApplyStatus;
    /** One-line summary, worded by the engine. */
    message: string;
    applied: { module: string; methods: number }[];
    problems: ApplyProblem[];
    /** Further reasons (one per line), e.g. why the helper could not start. */
    details: string[];
}

/** Whether saving this document should apply its edit: C# sources only. */
export function isCSharpSource(languageId: string, fileName: string): boolean {
    return languageId === 'csharp' || fileName.toLowerCase().endsWith('.cs');
}

/** The problems as `Program.cs(12,5): message` lines. */
export function describeProblems(problems: readonly ApplyProblem[]): string[] {
    return problems.map((p) => `${fileName(p.file)}(${p.line},${p.column}): ${p.message}`);
}

function fileName(file: string): string {
    const parts = file.split(/[\\/]/);
    return parts[parts.length - 1] || file;
}

/**
 * How to show a result:
 * - applied: a short status bar message;
 * - noChanges: nothing when saving (most saves change nothing the program runs), a message when asked by command;
 * - rude / errors / failed: a warning with the first problem, offering to restart.
 */
export function presentation(result: ApplyChangesResult, byCommand: boolean): { kind: 'status' | 'info' | 'warning' | 'none'; text: string } {
    switch (result.status) {
        case 'applied':
            return { kind: 'status', text: result.message };
        case 'noChanges':
            return byCommand ? { kind: 'info', text: result.details[0] ? `${result.message} ${result.details[0]}` : result.message } : { kind: 'none', text: result.message };
        default: {
            const first = describeProblems(result.problems)[0] ?? result.details[0];
            return { kind: 'warning', text: first ? `${result.message} ${first}` : result.message };
        }
    }
}

/** Reads a response body defensively (an older engine answers differently). */
export function parseResult(body: unknown): ApplyChangesResult {
    const b = (body ?? {}) as Partial<ApplyChangesResult>;
    const status: ApplyStatus = (['applied', 'noChanges', 'rude', 'errors', 'failed'] as const).find((s) => s === b.status) ?? 'failed';
    return {
        status,
        message: typeof b.message === 'string' ? b.message : '',
        applied: Array.isArray(b.applied) ? b.applied : [],
        problems: Array.isArray(b.problems) ? b.problems.filter((p) => p && typeof p.message === 'string') : [],
        details: Array.isArray(b.details) ? b.details.filter((d): d is string => typeof d === 'string') : [],
    };
}
