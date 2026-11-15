// E2E: Live Watch reads static fields and properties of the running Live app through the real netcoredbg, at the
// WinForms hook (NativeWindow.Callback, an "anyCode" function breakpoint of patch 0013), without a visible stop.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { LIVE_WATCH_EVENT, LIVE_WATCH_REQUEST } from '../../dapProxy';
import { DapSession, buildApp, e2eSkip } from './harness';

describe('Live Watch', { skip: e2eSkip || (process.env.DOTNETX86_SKIP_UI_TESTS ? 'DOTNETX86_SKIP_UI_TESTS is set' : false) }, () => {
    let s: DapSession;

    before(async () => {
        const program = path.join(buildApp('Live'), 'Live.exe');
        s = new DapSession();
        await s.launch(program);
    });
    after(async () => {
        await s?.close();
    });

    it('reads fields and properties while the program runs, and they change', { timeout: 60_000 }, async () => {
        await s.request(LIVE_WATCH_REQUEST, {
            expressions: ['App.Counter', 'App.Status', 'App.MainForm.Text'],
            intervalMs: 300,
            hookMethods: ['System.Windows.Forms.NativeWindow.Callback'],
        });
        const counters: number[] = [];
        while (counters.length < 3) {
            const m = await s.waitFor((x) => x.event === LIVE_WATCH_EVENT && !x.body.idle && Number(x.body.values[0].value) > (counters.at(-1) ?? 0), 20_000, 'a newer sample');
            const [counter, status, text] = m.body.values;
            counters.push(Number(counter.value));
            assert.match(status.value, /^"(even|odd)"$/);
            assert.match(text.value, /^"Live \d+"$/, 'a property getter runs at the hook');
        }
        assert.equal(s.events.filter((e) => e.event === 'stopped').length, 0, 'VS Code never sees the samples\' stops');
        await s.request(LIVE_WATCH_REQUEST, { expressions: [] });
    });
});
