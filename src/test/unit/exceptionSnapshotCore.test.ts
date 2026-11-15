import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { SNAPSHOT_LIMITS, snapshotFrames, snapshotLocals } from '../../exceptionSnapshotCore';

describe('snapshotFrames', () => {
    const frames = [
        { id: 1, name: 'System.Number.ThrowFormatException()' },
        { id: 2, name: 'System.Int32.Parse()' },
        { id: 3, name: 'Orders.Load()', source: { path: 'C:\\app\\Orders.cs' }, line: 40 },
        { id: 4, name: 'MainForm.OnClick()', source: { path: 'C:\\app\\MainForm.cs' }, line: 12 },
        { id: 5, name: 'Program.Main()', source: { path: 'C:\\app\\Program.cs' }, line: 5 },
        { id: 6, name: 'Program.Run()', source: { path: 'C:\\app\\Program.cs' }, line: 9 },
    ];

    it('keeps the whole stack and marks the frames of your code whose locals are read', () => {
        const result = snapshotFrames(frames);
        assert.equal(result.length, 6);
        assert.deepEqual(result.filter((f) => f.readLocals).map((f) => f.name), ['Orders.Load()', 'MainForm.OnClick()', 'Program.Main()']);
        assert.deepEqual(result[0], { frameId: 1, name: 'System.Number.ThrowFormatException()', source: undefined, line: undefined, readLocals: false });
    });

    it('stops at the frame limit', () => {
        const many = Array.from({ length: 80 }, (_v, i) => ({ id: i, name: `F${i}()` }));
        assert.equal(snapshotFrames(many).length, SNAPSHOT_LIMITS.frames);
    });
});

describe('snapshotLocals', () => {
    it('keeps name, value and type, shortens long values and leaves out static members', () => {
        const locals = snapshotLocals([
            { name: 'text', value: '"' + 'x'.repeat(500) + '"', type: 'string' },
            { name: 'count', value: '3', type: 'int' },
            { name: 'Static members', value: '' },
        ]);
        assert.equal(locals.length, 2);
        assert.equal(locals[0].value.length, SNAPSHOT_LIMITS.valueLength + 1);
        assert.ok(locals[0].value.endsWith('…'));
        assert.deepEqual(locals[1], { name: 'count', value: '3', type: 'int' });
    });

    it('keeps at most the variable limit', () => {
        const many = Array.from({ length: 100 }, (_v, i) => ({ name: `v${i}`, value: `${i}` }));
        assert.equal(snapshotLocals(many).length, SNAPSHOT_LIMITS.locals);
    });
});
