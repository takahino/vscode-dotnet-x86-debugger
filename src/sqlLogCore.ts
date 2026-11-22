// SQL log: the statements the engine read from ADO.NET commands (OracleCommand, SqlCommand, ...) at the provider
// (`netdbg.sqlExecuted`), shown with the parameter values filled in. Kept free of the vscode module so it can be
// tested alone. Hooking the provider and not the caller means a home-made data access component in between does not
// matter: every statement passes through the provider.

export type ParameterKind = 'null' | 'string' | 'number' | 'datetime' | 'binary' | 'other';

export interface SqlParameter {
    /** Without the prefix (":", "@"). */
    name: string;
    kind: ParameterKind;
    /** string: the text; number / other: ToString(); datetime: "yyyy-MM-dd HH:mm:ss.fff"; binary: hex; null: empty. */
    value: string;
    /** "Input", "Output", "InputOutput" or "ReturnValue". */
    direction: string;
}

export interface SqlCommandInfo {
    commandText: string;
    /** "Text", "StoredProcedure" or "TableDirect". */
    commandType: string;
    parameters: SqlParameter[];
    /** Oracle only: false (the default) binds by position, whatever the parameters are called. */
    bindByName?: boolean;
    dataSource?: string;
    /** The command has more parameters than were read. */
    truncated?: boolean;
}

export type SqlDialect = 'oracle' | 'sqlserver' | 'generic';

/** The SQL flavor of the provider's command type, for literals ("Oracle.ManagedDataAccess.Client.OracleCommand"). */
export function dialectOf(typeName: string): SqlDialect {
    if (/\.Oracle[A-Za-z]*Command$|^Oracle/.test(typeName)) {
        return 'oracle';
    }
    return /\.SqlCommand$/.test(typeName) ? 'sqlserver' : 'generic';
}

function literal(p: SqlParameter, dialect: SqlDialect): string {
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    switch (p.kind) {
        case 'null':
            return 'NULL';
        case 'number':
            return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(p.value) ? p.value : quote(p.value);
        case 'datetime':
            if (dialect === 'oracle') {
                return `TO_TIMESTAMP(${quote(p.value)}, 'YYYY-MM-DD HH24:MI:SS.FF3')`;
            }
            return quote(dialect === 'sqlserver' ? p.value.replace(' ', 'T') : p.value);
        case 'binary': {
            const hex = p.value.replace('…', '');
            return dialect === 'oracle' ? `HEXTORAW('${hex}')` : dialect === 'sqlserver' ? `0x${hex}` : `X'${hex}'`;
        }
        case 'other':
            if (p.value === 'True' || p.value === 'False') {
                return p.value === 'True' ? '1' : '0';
            }
            return quote(p.value);
        default:
            return quote(p.value);
    }
}

/**
 * The statement with every parameter placeholder (":name", "@name", "?") replaced by the literal value, ready to paste
 * into a SQL tool. Placeholders inside string literals, quoted identifiers and comments are left alone. A stored
 * procedure becomes the call that runs it.
 */
export function substituteParameters(info: SqlCommandInfo, dialect: SqlDialect): string {
    if (info.commandType === 'StoredProcedure') {
        const args = info.parameters.filter((p) => p.direction !== 'ReturnValue');
        if (dialect === 'oracle') {
            return `BEGIN ${info.commandText}(${args.map((p) => `${p.name} => ${literal(p, dialect)}`).join(', ')}); END;`;
        }
        return `EXEC ${info.commandText}${args.length ? ' ' : ''}${args.map((p) => `@${p.name} = ${literal(p, dialect)}`).join(', ')}`;
    }

    const sql = info.commandText;
    const byName = new Map(info.parameters.map((p) => [p.name.toLowerCase(), p]));
    // Oracle binds by position unless BindByName is set: the n-th distinct placeholder gets the n-th parameter.
    const byPosition = dialect === 'oracle' && info.bindByName === false;
    const seen: string[] = [];
    let positional = 0;
    let out = '';
    let i = 0;
    const word = /[A-Za-z0-9_$#]/;
    while (i < sql.length) {
        const c = sql[i];
        const next = sql[i + 1] ?? '';
        if (c === "'" || c === '"') {
            // A string literal or quoted identifier; a doubled quote inside is an escaped quote.
            let j = i + 1;
            while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) {
                j += sql[j] === c ? 2 : 1;
            }
            out += sql.slice(i, j + 1);
            i = j + 1;
        } else if (c === '-' && next === '-') {
            const end = sql.indexOf('\n', i);
            const j = end < 0 ? sql.length : end;
            out += sql.slice(i, j);
            i = j;
        } else if (c === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2);
            const j = end < 0 ? sql.length : end + 2;
            out += sql.slice(i, j);
            i = j;
        } else if ((c === ':' || c === '@') && /[A-Za-z0-9_]/.test(next) && !word.test(sql[i - 1] ?? '') && sql[i - 1] !== c && sql[i - 1] !== ':') {
            let j = i + 1;
            while (j < sql.length && word.test(sql[j])) {
                j++;
            }
            const name = sql.slice(i + 1, j).toLowerCase();
            let param: SqlParameter | undefined;
            if (byPosition) {
                if (!seen.includes(name)) {
                    seen.push(name);
                }
                param = info.parameters[seen.indexOf(name)];
            } else {
                param = byName.get(name);
            }
            out += param ? literal(param, dialect) : sql.slice(i, j);
            i = j;
        } else if (c === '?' && dialect === 'generic') {
            const param = info.parameters[positional++];
            out += param ? literal(param, dialect) : c;
            i++;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/** The statement on one line, cut at `max` characters (for lists). */
export function summarizeSql(sql: string, max = 100): string {
    const oneLine = sql.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** The same statement written with other whitespace is the same statement (for counting repeats). */
export function normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

export interface CallerFrame {
    name: string;
    source?: { path?: string };
    line?: number;
}

const FRAMEWORK_PREFIXES = ['System.', 'Microsoft.', 'Oracle.', 'MS.', 'Windows.'];

/**
 * The frame to show as the caller of a statement: the first one of the user's code (it has a source file), else the
 * first outside the framework and the provider (a home-made data access component without symbols).
 */
export function callerOf(frames: readonly CallerFrame[]): CallerFrame | undefined {
    return frames.find((f) => f.source?.path) ?? frames.find((f) => !FRAMEWORK_PREFIXES.some((p) => f.name.startsWith(p))) ?? frames[0];
}

/** Method names without the argument list: "MyDb.Query(String, ...)" -> "MyDb.Query". */
export function shortFrameName(name: string): string {
    return name.replace(/\(.*$/s, '');
}
