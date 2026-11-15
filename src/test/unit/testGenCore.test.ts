import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { detectFrameworks, findMethodSignature, generateTest, parseFrameName } from '../../testGenCore';

describe('parseFrameName', () => {
    it('splits namespace, class and method', () => {
        assert.deepEqual(parseFrameName('MyApp.Orders.Save()'), { namespace: 'MyApp', className: 'Orders', method: 'Save' });
        assert.deepEqual(parseFrameName('Orders.Save()'), { namespace: '', className: 'Orders', method: 'Save' });
    });

    it('sees the method behind an async or iterator state machine', () => {
        assert.deepEqual(parseFrameName('MyApp.Orders.<SaveAsync>d__3.MoveNext()'), { namespace: 'MyApp', className: 'Orders', method: 'SaveAsync' });
    });

    it('refuses lambdas, local functions, constructors and top-level statements', () => {
        for (const name of ['Program.<>c.<Main>b__0_0()', 'Program.<Main>$()', 'MyApp.Orders..ctor()', 'Save()']) {
            assert.equal(parseFrameName(name), undefined, name);
        }
    });
});

describe('findMethodSignature', () => {
    const source = [
        'public class Orders',
        '{',
        '    public static decimal Total(IReadOnlyList<Line> lines, Dictionary<string, int> discounts, decimal rate = 0.1m)',
        '    {',
        '        var sum = Sum(lines);',
        '        return sum;',
        '    }',
        '    public async Task<bool> SaveAsync([NotNull] Order order,',
        '        CancellationToken token = default) =>',
        '        await Save(order, token);',
        '    internal void Fill(ref int count, out string message, params object[] items) { message = ""; }',
        '}',
        'static class Ext { public static int Twice(this int x) { return x * 2; } }',
    ];

    it('reads generic parameter types, defaults and static', () => {
        assert.deepEqual(findMethodSignature(source, 6, 'Total'), {
            name: 'Total', returnType: 'decimal', isStatic: true,
            parameters: [{ name: 'lines', type: 'IReadOnlyList<Line>' }, { name: 'discounts', type: 'Dictionary<string, int>' }, { name: 'rate', type: 'decimal' }],
        });
    });

    it('reads a signature over several lines, with attributes and an expression body', () => {
        const signature = findMethodSignature(source, 10, 'SaveAsync');
        assert.equal(signature?.returnType, 'Task<bool>');
        assert.deepEqual(signature?.parameters.map((p) => p.name), ['order', 'token']);
    });

    it('reads parameter modifiers', () => {
        assert.deepEqual(findMethodSignature(source, 11, 'Fill')?.parameters.map((p) => p.modifier), ['ref', 'out', 'params']);
    });

    it('takes only the declaration after a brace on the same line', () => {
        const signature = findMethodSignature(source, 13, 'Twice');
        assert.equal(signature?.returnType, 'int');
        assert.equal(signature?.parameters[0].modifier, 'this');
    });

    it('does not take a call for a declaration', () => {
        assert.equal(findMethodSignature(source, 6, 'Sum'), undefined);
    });
});

describe('detectFrameworks', () => {
    it('finds the test frameworks the projects reference', () => {
        assert.deepEqual(detectFrameworks(['<PackageReference Include="xunit" Version="2.9" />']), ['xunit']);
        assert.deepEqual(detectFrameworks(['<PackageReference Include="NUnit" />', '<PackageReference Include="MSTest.TestFramework" />']).sort(), ['mstest', 'nunit']);
        assert.deepEqual(detectFrameworks(['<PackageReference Include="Newtonsoft.Json" />']), []);
    });
});

describe('generateTest', () => {
    const frame = { namespace: 'Shop', className: 'Orders', method: 'Total' };

    it('writes Arrange / Act / Assert for an instance method in xUnit', () => {
        const code = generateTest({
            framework: 'xunit', frame, location: 'Orders.cs:17', instance: 'new Shop.Orders()',
            signature: { name: 'Total', returnType: 'decimal', isStatic: false, parameters: [{ name: 'rate', type: 'decimal' }] },
            values: new Map([['rate', '0.1M']]),
        });
        assert.match(code, /^using Xunit;\nusing Shop;\n\nnamespace Shop\.Tests;/);
        assert.match(code, /\[Fact\]\n {4}public void Total_ReplaysDebugSession\(\)/);
        assert.match(code, /var sut = new Shop\.Orders\(\);\n {8}var rate = 0\.1M;/);
        assert.match(code, /var result = sut\.Total\(rate\);/);
        assert.match(code, /Assert\.Equal\(expected, result\);/);
    });

    it('awaits async methods and passes ref / out arguments', () => {
        const code = generateTest({
            framework: 'nunit', frame: { ...frame, method: 'Fill' }, location: 'x',
            signature: { name: 'Fill', returnType: 'Task', isStatic: true, parameters: [{ name: 'count', type: 'int', modifier: 'ref' }, { name: 'message', type: 'string', modifier: 'out' }] },
            values: new Map([['count', '3']]),
        });
        assert.match(code, /\[TestFixture\]/);
        assert.match(code, /public async Task Fill_ReplaysDebugSession\(\)/);
        assert.match(code, /string message;/);
        assert.match(code, /await Orders\.Fill\(ref count, out message\);/);
        assert.match(code, /TODO: assert on what the method changed/);
    });

    it('marks values it could not read', () => {
        const code = generateTest({
            framework: 'mstest', frame, location: 'x',
            signature: { name: 'Total', returnType: 'int', isStatic: true, parameters: [{ name: 'x', type: 'Order' }] },
            values: new Map(),
        });
        assert.match(code, /var x = default\(Order\) \/\* TODO: value not available \*\/;/);
        assert.match(code, /Assert\.AreEqual\(expected, result\);/);
    });
});
