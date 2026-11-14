// Builds the Markdown debug session report. vscode-free so it can be checked with plain Node.

export interface ReportSession {
    name: string;
    program?: string;
    request?: string;
    start?: number;
    end?: number;
    exitCode?: number;
}

export interface ReportStop {
    n: number;
    time: number;
    reason: string;
    functionName: string;
    sourcePath?: string;
    line: number;
    changes: { name: string; value: string; change: 'new' | 'changed' }[];
}

export interface ReportException {
    time: number;
    typeName: string;
    message: string;
    stopped: boolean;
    functionName?: string;
    sourcePath?: string;
    line?: number;
}

export interface ReportTrackedHit {
    time: number;
    location: string;
    values: { expression: string; value: string; error?: string }[];
}

export interface ReportModule {
    name: string;
    path?: string;
    symbolsLoaded: boolean;
}

export interface ReportData {
    session: ReportSession;
    stops: ReportStop[];
    exceptions: ReportException[];
    tracked: ReportTrackedHit[];
    modules: ReportModule[];
    createdAt: number;
}

/** Localizer with the same contract as vscode.l10n.t ({0}, {1} placeholders). */
export type Translate = (message: string, ...args: (string | number)[]) => string;

/** Timer values are recorded by the relay as tracked values named "⏱ name (ms)". */
const TIMER_PREFIX = '⏱ ';
const MAX_VALUE_LENGTH = 80;

export function buildReport(data: ReportData, t: Translate, relative: (p: string) => string = (p) => p): string {
    const lines: string[] = [];
    const s = data.session;
    const location = (sourcePath: string | undefined, line: number | undefined) => (sourcePath ? `${relative(sourcePath)}:${line ?? '?'}` : '');

    lines.push(`# ${t('Debug session report: {0}', s.name)}`, '');
    lines.push(table([t('Item'), t('Value')], [
        [t('Program'), s.program ? code(s.program) : ''],
        [t('Request'), s.request ?? ''],
        [t('Started'), s.start ? formatTime(s.start, true) : ''],
        [t('Ended'), s.end ? formatTime(s.end, true) : t('(still running)')],
        [t('Duration'), s.start ? formatDuration((s.end ?? data.createdAt) - s.start) : ''],
        [t('Exit code'), s.exitCode === undefined ? '' : String(s.exitCode)],
        [t('Stops'), String(data.stops.length)],
        [t('Exceptions'), String(data.exceptions.length)],
    ]));

    lines.push('', `## ${t('Stops (step history)')}`, '');
    if (data.stops.length === 0) {
        lines.push(t('None.'));
    } else {
        lines.push(table(['#', t('Time'), t('Function'), t('Location'), t('Reason'), t('Changed values')],
            data.stops.map((e) => [
                String(e.n),
                formatTime(e.time),
                code(e.functionName),
                location(e.sourcePath, e.line),
                e.reason,
                e.changes.map((c) => `${code(`${c.name} = ${truncate(c.value)}`)}${c.change === 'new' ? ` (${t('new')})` : ''}`).join('<br>'),
            ])));
    }

    lines.push('', `## ${t('Exceptions')}`, '');
    if (data.exceptions.length === 0) {
        lines.push(t('None.'));
    } else {
        const byType = new Map<string, number>();
        data.exceptions.forEach((e) => byType.set(e.typeName, (byType.get(e.typeName) ?? 0) + 1));
        lines.push(table([t('Type'), t('Count')], [...byType].sort((a, b) => b[1] - a[1]).map(([type, n]) => [code(type), String(n)])), '');
        lines.push(table([t('Time'), t('Type'), t('Message'), t('Location'), t('Stopped')],
            data.exceptions.map((e) => [formatTime(e.time), code(e.typeName), truncate(e.message), location(e.sourcePath, e.line), e.stopped ? t('yes') : ''])));
    }

    const series = collectSeries(data.tracked);
    const timers = [...series].filter(([expr]) => expr.startsWith(TIMER_PREFIX));
    const values = [...series].filter(([expr]) => !expr.startsWith(TIMER_PREFIX));

    lines.push('', `## ${t('Section timings')}`, '');
    if (timers.length === 0) {
        lines.push(t('None.'));
    } else {
        lines.push(table([t('Timer'), t('Location'), t('Runs'), t('Min (ms)'), t('Avg (ms)'), t('Max (ms)'), t('Total (ms)')],
            timers.map(([expr, sr]) => {
                const ms = sr.numbers;
                const total = ms.reduce((a, b) => a + b, 0);
                return [code(expr.slice(TIMER_PREFIX.length).replace(/ \(ms\)$/, '')), [...sr.locations].join(', '), String(ms.length),
                    ms.length ? String(Math.min(...ms)) : '', ms.length ? (total / ms.length).toFixed(1) : '', ms.length ? String(Math.max(...ms)) : '', String(total)];
            })));
    }

    lines.push('', `## ${t('Value trend')}`, '');
    if (values.length === 0) {
        lines.push(t('None.'));
    } else {
        lines.push(table([t('Expression'), t('Location'), t('Records'), t('First'), t('Last'), t('Min'), t('Max')],
            values.map(([expr, sr]) => {
                const numeric = sr.numbers.length === sr.values.length && sr.numbers.length > 0;
                return [code(expr), [...sr.locations].join(', '), String(sr.values.length), code(truncate(sr.values[0] ?? '')), code(truncate(sr.values[sr.values.length - 1] ?? '')),
                    numeric ? String(Math.min(...sr.numbers)) : '', numeric ? String(Math.max(...sr.numbers)) : ''];
            })));
    }

    const withSymbols = data.modules.filter((m) => m.symbolsLoaded);
    lines.push('', `## ${t('Modules')}`, '');
    lines.push(t('{0} modules loaded, {1} with symbols.', data.modules.length, withSymbols.length), '');
    if (withSymbols.length) {
        lines.push(table([t('Module with symbols'), t('Path')], withSymbols.map((m) => [m.name, m.path ? code(m.path) : ''])));
    }

    lines.push('', `---`, t('Created by .NET x86 Debugger at {0}.', formatTime(data.createdAt, true)), '');
    return lines.join('\n');
}

interface Series {
    values: string[];
    numbers: number[];
    locations: Set<string>;
}

function collectSeries(hits: ReportTrackedHit[]): Map<string, Series> {
    const series = new Map<string, Series>();
    for (const hit of hits) {
        for (const v of hit.values) {
            if (v.error) {
                continue;
            }
            const sr = series.get(v.expression) ?? { values: [], numbers: [], locations: new Set<string>() };
            sr.values.push(v.value);
            const n = Number(v.value);
            if (v.value.trim() !== '' && Number.isFinite(n)) {
                sr.numbers.push(n);
            }
            sr.locations.add(hit.location);
            series.set(v.expression, sr);
        }
    }
    return series;
}

function table(header: string[], rows: string[][]): string {
    const cell = (c: string) => c.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
    return [header, header.map(() => '---'), ...rows].map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n');
}

/** Inline code that survives backticks inside the value. */
function code(text: string): string {
    if (!text) {
        return '';
    }
    const fence = text.includes('`') ? '``' : '`';
    return `${fence}${fence.length > 1 ? ' ' : ''}${text}${fence.length > 1 ? ' ' : ''}${fence}`;
}

function truncate(value: string): string {
    const oneLine = value.replace(/\s*\r?\n\s*/g, ' ');
    return oneLine.length > MAX_VALUE_LENGTH ? `${oneLine.slice(0, MAX_VALUE_LENGTH)}…` : oneLine;
}

function formatTime(time: number, withDate = false): string {
    const d = new Date(time);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}` : clock;
}

function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms} ms`;
    }
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${(ms / 1000).toFixed(1)} s`;
}
