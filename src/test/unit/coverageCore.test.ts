import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { coverageMarks, coverageSummary, samePath } from '../../coverageCore';

describe('coverageMarks', () => {
    it('sorts lines into run, partly run and not run (0-based)', () => {
        const marks = coverageMarks([
            { line: 12, hit: true },
            { line: 27, hit: true, branchesCovered: 1, branchesValid: 2 },
            { line: 28, hit: true, branchesCovered: 2, branchesValid: 2 },
            { line: 32, hit: false, branchesCovered: 0, branchesValid: 2 },
        ]);
        assert.deepEqual(marks.hit, [11, 27]);
        assert.deepEqual(marks.partial, [{ line: 26, covered: 1, valid: 2 }]);
        assert.deepEqual(marks.missed, [31]);
    });

    it('ignores lines that are not line numbers', () => {
        assert.deepEqual(coverageMarks([{ line: 0, hit: true }, { line: 1.5, hit: false }]), { hit: [], partial: [], missed: [] });
    });
});

describe('coverageSummary', () => {
    const labels = { lines: 'lines', branches: 'branches' };
    it('shows the line rate, and the branch rate when there are branches', () => {
        assert.equal(coverageSummary({ lineRate: 0.556, branchRate: 0.4, branchesValid: 5 }, labels), 'lines 56% · branches 40%');
        assert.equal(coverageSummary({ lineRate: 1, branchesValid: 0 }, labels), 'lines 100%');
    });
});

describe('samePath', () => {
    it('ignores case and slashes like Windows', () => {
        assert.equal(samePath('C:/App/Program.cs', 'c:\\app\\program.cs'), true);
        assert.equal(samePath('C:\\App\\A.cs', 'C:\\App\\B.cs'), false);
    });
});
