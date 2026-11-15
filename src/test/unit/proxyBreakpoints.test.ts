// The breakpoint features the DAP relay adds to netcoredbg (logpoints, hit counts, the #once / #caller / #changed
// markers, value tracking, section timing) and the exception log, against the scripted stand-in (fakeDebugger).
// The same features run against the real netcoredbg in the E2E tests; here each rule is checked on its own.

import * as assert from 'assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EXCEPTION_EVENT, REMOVE_BREAKPOINT_EVENT, TRACK_EVENT } from '../../dapProxy';
import { Client, stopped } from './fakeClient';
import { FakeStop } from './fakeDebugger';

const FILE = 'C:\\app\\Program.cs';

/** A breakpoint stop at FILE:line in `name`, with these expression values. */
function at(line: number, values: Record<string, string> = {}, name = 'Program.Main()', callers: string[] = []): FakeStop {
    return {
        reason: 'breakpoint',
        frames: [{ id: line * 10, name, source: { path: FILE }, line }, ...callers.map((c, i) => ({ id: line * 10 + i + 1, name: c }))],
        values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { result: v, type: 'int' }])),
    };
}

/** Starts a session with these breakpoints in FILE; resolves once it ended, with what VS Code saw. */
async function run(client: Client, breakpoints: Record<string, unknown>[], continueShownStops = true): Promise<void> {
    await client.start(() => client.request('setBreakpoints', { source: { path: FILE }, breakpoints }));
    for (;;) {
        const m = await client.waitFor((x) => stopped(x) && !(x as { handled?: boolean }).handled, 'a stop or the end');
        (m as { handled?: boolean }).handled = true;
        if (m.event === 'terminated' || !continueShownStops) {
            return;
        }
        await client.request('continue', { threadId: 1 });
    }
}

const shownLines = async (client: Client) => client.events('stopped').length;
const output = (client: Client) => client.events('output').map((m) => String(m.body.output).trimEnd());

describe('relay breakpoints', () => {
    let client: Client | undefined;
    afterEach(async () => {
        await client?.close();
        client = undefined;
    });

    it('prints a logpoint\'s message with {expressions}, $FUNCTION and $TID, without stopping', async () => {
        client = new Client({ stops: [at(10, { i: '3' })] });
        await run(client, [{ line: 10, logMessage: 'i={i} missing={nope} in $FUNCTION on $TID' }]);
        assert.equal(await shownLines(client), 0);
        assert.deepEqual(output(client), ['i=3 missing=<error: error: The name \'nope\' does not exist in the current context> in Program.Main() on 1']);
    });

    it('stops at a hit-count breakpoint only on the hits its condition names', async () => {
        client = new Client({ stops: [at(10), at(10), at(10), at(10), at(10)] });
        await run(client, [{ line: 10, hitCondition: '%2' }]);
        assert.equal(await shownLines(client), 2); // hits 2 and 4
    });

    it('says when a hit condition cannot be understood, and then stops on every hit', async () => {
        client = new Client({ stops: [at(10), at(10)] });
        await run(client, [{ line: 10, hitCondition: 'twice' }]);
        assert.equal(await shownLines(client), 2);
        assert.match(output(client)[0], /Ignored hit count condition "twice"/);
    });

    it('stops once at a #once breakpoint and asks VS Code to remove it', async () => {
        client = new Client({ stops: [at(10), at(10)] });
        await run(client, [{ line: 10, condition: '#once' }]);
        assert.equal(await shownLines(client), 1, 'a second hit before VS Code removed it runs on');
        const removed = client.events(REMOVE_BREAKPOINT_EVENT);
        assert.equal(removed.length, 1);
        assert.equal(removed[0].body.line, 10);
    });

    it('sends netcoredbg no marker as a condition (it is not C#)', async () => {
        client = new Client({ stops: [] });
        await run(client, [{ line: 10, condition: '#once' }, { line: 11, condition: 'i > 3' }]);
        const set = (await client.sentToDebugger()).find((r) => r.command === 'setBreakpoints');
        assert.deepEqual(set?.arguments.breakpoints, [{ line: 10 }, { line: 11, condition: 'i > 3' }]);
    });

    it('stops at a #caller breakpoint only when the method is a caller, or is not one with "!"', async () => {
        const viaSave = at(10, {}, 'Orders.Validate()', ['Orders.Save()', 'Program.Main()']);
        const viaLoad = at(10, {}, 'Orders.Validate()', ['Orders.Load()', 'Program.Main()']);
        client = new Client({ stops: [viaLoad, viaSave, viaLoad] });
        await run(client, [{ line: 10, condition: '#caller Save' }]);
        assert.equal(await shownLines(client), 1);
        await client.close();

        client = new Client({ stops: [viaLoad, viaSave, viaLoad] });
        await run(client, [{ line: 10, condition: '#caller !Save' }]);
        assert.equal(await shownLines(client), 2);
    });

    it('stops at a #changed breakpoint only when the value differs from the last pass, and says how', async () => {
        client = new Client({ stops: [at(10, { total: '1' }), at(10, { total: '1' }), at(10, { total: '5' }), at(10, { total: '5' })] });
        await run(client, [{ line: 10, condition: '#changed total' }]);
        assert.equal(await shownLines(client), 1, 'the first pass only records the value');
        assert.deepEqual(output(client), ['total: 1 → 5']);
    });

    it('reports a #track logpoint\'s values as an event, errors included, without printing', async () => {
        client = new Client({ stops: [at(10, { i: '1', 'i * 2': '2' })] });
        await run(client, [{ line: 10, logMessage: '#track: i; i * 2 ; bad' }]);
        assert.equal(await shownLines(client), 0);
        assert.deepEqual(output(client), []);
        const values = client.events(TRACK_EVENT)[0].body.values;
        assert.deepEqual(values.map((v: { expression: string; value: string; error?: string }) => [v.expression, v.value, Boolean(v.error)]), [
            ['i', '1', false],
            ['i * 2', '2', false],
            ['bad', '', true],
        ]);
    });

    it('times a section from #timer-start to #timer-end on the same thread, and ignores an end without a start', async () => {
        client = new Client({ stops: [at(20), at(10), at(20)] });
        await run(client, [{ line: 10, logMessage: '#timer-start: load' }, { line: 20, logMessage: '#timer-end: load' }]);
        assert.equal(await shownLines(client), 0);
        const timings = client.events(TRACK_EVENT);
        assert.equal(timings.length, 1, 'the first end came before any start');
        assert.equal(timings[0].body.values[0].expression, '⏱ load (ms)');
        assert.match(timings[0].body.values[0].value, /^\d+$/);
        assert.match(output(client)[0], /^⏱ load: ≤ \d+ ms$/);
    });
});

describe('exception log', () => {
    let client: Client | undefined;
    afterEach(async () => {
        await client?.close();
        client = undefined;
    });

    const thrown = (typeName: string, breakMode = 'always'): FakeStop => ({
        reason: 'exception',
        frames: [
            { id: 1, name: 'System.Number.ParseInt32()' },
            { id: 2, name: 'Program.Parse()', source: { path: FILE }, line: 33 },
        ],
        exception: { typeName, message: 'bad input', breakMode },
        localsReference: 5,
    });

    it('logs every thrown exception with its first user frame, and stops only on the checked types', async () => {
        client = new Client(
            { stops: [thrown('System.IO.IOException'), thrown('System.FormatException')], variables: { 5: [{ name: 's', value: '"x1"' }] } },
            [],
            { exceptionLog: true, breakOnExceptionTypes: ['System.FormatException'] },
        );
        await run(client, []);
        const logged = client.events(EXCEPTION_EVENT).map((m) => m.body);
        assert.deepEqual(logged.map((e) => [e.typeName, e.stopped, e.line, e.functionName]), [
            ['System.IO.IOException', false, 33, 'Program.Parse()'],
            ['System.FormatException', true, 33, 'Program.Parse()'],
        ]);
        assert.equal(client.events('stopped').length, 1);
        // The snapshot keeps the stack and the locals of the user's frame.
        const snapshot = logged[0].snapshot;
        assert.deepEqual(snapshot.frames.map((f: { name: string }) => f.name), ['System.Number.ParseInt32()', 'Program.Parse()']);
        assert.deepEqual(snapshot.frames[1].locals.map((l: { name: string; value: string }) => `${l.name}=${l.value}`), ['s="x1"']);
        assert.match(output(client)[0], /^System\.IO\.IOException: bad input at Program\.cs:33$/);
    });

    it('stops on an unhandled exception whatever the checked types', async () => {
        client = new Client({ stops: [thrown('System.IO.IOException', 'unhandled')] }, [], { exceptionLog: true });
        await run(client, []);
        assert.equal(client.events('stopped').length, 1);
        assert.equal(client.events(EXCEPTION_EVENT)[0].body.stopped, true);
    });

    it('asks netcoredbg for every thrown exception while the log is on, on top of the user\'s filters', async () => {
        client = new Client({ stops: [] }, [], { exceptionLog: true });
        await client.start(() => client!.request('setExceptionBreakpoints', { filters: ['user-unhandled'] }));
        const set = (await client.sentToDebugger()).find((r) => r.command === 'setExceptionBreakpoints');
        assert.ok(set?.arguments.filters.includes('all'), JSON.stringify(set?.arguments));
    });
});
