// Journal records from the engine (`netdbg.journal`): kinds without a dedicated view, and helpers for SQL duration
// updates. Kept free of the vscode module so it can be tested alone.

export const JOURNAL_REQUEST = 'netdbg.journal';
export const TRANSACTIONS_REQUEST = 'netdbg.transactions';

/** Wake-up events that mean the journal may have new records of the kinds the Records view shows. */
export const RECORDS_EVENTS = [
    'netdbg.dialogShown',
    'netdbg.bindingFailed',
    'netdbg.transaction',
    'netdbg.childProcess',
    'netdbg.environment',
] as const;

/** Kinds shown in the Records view (SQL / exception / event keep their own views). */
export const RECORDS_KINDS = ['dialog', 'binding', 'transaction', 'process', 'environment'] as const;
export type RecordsKind = (typeof RECORDS_KINDS)[number];

export const SQL_COMPLETED_EVENT = 'netdbg.sqlCompleted';

export interface JournalRecord {
    seq: number;
    time: number;
    kind: string;
    [key: string]: unknown;
}

export interface JournalResponse {
    records: JournalRecord[];
    last: number;
    dropped: number;
}

export interface OpenTransaction {
    transactionId: number;
    threadId: number;
    elapsedMs: number;
    caller?: { name?: string; source?: { path?: string; name?: string }; line?: number };
    statements?: number[];
}

export interface JournalCursor {
    /** Last seq already merged (pass as `after`). */
    after: number;
    dropped: number;
}

export interface JournalMerge {
    records: JournalRecord[];
    cursor: JournalCursor;
    /** True when the engine dropped older records since the last merge. */
    droppedGrew: boolean;
}

/** Merges `body.records` into `existing` by `seq` (newer seq wins on collision). Advances the cursor. */
export function mergeJournal(existing: JournalRecord[], cursor: JournalCursor, body: JournalResponse): JournalMerge {
    const bySeq = new Map(existing.map((r) => [r.seq, r]));
    for (const record of body.records ?? []) {
        if (typeof record.seq !== 'number') {
            continue;
        }
        bySeq.set(record.seq, record);
    }
    const records = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    const dropped = typeof body.dropped === 'number' ? body.dropped : cursor.dropped;
    return {
        records,
        cursor: { after: typeof body.last === 'number' ? body.last : cursor.after, dropped },
        droppedGrew: dropped > cursor.dropped,
    };
}

/** Applies `netdbg.sqlCompleted` to a SQL log entry that kept the journal `seq`. */
export function applySqlCompleted<T extends { seq?: number; durationMs?: number; failed?: boolean }>(
    entries: T[],
    body: { seq?: number; durationMs?: number; failed?: boolean },
): T | undefined {
    if (typeof body.seq !== 'number') {
        return undefined;
    }
    const entry = entries.find((e) => e.seq === body.seq);
    if (!entry) {
        return undefined;
    }
    if (typeof body.durationMs === 'number') {
        entry.durationMs = body.durationMs;
    }
    if (body.failed) {
        entry.failed = true;
    }
    return entry;
}

export interface RecordHeading {
    /** Main label. */
    label: string;
    /** Secondary text (time, duration, …). */
    description: string;
    /** Tooltip body. */
    detail: string;
    /** Source to open, when the record has a caller. */
    source?: { path: string; line?: number };
}

type Caller = { name?: string; source?: { path?: string; name?: string }; line?: number };

function callerOf(record: JournalRecord): Caller | undefined {
    const c = record.caller;
    return c && typeof c === 'object' ? (c as Caller) : undefined;
}

function shortName(name: string | undefined): string {
    if (!name) {
        return '';
    }
    const bare = name.replace(/\(.*$/, '');
    const parts = bare.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : bare;
}

function sourceOf(caller: Caller | undefined): RecordHeading['source'] | undefined {
    const path = caller?.source?.path;
    return path ? { path, line: caller?.line } : undefined;
}

/**
 * The journal stores kind as dialog / binding / …, but to_json merges the body afterwards: a dialog body's
 * `kind` ("messageBox") or a child's `kind` (".NET" / "native") overwrites it. Recover the journal kind from fields.
 */
export function recordsKindOf(record: JournalRecord): RecordsKind | undefined {
    if (record.kind === 'binding' || (record.control !== undefined && record.property !== undefined && record.direction !== undefined)) {
        return 'binding';
    }
    if (record.kind === 'transaction' || record.event === 'begin' || record.event === 'commit' || record.event === 'rollback') {
        return 'transaction';
    }
    if (record.kind === 'environment' || record.runtime !== undefined) {
        return 'environment';
    }
    if (record.kind === 'dialog' || record.kind === 'messageBox' || (typeof record.method === 'string' && /MessageBox\.Show|ShowDialog/.test(record.method))) {
        return 'dialog';
    }
    if (record.kind === 'process' || record.fileName !== undefined) {
        return 'process';
    }
    return undefined;
}

/** One-line heading for a journal record of a Records-view kind. */
export function recordHeading(record: JournalRecord): RecordHeading {
    const caller = callerOf(record);
    const when = typeof record.time === 'number' ? new Date(record.time).toLocaleTimeString() : '';
    switch (recordsKindOf(record)) {
        case 'dialog': {
            const caption = typeof record.caption === 'string' ? record.caption : '';
            const text = typeof record.text === 'string' ? record.text : '';
            const form = typeof record.form === 'string' ? record.form : '';
            const headline = caption && text ? `${caption}: ${text}` : text || caption || form || String(record.method ?? 'Dialog');
            const stopped = record.stopped === true ? ' · stopped' : '';
            const dialogKind = record.kind === 'messageBox' ? 'messageBox' : 'dialog';
            return {
                label: headline,
                description: [shortName(caller?.name), when].filter(Boolean).join(' · ') + stopped,
                detail: [headline, caller?.name, record.method, `kind: ${dialogKind}`].filter(Boolean).join('\n'),
                source: sourceOf(caller),
            };
        }
        case 'binding': {
            const control = String(record.control ?? '?');
            const property = String(record.property ?? '?');
            const member = String(record.member ?? '?');
            const direction = record.direction === 'parse' ? '→' : '←';
            const exception = String(record.exceptionType ?? '').split('.').pop() ?? '';
            const message = String(record.message ?? '');
            return {
                label: `${control}.${property} ${direction} ${member}`,
                description: [exception, when].filter(Boolean).join(' · '),
                detail: [`${control}.${property} ${direction} ${member}`, exception && message ? `${exception}: ${message}` : message || exception, caller?.name].filter(Boolean).join('\n'),
                source: sourceOf(caller),
            };
        }
        case 'transaction': {
            const event = String(record.event ?? 'transaction');
            const id = record.transactionId !== undefined ? `#${record.transactionId}` : '';
            const duration = typeof record.durationMs === 'number' ? `${record.durationMs} ms` : '';
            const statements = Array.isArray(record.statements) ? `${record.statements.length} SQL` : '';
            const note = typeof record.note === 'string' ? record.note : '';
            return {
                label: [event, id].filter(Boolean).join(' '),
                description: [duration, statements, shortName(caller?.name), when, note].filter(Boolean).join(' · '),
                detail: [event, id, duration, statements, caller?.name, note, record.method].filter(Boolean).join('\n'),
                source: sourceOf(caller),
            };
        }
        case 'process': {
            const file = String(record.fileName ?? 'process');
            const pid = record.processId !== undefined ? `pid ${record.processId}` : '';
            const childKind = typeof record.kind === 'string' && record.kind !== 'process' ? record.kind : '';
            const bitness = typeof record.bitness === 'string' ? record.bitness : '';
            const followed = record.followed === true ? 'attaching' : typeof record.notFollowed === 'string' ? String(record.notFollowed) : '';
            const failed = record.failed === true ? 'failed' : '';
            return {
                label: file,
                description: [pid, bitness, childKind, followed, failed, shortName(caller?.name), when].filter(Boolean).join(' · '),
                detail: [file, pid, bitness, childKind, record.arguments, caller?.name, followed || failed].filter(Boolean).join('\n'),
                source: sourceOf(caller),
            };
        }
        case 'environment': {
            const runtime = String(record.runtime ?? 'environment');
            const program = typeof record.program === 'string' ? record.program : '';
            const bitness = typeof record.bitness === 'string' ? record.bitness : '';
            const connections = Array.isArray(record.connectionStrings) ? record.connectionStrings.length : 0;
            return {
                label: runtime,
                description: [bitness, program ? program.split(/[/\\]/).pop() : '', connections ? `${connections} connection string(s)` : '', when].filter(Boolean).join(' · '),
                detail: [runtime, bitness, program, record.commandLine, record.workingDirectory].filter(Boolean).join('\n'),
            };
        }
        default:
            return {
                label: String(record.kind || 'record'),
                description: when,
                detail: JSON.stringify(record, null, 2),
                source: sourceOf(caller),
            };
    }
}

/** Heading for an open transaction from `netdbg.transactions`. */
export function openTransactionHeading(open: OpenTransaction): RecordHeading {
    const caller = open.caller;
    const statements = open.statements?.length ? `${open.statements.length} SQL` : '';
    return {
        label: `open #${open.transactionId}`,
        description: [`${open.elapsedMs} ms`, statements, shortName(caller?.name)].filter(Boolean).join(' · '),
        detail: [`open transaction #${open.transactionId}`, `${open.elapsedMs} ms elapsed`, statements, caller?.name].filter(Boolean).join('\n'),
        source: sourceOf(caller),
    };
}

/** Description fragment for a SQL log row after duration / transaction id are known. */
export function sqlDurationLabel(entry: { durationMs?: number; failed?: boolean; transactionId?: number }): string {
    const parts: string[] = [];
    if (typeof entry.durationMs === 'number') {
        parts.push(`${entry.durationMs} ms`);
    }
    if (entry.failed) {
        parts.push('failed');
    }
    if (typeof entry.transactionId === 'number') {
        parts.push(`tx #${entry.transactionId}`);
    }
    return parts.join(' · ');
}
