// E2E: GDI leak candidates - objects holding native resources, and how many are not disposed (netcoredbg patch 0012).

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { HANDLE_STATS_REQUEST, ResourceType, handleStatsArguments } from '../../resourceLeakCore';
import { DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

describe('GDI leak candidates', { skip: e2eSkip }, () => {
    let s: DapSession;
    let frameId = 0;

    before(async () => {
        const program = path.join(buildApp('Leaks'), 'Leaks.exe');
        const source = appSource('Leaks', 'Program.cs');
        s = new DapSession();
        const first = s.nextStop();
        await s.launch(program, { [source]: [{ line: lineOf(source, 'leaks') }] });
        frameId = (await s.topFrame((await first).body.threadId)).id;
    });
    after(async () => {
        await s?.close();
    });

    const stats = async () => {
        const r = await s.request(HANDLE_STATS_REQUEST, handleStatsArguments());
        assert.equal(r.success, true, r.message);
        return (name: string) => (r.body.types as ResourceType[]).find((t) => t.name === name);
    };

    it('counts the fonts that were not disposed apart from the disposed ones', async () => {
        const find = await stats();
        // 5 kept, 3 disposed and dropped (still on the heap: no GC yet), 1 disposed and kept.
        assert.deepEqual(find('System.Drawing.Font'), { name: 'System.Drawing.Font', count: 9, live: 5, field: 'System.Drawing.Font._nativeFont' });
    });

    it('finds the handle of a derived type in its base type', async () => {
        const find = await stats();
        assert.equal(find('System.Drawing.SolidBrush')?.live, 2);
        assert.equal(find('System.Drawing.Bitmap')?.field, 'System.Drawing.Image._nativeImage');
        assert.equal(find('System.Drawing.Bitmap')?.live, 1);
    });

    it('drops the disposed garbage after a garbage collection, and keeps the undisposed fonts', async () => {
        assert.equal((await s.evaluate('System.GC.Collect()', frameId)).success, true);
        const find = await stats();
        // 6, or 7 when the debug build still holds the last font of the loop in a stack slot.
        const count = find('System.Drawing.Font')?.count ?? 0;
        assert.ok(count >= 6 && count <= 7, String(count));
        assert.equal(find('System.Drawing.Font')?.live, 5);
    });
});
