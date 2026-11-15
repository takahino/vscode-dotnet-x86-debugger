// SQL log: what an ADO.NET command (OracleCommand, SqlCommand, ...) is about to run, read from the stopped program,
// and the SQL text with the parameter values filled in. Kept free of the vscode module so it can be tested alone.
//
// The proxy stops at the provider's Execute* methods (function breakpoints that also bind in code without symbols),
// reads the command with the debugger's expression evaluator and resumes. Hooking the provider and not the caller
// means a home-made data access component in between does not matter: every statement passes through the provider.

/** Methods the SQL log stops at ("Namespace.Type.Method"; every overload of the name). */
export const DEFAULT_SQL_METHODS: readonly string[] = [
    'Oracle.ManagedDataAccess.Client.OracleCommand.ExecuteReader',
    'Oracle.ManagedDataAccess.Client.OracleCommand.ExecuteNonQuery',
    'Oracle.ManagedDataAccess.Client.OracleCommand.ExecuteScalar',
    'Oracle.DataAccess.Client.OracleCommand.ExecuteReader',
    'Oracle.DataAccess.Client.OracleCommand.ExecuteNonQuery',
    'Oracle.DataAccess.Client.OracleCommand.ExecuteScalar',
    'System.Data.SqlClient.SqlCommand.ExecuteReader',
    'System.Data.SqlClient.SqlCommand.ExecuteNonQuery',
    'System.Data.SqlClient.SqlCommand.ExecuteScalar',
    'Microsoft.Data.SqlClient.SqlCommand.ExecuteReader',
    'Microsoft.Data.SqlClient.SqlCommand.ExecuteNonQuery',
    'Microsoft.Data.SqlClient.SqlCommand.ExecuteScalar',
    'System.Data.OleDb.OleDbCommand.ExecuteReader',
    'System.Data.OleDb.OleDbCommand.ExecuteNonQuery',
    'System.Data.OleDb.OleDbCommand.ExecuteScalar',
    'System.Data.Odbc.OdbcCommand.ExecuteReader',
    'System.Data.Odbc.OdbcCommand.ExecuteNonQuery',
    'System.Data.Odbc.OdbcCommand.ExecuteScalar',
];

/** More parameters than this are not read (each costs a few evaluations while the program is stopped). */
export const MAX_PARAMETERS = 100;
/** Bytes of a binary parameter that are read. */
const MAX_BINARY_BYTES = 32;

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

export interface EvalResult {
    ok: boolean;
    result: string;
    type?: string;
    variablesReference?: number;
}

/** What the capture needs from the debugger; the proxy gives it the stopped frame. */
export interface ExpressionReader {
    evaluate(expression: string): Promise<EvalResult>;
    variables(variablesReference: number): Promise<{ name: string; value: string }[]>;
}

const NUMERIC_TYPES = new Set(['int', 'long', 'short', 'byte', 'sbyte', 'uint', 'ulong', 'ushort', 'double', 'float', 'decimal']);

/** The text of a string the debugger shows as a C# literal ("a\"b" -> a"b). */
export function unquoteDebuggerString(text: string): string {
    const m = /^"([\s\S]*)"$/.exec(text);
    if (!m) {
        return text;
    }
    return m[1].replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,4}|[\s\S])/g, (_all, e: string) => {
        switch (e[0]) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case '0': return '\0';
            case 'a': return '\x07';
            case 'b': return '\b';
            case 'f': return '\f';
            case 'v': return '\v';
            case 'u':
            case 'x': return e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e;
            default: return e;
        }
    });
}

/** Reads the command the stopped frame is executing (`this`); undefined when `this` is not a command. */
export async function captureSqlCommand(reader: ExpressionReader, typeName: string): Promise<SqlCommandInfo | undefined> {
    const text = async (expression: string): Promise<string | undefined> => {
        const r = await reader.evaluate(expression);
        return r.ok ? unquoteDebuggerString(r.result) : undefined;
    };

    const commandText = await text('this.CommandText');
    if (commandText === undefined) {
        return undefined;
    }
    const info: SqlCommandInfo = {
        commandText: commandText === 'null' ? '' : commandText,
        commandType: (await text('this.CommandType.ToString()')) ?? 'Text',
        parameters: [],
    };
    if (/^Oracle/.test(typeName.split('.').pop() ?? '')) {
        info.bindByName = (await reader.evaluate('this.BindByName')).result === 'true';
    }
    info.dataSource = await text('this.Connection.DataSource');

    const count = Number((await reader.evaluate('this.Parameters.Count')).result) || 0;
    info.truncated = count > MAX_PARAMETERS || undefined;
    for (let i = 0; i < Math.min(count, MAX_PARAMETERS); i++) {
        info.parameters.push(await readParameter(reader, i));
    }
    return info;
}

async function readParameter(reader: ExpressionReader, index: number): Promise<SqlParameter> {
    const p = `this.Parameters[${index}]`;
    const text = async (expression: string): Promise<string | undefined> => {
        const r = await reader.evaluate(expression);
        return r.ok ? unquoteDebuggerString(r.result) : undefined;
    };
    const name = ((await text(`${p}.ParameterName`)) ?? `#${index + 1}`).replace(/^[:@?]/, '');
    const direction = (await text(`${p}.Direction.ToString()`)) ?? 'Input';
    const base = { name, direction };

    const v = await reader.evaluate(`${p}.Value`);
    if (!v.ok) {
        return { ...base, kind: 'other', value: '?' };
    }
    const type = v.type ?? '';
    if (v.result === 'null' || type === 'System.DBNull') {
        return { ...base, kind: 'null', value: '' };
    }
    if (type === 'string') {
        return { ...base, kind: 'string', value: unquoteDebuggerString(v.result) };
    }
    if (type === 'System.DateTime') {
        const formatted = await text(`${p}.Value.ToString("yyyy-MM-dd HH:mm:ss.fff")`);
        return { ...base, kind: 'datetime', value: formatted ?? v.result };
    }
    if (type === 'byte[]') {
        return { ...base, kind: 'binary', value: await readBytes(reader, v) };
    }
    const shown = (await text(`${p}.Value.ToString()`)) ?? v.result;
    return { ...base, kind: NUMERIC_TYPES.has(type) ? 'number' : 'other', value: shown };
}

/** "010203" for a byte[] shown as "{byte[3]}" (at most MAX_BINARY_BYTES bytes, then "…"). */
async function readBytes(reader: ExpressionReader, value: EvalResult): Promise<string> {
    if (!value.variablesReference) {
        return '';
    }
    const length = Number(/\[(\d+)\]/.exec(value.result)?.[1] ?? 0);
    const items = (await reader.variables(value.variablesReference)).filter((v) => /^\[\d+\]$/.test(v.name)).slice(0, MAX_BINARY_BYTES);
    const hex = items.map((v) => (Number(v.value) & 0xff).toString(16).padStart(2, '0')).join('');
    return length > items.length ? `${hex}…` : hex;
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
