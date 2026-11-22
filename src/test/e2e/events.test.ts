// E2E: "Break on Event" reads okButton's handlers from the stopped Forms app and stops in the one picked.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { readEventHandlers, readEventKeys } from '../../eventHandlersCore';
import { DapSession, FRAMEWORK, appSource, buildApp, e2eSkip, lineOf } from './harness';

const BUTTON = 'System.Windows.Forms.Application.OpenForms[0].Controls[0].Controls[0]';

describe('breaking on control events', { skip: e2eSkip || (process.env.NETDBG_SKIP_UI_TESTS ? 'NETDBG_SKIP_UI_TESTS is set' : false) }, () => {
    let s: DapSession;
    let threadId = 0;
    let frameId = 0;

    before(async () => {
        const program = path.join(buildApp('Forms'), 'Forms.exe');
        const source = appSource('Forms', 'Program.cs');
        s = new DapSession();
        const first = s.nextStop();
        await s.launch(program, { [source]: [{ line: lineOf(source, 'shown') }] });
        threadId = (await first).body.threadId;
        frameId = (await s.topFrame(threadId)).id;
    });
    after(async () => {
        await s?.close();
    });

    it('lists the handlers of each event, lambdas included, and stops in the picked one', { timeout: 120_000 }, async () => {
        const request = async (command: string, args: Record<string, unknown>) => (await s.request(command, args)).body;
        const keys = await readEventKeys(BUTTON, frameId, request);
        // The key of Click: Control.s_clickEvent on .NET, Control.EventClick on .NET Framework.
        assert.ok(keys.some((k) => k.field === (FRAMEWORK === 'net48' ? 'EventClick' : 's_clickEvent')), `${keys.length} keys`);
        const evaluate = async (expression: string) => {
            const r = await s.evaluate(expression, frameId);
            if (!r.success) {
                throw new Error(r.message);
            }
            return r.body.result as string;
        };
        const handlers = await readEventHandlers(BUTTON, keys, evaluate);
        assert.deepEqual(handlers.map((h) => `${h.event}: ${h.breakpointName}`).sort(), [
            'Click: Program.<>c.<Main>b__0_0',
            'Click: Program.OnOkClick',
            'MouseDown: Program.OnOkMouseDown',
        ]);

        // The app clicks the button right after this stop.
        await s.request('setFunctionBreakpoints', { breakpoints: [{ name: handlers.find((h) => h.method === 'OnOkClick')!.breakpointName }] });
        const stop = await s.continueTo(threadId);
        assert.equal(stop.event, 'stopped');
        assert.match((await s.topFrame(stop.body.threadId)).name, /Program\.OnOkClick\(/);
    });
});
