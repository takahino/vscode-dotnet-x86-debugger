// SQL log without a debugger: the SQL with the values filled in, its summary, and who ran it.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
    SqlCommandInfo,
    SqlParameter,
    callerOf,
    dialectOf,
    normalizeSql,
    shortFrameName,
    substituteParameters,
    summarizeSql,
} from '../../sqlLogCore';
const param = (name: string, kind: SqlParameter['kind'], value: string, direction = 'Input'): SqlParameter => ({ name, kind, value, direction });
const command = (commandText: string, parameters: SqlParameter[], extra: Partial<SqlCommandInfo> = {}): SqlCommandInfo => ({ commandText, commandType: 'Text', parameters, ...extra });

describe('dialectOf', () => {
    it('tells the SQL flavor from the command type', () => {
        assert.equal(dialectOf('Oracle.ManagedDataAccess.Client.OracleCommand'), 'oracle');
        assert.equal(dialectOf('Oracle.DataAccess.Client.OracleCommand'), 'oracle');
        assert.equal(dialectOf('System.Data.SqlClient.SqlCommand'), 'sqlserver');
        assert.equal(dialectOf('Microsoft.Data.SqlClient.SqlCommand'), 'sqlserver');
        assert.equal(dialectOf('System.Data.OleDb.OleDbCommand'), 'generic');
        assert.equal(dialectOf('Npgsql.NpgsqlCommand'), 'generic');
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
