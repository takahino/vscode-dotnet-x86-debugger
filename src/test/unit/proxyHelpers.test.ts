// The DAP relay's pure helpers: hit counts, breakpoint markers, frame names, Source path rewriting, object IDs.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { frameIsMethod, mapSourcePaths, parseHitCondition, parseMarker } from '../../dapProxy';
import { requestWithDebuggerObjectIds, responseWithClientObjectIds, toClientObjectIds, toDebuggerObjectIds } from '../../objectIds';

describe('parseHitCondition', () => {
    const hits = (text: string) => [1, 2, 3, 4, 5, 6].filter((n) => parseHitCondition(text)!(n));

    it('understands Visual Studio hit counts', () => {
        assert.deepEqual(hits('3'), [3]);
        assert.deepEqual(hits('==3'), [3]);
        assert.deepEqual(hits('>=5'), [5, 6]);
        assert.deepEqual(hits('>5'), [6]);
        assert.deepEqual(hits('%2'), [2, 4, 6]);
    });

    it('rejects anything else', () => {
        for (const text of ['abc', '<3', '%0', '']) {
            assert.equal(parseHitCondition(text), undefined, text);
        }
    });
});

describe('parseMarker', () => {
    it('reads the breakpoint markers', () => {
        assert.deepEqual(parseMarker('#once'), { kind: 'once' });
        assert.deepEqual(parseMarker('  #after Orders.cs:42 '), { kind: 'after', target: 'Orders.cs:42' });
        assert.deepEqual(parseMarker('#changed order.Status'), { kind: 'changed', expression: 'order.Status' });
        assert.deepEqual(parseMarker('#caller A, B'), { kind: 'caller', methods: ['A', 'B'], negate: false });
        assert.deepEqual(parseMarker('#caller !Import.Run'), { kind: 'caller', methods: ['Import.Run'], negate: true });
    });

    it('leaves ordinary conditions to the debugger', () => {
        assert.equal(parseMarker('x > 1'), undefined);
        assert.equal(parseMarker('#caller '), undefined);
        assert.equal(parseMarker(undefined), undefined);
    });
});

describe('frameIsMethod', () => {
    it('matches whole dot-separated parts from the end, ignoring case', () => {
        assert.equal(frameIsMethod('MyLib.Orders.Save()', 'Save'), true);
        assert.equal(frameIsMethod('MyLib.Orders.Save()', 'orders.save'), true);
        assert.equal(frameIsMethod('MyLib.Orders.Save()', 'MyLib.Orders.Save'), true);
        assert.equal(frameIsMethod('MyLib.Orders.SaveAll()', 'Save'), false);
        assert.equal(frameIsMethod('MyLib.Orders.Save()', ''), false);
    });
});

describe('mapSourcePaths', () => {
    const upper = (p: string) => p.toUpperCase();

    it('rewrites every Source in a message, and copies only what changes', () => {
        const body: { stackFrames: { id: number; source?: { name: string; path: string } }[]; count: number } = {
            stackFrames: [{ id: 1, source: { name: 'a.cs', path: 'c:\\a.cs' } }, { id: 2 }],
            count: 2,
        };
        const mapped = mapSourcePaths(body, upper);
        assert.equal(mapped.stackFrames[0].source.path, 'C:\\A.CS');
        assert.equal(body.stackFrames[0].source?.path, 'c:\\a.cs', 'the original is not modified');
        assert.equal(mapped.stackFrames[1], body.stackFrames[1], 'unchanged parts are shared');
    });

    it('rewrites "sources" arrays and leaves messages without paths as they are', () => {
        assert.deepEqual(mapSourcePaths({ sources: [{ path: 'x' }, { name: 'y' }] }, upper), { sources: [{ path: 'X' }, { name: 'y' }] });
        const plain = { variables: [{ name: 'a', value: '1' }] };
        assert.equal(mapSourcePaths(plain, upper), plain);
    });
});

describe('object IDs', () => {
    it('turns $N into the identifier netcoredbg resolves, outside string literals', () => {
        assert.equal(toDebuggerObjectIds('$1.Count + $12'), '__DOTNETX86_OBJID_1.Count + __DOTNETX86_OBJID_12');
        assert.equal(toDebuggerObjectIds('"$1" + \'$\' + $2'), '"$1" + \'$\' + __DOTNETX86_OBJID_2');
        assert.equal(toDebuggerObjectIds('x$1 + $exception'), 'x$1 + $exception');
    });

    it('shows the identifier as $N again in what comes back', () => {
        assert.equal(toClientObjectIds('__DOTNETX86_OBJID_1._items'), '$1._items');
        const response = responseWithClientObjectIds({ type: 'response', message: 'no __DOTNETX86_OBJID_9', body: { variables: [{ evaluateName: '__DOTNETX86_OBJID_1.a' }] } });
        assert.equal(response.message, 'no $9');
        assert.equal(response.body.variables[0].evaluateName, '$1.a');
    });

    it('rewrites the expressions of evaluate, setExpression and breakpoint conditions only', () => {
        assert.equal(requestWithDebuggerObjectIds('evaluate', { expression: '$1' }).expression, '__DOTNETX86_OBJID_1');
        assert.equal(requestWithDebuggerObjectIds('setBreakpoints', { breakpoints: [{ line: 1, condition: 'x == $2' }] }).breakpoints[0].condition, 'x == __DOTNETX86_OBJID_2');
        const other = { expression: '$1' };
        assert.equal(requestWithDebuggerObjectIds('completions', other), other);
    });
});
