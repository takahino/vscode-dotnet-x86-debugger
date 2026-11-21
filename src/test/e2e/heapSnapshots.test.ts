// E2E: heap snapshots and their difference, as the Heap Snapshots panel takes them.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { HEAP_STATS_REQUEST, HeapType, diffHeap } from '../../heapSnapshotCore';
import { DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

describe('heap snapshots', { skip: e2eSkip }, () => {
    let s: DapSession;
    let mainThread = 0;
    const source = appSource('Basic', 'Program.cs');

    before(async () => {
        const program = path.join(buildApp('Basic'), 'Basic.exe');
        s = new DapSession();
        const first = s.nextStop();
        // @nested is before the order lines are created, @total-return after.
        await s.launch(program, { [source]: ['nested', 'total-return'].map((m) => ({ line: lineOf(source, m) })) });
        mainThread = (await first).body.threadId;
    });
    after(async () => {
        await s?.close();
    });

    /** Collects garbage first, as the panel does by default. */
    const snapshot = async (threadId: number): Promise<HeapType[]> => {
        const frame = await s.topFrame(threadId);
        assert.ok((await s.evaluate('System.GC.Collect()', frame.id)).success);
        const r = await s.request(HEAP_STATS_REQUEST, {});
        assert.ok(r.success, r.message);
        return r.body.types;
    };

    it('counts the objects per type and shows what was created in between', { timeout: 120_000 }, async () => {
        const before = await snapshot(mainThread);
        assert.equal(before.find((t) => t.name === 'Basic.Line'), undefined);
        // Largest first, with arrays and primitives named too.
        assert.ok(before.every((t, i) => i === 0 || before[i - 1].size >= t.size));
        assert.ok(before.some((t) => t.name === 'string'));
        assert.ok(before.some((t) => t.name.endsWith('[]')));

        const stop = await s.continueTo(mainThread);
        assert.equal((await s.topFrame(stop.body.threadId)).line, lineOf(source, 'total-return'));
        const rows = diffHeap(await snapshot(stop.body.threadId), before);
        const line = rows.find((r) => r.name === 'Basic.Line');
        assert.deepEqual(line && { count: line.count, countDelta: line.countDelta, added: line.added }, { count: 2, countDelta: 2, added: true });
        assert.ok(rows.some((r) => r.name === 'System.Collections.Generic.List<Basic.Line>' && r.countDelta === 1));
    });
});
