import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { findCallTargets } from '../../stepTargets';

const labels = (lines: string[], index = 0) => findCallTargets(lines, index).map((t) => t.label);

describe('findCallTargets', () => {
    it('lists calls in the order they run: arguments first', () => {
        assert.deepEqual(labels(['var total = Outer(Inner1(1), Inner2(2));']), ['Inner1', 'Inner2', 'Outer']);
    });

    it('gives the column of the method name', () => {
        const [inner] = findCallTargets(['    Run(Load());'], 0);
        assert.deepEqual({ label: inner.label, column: inner.column }, { label: 'Load', column: 9 });
    });

    it('keeps the receiver in the label and the method name alone for the breakpoint', () => {
        const [target] = findCallTargets(['order?.Save(x);'], 0);
        assert.equal(target.label, 'order?.Save');
        assert.equal(target.method, 'Save');
    });

    it('skips keywords, constructors and anything inside strings or comments', () => {
        assert.deepEqual(labels(['if (Check("a(b)")) Save(new Line(Make())); // Ignored(1)']), ['Check', 'Make', 'Save']);
    });

    it('continues the statement on the next lines until the semicolon', () => {
        const targets = findCallTargets(['Log(Format(', '    Calc.Add(1, 2)));', 'Next();'], 0);
        assert.deepEqual(targets.map((t) => `${t.label}@${t.lineOffset}`), ['Calc.Add@1', 'Format@0', 'Log@0']);
    });

    it('lists a method once even when the line calls it twice', () => {
        assert.deepEqual(labels(['Add(Add(1, 2), 3);']), ['Add']);
    });

    it('handles generic calls', () => {
        assert.deepEqual(labels(['var x = Get<int>(Key());']), ['Key', 'Get']);
    });
});
