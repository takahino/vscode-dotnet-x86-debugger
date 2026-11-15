// Value handling that does not need a debugger: dumps, C# initializers, tables, string formats, inline values,
// assignment lines and the session report.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { toCSharp, toCSharpStatement } from '../../csharpInitializer';
import { collectTree, DapVariable, DumpNode, parseLeaf, toJson } from '../../dumpCore';
import { findInlineTargets, stripStringsAndComments } from '../../inlineValuesCore';
import { buildReport } from '../../sessionReportCore';
import { detectFormat, formatString, formatXml } from '../../stringFormat';
import { buildTable, cellText, toCsv } from '../../tableCore';
import { findWriteLines } from '../../writeSites';

const leaf = (text: string, type?: string): DumpNode => ({ kind: 'leaf', type, text });
const line: DumpNode = {
    kind: 'object', type: 'Shop.Line', text: '{Shop.Line}',
    members: [['Sku', leaf('"A-1"', 'string')], ['Quantity', leaf('2', 'int')], ['Price', leaf('150', 'decimal')], ['_cache', leaf('1', 'int')]],
};
const lines: DumpNode = { kind: 'list', type: 'System.Collections.Generic.List<Shop.Line>', items: [line] };

describe('collectTree', () => {
    const children: Record<number, DapVariable[]> = {
        1: [
            { name: 'Sku', value: '"A-1"', type: 'string', variablesReference: 0 },
            { name: 'Static members', value: '', variablesReference: 9 },
            { name: 'Inner', value: '{Inner}', type: 'Inner', variablesReference: 2 },
        ],
        2: [{ name: 'X', value: '1', type: 'int', variablesReference: 0 }],
    };
    const request = async (_command: string, args: Record<string, unknown>) => ({ variables: children[args.variablesReference as number] ?? [] });
    const root: DapVariable = { name: 'line', value: '{Line}', type: 'Line', variablesReference: 1 };

    it('walks the members, leaving out the static members', async () => {
        const result = await collectTree(request, root, { maxDepth: 3, maxNodes: 100 });
        assert.equal(result.truncated, false);
        assert.deepEqual(toJson(result.node), { $type: 'Line', Sku: 'A-1', Inner: { $type: 'Inner', X: 1 } });
    });

    it('stops at the depth limit and says so', async () => {
        const result = await collectTree(request, root, { maxDepth: 1, maxNodes: 100 });
        assert.equal(result.truncated, true);
        assert.deepEqual(result.node.kind === 'object' && result.node.members[1][1].kind, 'truncated');
    });
});

describe('parseLeaf', () => {
    it('turns debugger values into JSON values', () => {
        assert.deepEqual(['"a\\nb"', '42', '-1.5', 'true', 'null', '{Shop.Line}'].map(parseLeaf), ['a\nb', 42, -1.5, true, null, '{Shop.Line}']);
    });
});

describe('toCSharp', () => {
    it('writes collection and object initializers with PascalCase members only', () => {
        assert.equal(toCSharpStatement('lines', lines), [
            'var lines = new System.Collections.Generic.List<Shop.Line>',
            '{',
            '    new Shop.Line',
            '    {',
            '        Sku = "A-1",',
            '        Quantity = 2,',
            '        Price = 150M,',
            '    },',
            '};',
            '',
        ].join('\n'));
    });

    it('writes literals with the right suffix', () => {
        assert.deepEqual(
            [leaf('1.5', 'double'), leaf('5', 'long'), leaf("97 'a'", 'char'), leaf('true', 'bool'), leaf('null', 'string')].map((n) => toCSharp(n, '')),
            ['1.5D', '5L', "'a'", 'true', 'null'],
        );
    });

    it('leaves a placeholder for values it cannot write', () => {
        assert.equal(toCSharp({ kind: 'truncated', type: 'Order', text: '{Order}' }, ''), 'default /* Order: not expanded (limit reached) */');
    });
});

describe('tables', () => {
    it('makes a row per item and a column per member', () => {
        assert.deepEqual(buildTable(lines), { columns: ['Index', 'Sku', 'Quantity', 'Price', '_cache'], rows: [['0', 'A-1', '2', '150', '1']] });
        assert.equal(cellText(leaf('"A-1"', 'string')), 'A-1');
    });

    it('quotes CSV cells that need it', () => {
        assert.equal(toCsv({ columns: ['a', 'b'], rows: [['1', 'x,y'], ['2', 'q"r']] }), 'a,b\r\n1,"x,y"\r\n2,"q""r"\r\n');
    });
});

describe('string formats', () => {
    it('detects JSON, XML and HTML', () => {
        assert.deepEqual(['{"a":1}', '[1,2]', '<r><a/></r>', '<html><body></body></html>', 'plain', '  {bad'].map(detectFormat), ['json', 'json', 'xml', 'html', 'text', 'text']);
    });

    it('pretty-prints JSON and XML', () => {
        assert.equal(formatString('{"a":1,"b":[1,2]}', 'json'), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
        assert.equal(formatXml('<r><a x="1"/><b>t</b></r>'), '<r>\n  <a x="1"/>\n  <b>t</b>\n</r>');
    });
});

describe('inline values', () => {
    it('finds the names on the lines of the current method up to the stopped line', () => {
        const targets = findInlineTargets(['int total = 0;', 'foreach (var item in items)', '{', '    total += item.Price; // note'], 3);
        assert.deepEqual(targets.map((t) => `${t.line}:${t.text}`), ['0:total', '1:item', '1:items', '3:total', '3:item']);
    });

    it('ignores what is inside strings and comments', () => {
        assert.equal(stripStringsAndComments('var s = "a\\"b" + c; // d'), 'var s = "    " + c;     ');
    });
});

describe('findWriteLines', () => {
    it('finds the lines that assign the name', () => {
        const source = ['class C {', '  int count;', '  void M() {', '    count = 1;', '    count++;', '    var x = count;', '    this.count += 2;', '    if (count == 3) {}', '  }', '}'].join('\n');
        assert.deepEqual(findWriteLines(source, 'count'), [4, 5, 7]);
    });
});

describe('buildReport', () => {
    const report = buildReport(
        {
            session: { name: 'Launch App', program: 'C:\\app\\App.exe', start: Date.UTC(2026, 10, 15, 1, 2, 3), end: Date.UTC(2026, 10, 15, 1, 3, 0), exitCode: 0 },
            stops: [{ n: 1, time: Date.UTC(2026, 10, 15, 1, 2, 10), reason: 'breakpoint', functionName: 'Main()', sourcePath: 'C:\\app\\Program.cs', line: 5, changes: [{ name: 'x', value: '1', change: 'new' }] }],
            exceptions: [
                { time: Date.UTC(2026, 10, 15, 1, 2, 20), typeName: 'System.FormatException', message: 'bad', stopped: false, sourcePath: 'C:\\app\\Program.cs', line: 9 },
                { time: Date.UTC(2026, 10, 15, 1, 2, 21), typeName: 'System.FormatException', message: 'bad2', stopped: true },
            ],
            tracked: [],
            modules: [{ name: 'App.dll', path: 'C:\\app\\App.dll', symbolsLoaded: true }, { name: 'System.dll', symbolsLoaded: false }],
            createdAt: Date.UTC(2026, 10, 15, 1, 4, 0),
        },
        (message, ...args) => message.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])),
    );

    it('summarizes the session, stops, exceptions and modules in Markdown', () => {
        assert.match(report, /^# Debug session report: Launch App/);
        assert.match(report, /\| Duration \| 57\.0 s \|/);
        assert.match(report, /\| 1 \| [\d:.]+ \| `Main\(\)` \| C:\\app\\Program\.cs:5 \| breakpoint \| `x = 1` \(new\) \|/);
        assert.match(report, /\| `System\.FormatException` \| 2 \|/);
        assert.match(report, /2 modules loaded, 1 with symbols\./);
    });
});
