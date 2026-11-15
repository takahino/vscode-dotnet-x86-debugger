import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { diffHeap, formatBytes, heapTotals } from '../../heapSnapshotCore';

describe('diffHeap', () => {
    it('gives each type its change since the baseline', () => {
        const rows = diffHeap(
            [{ name: 'A', count: 5, size: 500 }, { name: 'B', count: 1, size: 10 }],
            [{ name: 'A', count: 2, size: 200 }, { name: 'B', count: 1, size: 10 }],
        );
        assert.deepEqual(rows, [
            { name: 'A', count: 5, size: 500, countDelta: 3, sizeDelta: 300, added: false },
            { name: 'B', count: 1, size: 10, countDelta: 0, sizeDelta: 0, added: false },
        ]);
    });

    it('marks types that are new since the baseline', () => {
        const [row] = diffHeap([{ name: 'New', count: 2, size: 40 }], []);
        assert.deepEqual(row, { name: 'New', count: 2, size: 40, countDelta: 2, sizeDelta: 40, added: true });
    });

    it('keeps types that are gone, with nothing left', () => {
        const [row] = diffHeap([], [{ name: 'Gone', count: 3, size: 30 }]);
        assert.deepEqual(row, { name: 'Gone', count: 0, size: 0, countDelta: -3, sizeDelta: -30, added: false });
    });

    it('has no change without a baseline', () => {
        const [row] = diffHeap([{ name: 'A', count: 1, size: 8 }]);
        assert.deepEqual(row, { name: 'A', count: 1, size: 8, countDelta: 0, sizeDelta: 0, added: false });
    });
});

describe('heapTotals', () => {
    it('sums the objects and bytes', () => {
        assert.deepEqual(heapTotals([{ name: 'A', count: 2, size: 20 }, { name: 'B', count: 3, size: 5 }]), { count: 5, size: 25 });
    });
});

describe('formatBytes', () => {
    it('picks a readable unit', () => {
        assert.equal(formatBytes(512), '512 B');
        assert.equal(formatBytes(2048), '2.0 KB');
        assert.equal(formatBytes(5 * 1024 * 1024 + 1), '5.0 MB');
        assert.equal(formatBytes(-1536), '-1.5 KB');
    });
});
