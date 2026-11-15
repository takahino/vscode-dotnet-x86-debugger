// Live Watch in the DAP relay against the scripted stand-in (fakeDebugger): samples are taken at a hook method while
// the program runs freely, never while the user has it stopped or is stepping, and VS Code never sees the stops.

import * as assert from 'assert/strict';
import { afterEach, describe, it } from 'node:test';
import { LIVE_WATCH_EVENT, LIVE_WATCH_LOCATION, LIVE_WATCH_REQUEST, TRACK_EVENT } from '../../dapProxy';
import { Client } from './fakeClient';
import { FakeScenario, FakeStop } from './fakeDebugger';

const HOOK = 'System.Windows.Forms.NativeWindow.Callback';
const hookStop: FakeStop = {
    reason: 'breakpoint',
    frames: [{ id: 1, name: `${HOOK}()` }, { id: 2, name: 'App.Main()', source: { path: 'C:\\app\\App.cs' }, line: 20 }],
    values: { 'App.Counter': { result: '5', type: 'int' }, 'App.Status': { result: '"odd"', type: 'string' } },
};
const pauseStop: FakeStop = { reason: 'pause', frames: [{ id: 50, name: 'App.Main()', source: { path: 'C:\\app\\App.cs' }, line: 20 }] };
const watch = { expressions: ['App.Counter', 'App.Status', 'App.Nope'], intervalMs: 250, hookMethods: [HOOK] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function running(extra: Partial<FakeScenario> = {}): FakeScenario {
    return { stops: [], runForever: true, hits: { [HOOK]: hookStop }, pauseStop, ...extra };
}

describe('Live Watch', () => {
    let client: Client | undefined;
    afterEach(async () => {
        await client?.close();
        client = undefined;
    });

    const samples = () => client!.events(LIVE_WATCH_EVENT).filter((e) => !e.body.idle);
    const hookSets = async () => (await client!.sentToDebugger())
        .filter((r) => r.command === 'setFunctionBreakpoints')
        .map((r) => (r.arguments.breakpoints as { name: string; anyCode?: boolean }[]).some((b) => b.name === HOOK && b.anyCode));

    it('reads the expressions at the hook while the program runs, without VS Code seeing a stop', async () => {
        client = new Client(running());
        await client.start();
        assert.deepEqual((await client.request(LIVE_WATCH_REQUEST, watch)).body, { watching: true });
        await client.waitFor((m) => m.event === LIVE_WATCH_EVENT && !m.body.idle, 'a sample');

        const values = samples()[0].body.values;
        assert.deepEqual(values.map((v: { expression: string; value: string; error?: string }) => [v.expression, v.value, Boolean(v.error)]), [
            ['App.Counter', '5', false],
            ['App.Status', '"odd"', false],
            ['App.Nope', '', true],
        ]);
        assert.equal(client.events('stopped').length, 0);
        assert.equal(client.events('continued').length, 0);
        assert.equal(client.events('breakpoint').length, 0);
        // The hook is set for a sample and taken off right at it (before evaluating: a getter may run the hook again).
        const sets = await hookSets();
        assert.deepEqual(sets.slice(0, 2), [true, false]);
        // Also to the value trend, under its own location, without the values that failed.
        const track = client.events(TRACK_EVENT)[0].body;
        assert.equal(track.location, LIVE_WATCH_LOCATION);
        assert.deepEqual(track.values.map((v: { expression: string }) => v.expression), ['App.Counter', 'App.Status']);
    });

    it('keeps sampling at the interval', async () => {
        client = new Client(running());
        await client.start();
        await client.request(LIVE_WATCH_REQUEST, watch);
        await sleep(1200);
        assert.ok(samples().length >= 3, `${samples().length} samples`);
    });

    it('does not sample while the user has the program stopped, and again after continue', async () => {
        client = new Client(running());
        await client.start();
        await client.request(LIVE_WATCH_REQUEST, watch);
        await client.waitFor((m) => m.event === LIVE_WATCH_EVENT, 'a sample');
        const stopped = client.waitFor((m) => m.event === 'stopped', 'the user\'s pause');
        await client.request('pause', { threadId: 1 });
        await stopped;
        await sleep(100); // a sample that was already under way finishes
        const before = samples().length;
        await sleep(800);
        assert.equal(samples().length, before, 'no sample while stopped');

        await client.request('continue', { threadId: 1 });
        await sleep(800);
        assert.ok(samples().length > before, 'sampling again');
    });

    it('does not sample while a step runs', async () => {
        client = new Client(running());
        await client.start();
        await client.request(LIVE_WATCH_REQUEST, watch);
        await client.waitFor((m) => m.event === LIVE_WATCH_EVENT, 'a sample');
        await client.request('next', { threadId: 1 });
        await sleep(100);
        const before = samples().length;
        await sleep(800);
        assert.equal(samples().length, before);
    });

    it('stops sampling and takes the hook off when turned off', async () => {
        client = new Client(running());
        await client.start();
        await client.request(LIVE_WATCH_REQUEST, watch);
        await client.waitFor((m) => m.event === LIVE_WATCH_EVENT, 'a sample');
        assert.deepEqual((await client.request(LIVE_WATCH_REQUEST, { expressions: [] })).body, { watching: false });
        await sleep(100);
        const before = samples().length;
        await sleep(800);
        assert.equal(samples().length, before);
        assert.equal((await hookSets()).at(-1), false);
    });

    it('says so and takes the hook off when the UI thread stays idle', async () => {
        client = new Client(running({ hits: {} })); // the hook method is never called
        await client.start();
        await client.request(LIVE_WATCH_REQUEST, watch);
        const idle = await client.waitFor((m) => m.event === LIVE_WATCH_EVENT && m.body.idle === true, 'an idle report');
        assert.equal(idle.body.idle, true);
        assert.equal(samples().length, 0);
        const sets = await hookSets();
        assert.deepEqual(sets.slice(0, 2), [true, false]);
    });

    it('ignores hook methods that are not "Namespace.Type.Method", and is off without any', async () => {
        client = new Client(running());
        await client.start();
        const r = await client.request(LIVE_WATCH_REQUEST, { expressions: ['App.Counter'], hookMethods: ['Callback', ''] });
        assert.deepEqual(r.body, { watching: false });
    });
});
