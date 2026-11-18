// E2E: stepping (stepIn / stepOut / next) and the return values of the calls stepped over or out of.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('stepping', { skip: e2eSkip }, () => {
    const source = appSource('Basic', 'Program.cs');
    let s: DapSession;
    let threadId = 0;

    before(async () => {
        s = new DapSession();
        const first = s.nextStop();
        await s.launch(path.join(buildApp('Basic'), 'Basic.exe'), { [source]: [{ line: lineOf(source, 'nested') }, { line: lineOf(source, 'label-return') }] });
        threadId = (await first).body.threadId;
    });
    after(async () => {
        await s?.close();
    });

    /** Sends a step request and waits for the stop; returns the top frame where it stopped. */
    const step = async (command: string): Promise<any> => {
        const stopped = s.nextStop();
        const r = await s.request(command, { threadId });
        assert.equal(r.success, true, r.message);
        const stop = await stopped;
        assert.equal(stop.body.reason, 'step');
        threadId = stop.body.threadId;
        return s.topFrame(threadId);
    };

    /** "name=value" of the return values the debugger shows at the top of the locals. */
    const returned = async (): Promise<string[]> => {
        const frame = await s.topFrame(threadId);
        const scopes = await s.request('scopes', { frameId: frame.id });
        const variables = await s.request('variables', { variablesReference: scopes.body.scopes[0].variablesReference });
        return (variables.body.variables as any[]).filter((v) => / returned$/.test(v.name)).map((v) => `${v.name}=${v.value}`);
    };

    it('steps into the first call of the line, and out of it with its return value', { timeout: 60_000 }, async () => {
        const inner = await step('stepIn');
        assert.match(inner.name, /Program\.Inner1\(\)$/);
        const back = await step('stepOut');
        assert.equal(back.line, lineOf(source, 'nested'));
        assert.deepEqual(await returned(), ['Program.Inner1 returned=10']);
    });

    it('steps over the rest of the line, showing the return values of the calls in order', { timeout: 60_000 }, async () => {
        const next = await step('next');
        assert.equal(next.line, lineOf(source, 'orders'));
        assert.deepEqual(await returned(), ['Program.Inner2 returned=200', 'Program.Outer returned=210']);
    });

    // (Orders.Total returns a decimal: no debugger can show it, the runtime cannot read return values passed in a hidden buffer.)
    it('steps out of a method to the line of its call, with the return value', { timeout: 60_000 }, async () => {
        const stopped = s.nextStop();
        await s.request('continue', { threadId });
        const stop = await stopped;
        threadId = stop.body.threadId;
        assert.equal((await s.topFrame(threadId)).line, lineOf(source, 'label-return'));
        const back = await step('stepOut');
        assert.equal(back.line, lineOf(source, 'call-label'));
        assert.deepEqual(await returned(), ['Orders.Label returned="A-1 x3"']);
    });
});
