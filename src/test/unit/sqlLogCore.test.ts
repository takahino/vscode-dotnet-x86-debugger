// SQL log without a debugger: reading a command through a fake expression reader, and the SQL with the values filled in.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
    DEFAULT_SQL_METHODS,
    EvalResult,
    ExpressionReader,
    MAX_PARAMETERS,
    SqlCommandInfo,
    SqlParameter,
    callerOf,
    captureSqlCommand,
    dialectOf,
    normalizeSql,
    shortFrameName,
    substituteParameters,
    summarizeSql,
    unquoteDebuggerString,
} from '../../sqlLogCore';

/** An expression reader answering from a table, as netcoredbg would (strings as C# literals, objects as {Type}). */
function reader(values: Record<string, EvalResult | string>, variables: Record<number, { name: string; value: string }[]> = {}): ExpressionReader & { asked: string[] } {
    const asked: string[] = [];
    return {
        asked,
        evaluate: async (expression) => {
            asked.push(expression);
            const v = values[expression];
            if (v === undefined) {
                return { ok: false, result: '' };
            }
            return typeof v === 'string' ? { ok: true, result: v } : v;
        },
        variables: async (ref) => variables[ref] ?? [],
    };
}

const param = (name: string, kind: SqlParameter['kind'], value: string, direction = 'Input'): SqlParameter => ({ name, kind, value, direction });
const command = (commandText: string, parameters: SqlParameter[], extra: Partial<SqlCommandInfo> = {}): SqlCommandInfo => ({ commandText, commandType: 'Text', parameters, ...extra });

describe('unquoteDebuggerString', () => {
    it('reads the C# literal netcoredbg shows for a string', () => {
        assert.equal(unquoteDebuggerString('"O\'Brien"'), "O'Brien");
        assert.equal(unquoteDebuggerString('"a\\"b\\\\c"'), 'a"b\\c');
        assert.equal(unquoteDebuggerString('"line1\\r\\nline2\\tx"'), 'line1\r\nline2\tx');
        assert.equal(unquoteDebuggerString('"\\u3042\\x41"'), 'あA');
    });

    it('leaves anything that is not a string literal as it is', () => {
        assert.equal(unquoteDebuggerString('42'), '42');
        assert.equal(unquoteDebuggerString('{System.DateTime}'), '{System.DateTime}');
        assert.equal(unquoteDebuggerString('null'), 'null');
    });
});

describe('captureSqlCommand', () => {
    const p = (i: number) => `this.Parameters[${i}]`;

    it('reads the text, the type, Oracle\'s BindByName, the data source and each parameter by its type', async () => {
        const r = reader({
            'this.CommandText': '"SELECT * FROM EMP WHERE ENAME = :name"',
            'this.CommandType.ToString()': '"Text"',
            'this.BindByName': 'true',
            'this.Connection.DataSource': '"db01/orcl"',
            'this.Parameters.Count': '6',
            [`${p(0)}.ParameterName`]: '":name"',
            [`${p(0)}.Direction.ToString()`]: '"Input"',
            [`${p(0)}.Value`]: { ok: true, result: '"O\'Brien"', type: 'string' },
            [`${p(1)}.ParameterName`]: '"since"',
            [`${p(1)}.Direction.ToString()`]: '"Input"',
            [`${p(1)}.Value`]: { ok: true, result: '{System.DateTime}', type: 'System.DateTime', variablesReference: 3 },
            [`${p(1)}.Value.ToString("yyyy-MM-dd HH:mm:ss.fff")`]: '"2024-04-01 13:05:09.123"',
            [`${p(2)}.ParameterName`]: '"sal"',
            [`${p(2)}.Direction.ToString()`]: '"Input"',
            [`${p(2)}.Value`]: { ok: true, result: '{double}', type: 'double', variablesReference: 4 },
            [`${p(2)}.Value.ToString()`]: '"2.5"',
            [`${p(3)}.ParameterName`]: '"no"',
            [`${p(3)}.Direction.ToString()`]: '"Input"',
            [`${p(3)}.Value`]: { ok: true, result: '{System.DBNull}', type: 'System.DBNull' },
            [`${p(4)}.ParameterName`]: '"img"',
            [`${p(4)}.Direction.ToString()`]: '"Input"',
            [`${p(4)}.Value`]: { ok: true, result: '{byte[3]}', type: 'byte[]', variablesReference: 7 },
            [`${p(5)}.ParameterName`]: '"result"',
            [`${p(5)}.Direction.ToString()`]: '"Output"',
            [`${p(5)}.Value`]: { ok: true, result: 'null', type: 'object' },
        }, { 7: [{ name: '[0]', value: '1' }, { name: '[1]', value: '171' }, { name: '[2]', value: '255' }] });

        const info = await captureSqlCommand(r, 'Oracle.ManagedDataAccess.Client.OracleCommand');
        assert.deepEqual(info, {
            commandText: 'SELECT * FROM EMP WHERE ENAME = :name',
            commandType: 'Text',
            bindByName: true,
            dataSource: 'db01/orcl',
            truncated: undefined,
            parameters: [
                param('name', 'string', "O'Brien"),
                param('since', 'datetime', '2024-04-01 13:05:09.123'),
                param('sal', 'number', '2.5'),
                param('no', 'null', ''),
                param('img', 'binary', '01abff'),
                param('result', 'null', '', 'Output'),
            ],
        });
    });

    it('asks BindByName of Oracle commands only', async () => {
        const values = { 'this.CommandText': '"SELECT 1"', 'this.Parameters.Count': '0' };
        const sql = reader(values);
        await captureSqlCommand(sql, 'System.Data.SqlClient.SqlCommand');
        assert.ok(!sql.asked.includes('this.BindByName'));
        const oracle = reader(values);
        const info = await captureSqlCommand(oracle, 'Oracle.DataAccess.Client.OracleCommand');
        assert.ok(oracle.asked.includes('this.BindByName'));
        assert.equal(info?.bindByName, false); // not readable: the default (by position)
    });

    it('returns nothing when the stopped frame is not a command', async () => {
        assert.equal(await captureSqlCommand(reader({}), 'X.Command'), undefined);
    });

    it('treats a null CommandText as empty and keeps what it can when a value cannot be read', async () => {
        const info = await captureSqlCommand(reader({
            'this.CommandText': 'null',
            'this.Parameters.Count': '1',
            // ParameterName, Direction and Value all fail
        }), 'X.Command');
        assert.equal(info?.commandText, '');
        assert.equal(info?.commandType, 'Text');
        assert.deepEqual(info?.parameters, [param('#1', 'other', '?')]);
    });

    it('reads at most MAX_PARAMETERS parameters and says so', async () => {
        const r = reader({ 'this.CommandText': '"INSERT"', 'this.Parameters.Count': String(MAX_PARAMETERS + 5) });
        const info = await captureSqlCommand(r, 'X.Command');
        assert.equal(info?.parameters.length, MAX_PARAMETERS);
        assert.equal(info?.truncated, true);
    });

    it('cuts long binary values and marks them', async () => {
        const bytes = Array.from({ length: 40 }, (_v, i) => ({ name: `[${i}]`, value: String(i) }));
        const info = await captureSqlCommand(reader({
            'this.CommandText': '"X"',
            'this.Parameters.Count': '1',
            'this.Parameters[0].ParameterName': '"b"',
            'this.Parameters[0].Value': { ok: true, result: '{byte[40]}', type: 'byte[]', variablesReference: 1 },
        }, { 1: bytes }), 'X.Command');
        const value = info!.parameters[0].value;
        assert.equal(value.length, 32 * 2 + 1);
        assert.ok(value.startsWith('000102'));
        assert.ok(value.endsWith('…'));
    });

    it('falls back to the shown value when ToString() fails, and calls non-numbers "other"', async () => {
        const info = await captureSqlCommand(reader({
            'this.CommandText': '"X"',
            'this.Parameters.Count': '2',
            'this.Parameters[0].Value': { ok: true, result: '1234.5', type: 'decimal' },
            'this.Parameters[1].Value': { ok: true, result: '{System.Guid}', type: 'System.Guid' },
            'this.Parameters[1].Value.ToString()': '"11111111-2222-3333-4444-555555555555"',
        }), 'X.Command');
        assert.deepEqual(info?.parameters.map((x) => [x.kind, x.value]), [
            ['number', '1234.5'],
            ['other', '11111111-2222-3333-4444-555555555555'],
        ]);
    });
});

describe('dialectOf', () => {
    it('tells the SQL flavor from the command type', () => {
        assert.equal(dialectOf('Oracle.ManagedDataAccess.Client.OracleCommand'), 'oracle');
        assert.equal(dialectOf('Oracle.DataAccess.Client.OracleCommand'), 'oracle');
        assert.equal(dialectOf('System.Data.SqlClient.SqlCommand'), 'sqlserver');
        assert.equal(dialectOf('Microsoft.Data.SqlClient.SqlCommand'), 'sqlserver');
        assert.equal(dialectOf('System.Data.OleDb.OleDbCommand'), 'generic');
        assert.equal(dialectOf('Npgsql.NpgsqlCommand'), 'generic');
    });

    it('covers every default provider method', () => {
        for (const m of DEFAULT_SQL_METHODS) {
            assert.match(m, /^[\w.]+\.\w+Command\.Execute(Reader|NonQuery|Scalar)$/);
        }
    });
});

describe('substituteParameters', () => {
    it('fills in Oracle named parameters, by name and ignoring case', () => {
        const sql = substituteParameters(command('SELECT * FROM T WHERE A = :Name AND B >= :since AND C = :name', [
            param('name', 'string', "O'Brien"),
            param('since', 'datetime', '2024-04-01 00:00:00.000'),
        ], { bindByName: true }), 'oracle');
        assert.equal(sql, "SELECT * FROM T WHERE A = 'O''Brien' AND B >= TO_TIMESTAMP('2024-04-01 00:00:00.000', 'YYYY-MM-DD HH24:MI:SS.FF3') AND C = 'O''Brien'");
    });

    it('binds Oracle placeholders by position when BindByName is off, a repeated name taking the same value', () => {
        // The parameters are called differently from the placeholders: Oracle only looks at their order.
        const sql = substituteParameters(command('UPDATE T SET X = :x WHERE Y = :y OR Z = :x', [param('p1', 'number', '1'), param('p2', 'number', '2')], { bindByName: false }), 'oracle');
        assert.equal(sql, 'UPDATE T SET X = 1 WHERE Y = 2 OR Z = 1');
    });

    it('fills in SQL Server @parameters, and leaves @@globals alone', () => {
        const sql = substituteParameters(command('INSERT INTO T VALUES (@id, @when, @bin, @flag); SELECT @@IDENTITY', [
            param('@id', 'number', '7'),
            param('when', 'datetime', '2024-04-01 13:05:09.123'),
            param('bin', 'binary', '01ab'),
            param('flag', 'other', 'True'),
        ].map((p) => ({ ...p, name: p.name.replace(/^@/, '') }))), 'sqlserver');
        assert.equal(sql, "INSERT INTO T VALUES (7, '2024-04-01T13:05:09.123', 0x01ab, 1); SELECT @@IDENTITY");
    });

    it('fills in ? placeholders in order for OleDb / Odbc', () => {
        const sql = substituteParameters(command('SELECT * FROM T WHERE A = ? AND B = ? AND C = ?', [param('a', 'string', 'x'), param('b', 'null', '')]), 'generic');
        assert.equal(sql, "SELECT * FROM T WHERE A = 'x' AND B = NULL AND C = ?");
    });

    it('leaves placeholders in string literals, quoted identifiers and comments alone', () => {
        const sql = substituteParameters(command([
            "SELECT ':a' AS \"col:a\", -- :a here",
            '  /* :a there */ X FROM T WHERE Y = :a AND Z = \'it\'\':a\'',
        ].join('\n'), [param('a', 'number', '5')], { bindByName: true }), 'oracle');
        assert.equal(sql, [
            "SELECT ':a' AS \"col:a\", -- :a here",
            "  /* :a there */ X FROM T WHERE Y = 5 AND Z = 'it'':a'",
        ].join('\n'));
    });

    it('does not take PL/SQL assignments, casts, database links or other names for placeholders', () => {
        const sql = substituteParameters(command('BEGIN x := :a; END; SELECT y::int FROM T@remote WHERE a:b = 1', [param('a', 'number', '1')], { bindByName: true }), 'oracle');
        assert.equal(sql, 'BEGIN x := 1; END; SELECT y::int FROM T@remote WHERE a:b = 1');
    });

    it('keeps a placeholder that has no parameter', () => {
        assert.equal(substituteParameters(command('SELECT :missing FROM DUAL', [], { bindByName: true }), 'oracle'), 'SELECT :missing FROM DUAL');
    });

    it('writes numbers as numbers only when they are numbers', () => {
        const sql = substituteParameters(command('SELECT :a, :b, :c', [param('a', 'number', '-12.5'), param('b', 'number', '1E+21'), param('c', 'number', 'NaN')], { bindByName: true }), 'oracle');
        assert.equal(sql, "SELECT -12.5, 1E+21, 'NaN'");
    });

    it('writes binary values per dialect, without the cut mark', () => {
        const info = command('SELECT :b', [param('b', 'binary', '0102…')], { bindByName: true });
        assert.equal(substituteParameters(info, 'oracle'), "SELECT HEXTORAW('0102')");
        assert.equal(substituteParameters({ ...info, commandText: 'SELECT @b' }, 'sqlserver'), 'SELECT 0x0102');
        assert.equal(substituteParameters({ ...info, commandText: 'SELECT ?' }, 'generic'), "SELECT X'0102'");
    });

    it('turns a stored procedure into the call that runs it, without its return value', () => {
        const proc = command('PKG.SAVE_ORDER', [param('id', 'number', '3'), param('note', 'string', 'a\'b'), param('ret', 'number', '0', 'ReturnValue')], { commandType: 'StoredProcedure' });
        assert.equal(substituteParameters(proc, 'oracle'), "BEGIN PKG.SAVE_ORDER(id => 3, note => 'a''b'); END;");
        assert.equal(substituteParameters(proc, 'sqlserver'), "EXEC PKG.SAVE_ORDER @id = 3, @note = 'a''b'");
        assert.equal(substituteParameters(command('dbo.Ping', [], { commandType: 'StoredProcedure' }), 'sqlserver'), 'EXEC dbo.Ping');
    });
});

describe('summarizeSql / normalizeSql', () => {
    it('puts a statement on one line, cut at the limit', () => {
        assert.equal(summarizeSql('SELECT *\n  FROM   T\r\n WHERE A = 1'), 'SELECT * FROM T WHERE A = 1');
        assert.equal(summarizeSql('SELECT 1234567890', 10), 'SELECT 12…');
    });

    it('treats statements that differ only in whitespace as the same', () => {
        assert.equal(normalizeSql('SELECT  *\nFROM T '), normalizeSql('SELECT * FROM T'));
        assert.notEqual(normalizeSql('SELECT * FROM T'), normalizeSql('select * from t'));
    });
});

describe('callerOf / shortFrameName', () => {
    it('prefers the first frame of the user\'s code (with a source file)', () => {
        const frames = [{ name: 'MyDal.Db.Query()' }, { name: 'OrderForm.Load()', source: { path: 'C:\\app\\OrderForm.cs' }, line: 12 }];
        assert.equal(callerOf(frames)?.name, 'OrderForm.Load()');
    });

    it('else the first frame outside the framework and the provider (a home-made component without symbols)', () => {
        const frames = [{ name: 'System.Data.Common.DbDataAdapter.Fill()' }, { name: 'Oracle.X.Y()' }, { name: 'Company.Dal.Run()' }];
        assert.equal(callerOf(frames)?.name, 'Company.Dal.Run()');
        assert.equal(callerOf([{ name: 'System.A()' }])?.name, 'System.A()');
        assert.equal(callerOf([]), undefined);
    });

    it('drops the argument list of a frame name', () => {
        assert.equal(shortFrameName('MyDb.Query(String sql, ValueTuple`2[] args)'), 'MyDb.Query');
        assert.equal(shortFrameName('Program.Main'), 'Program.Main');
    });
});
