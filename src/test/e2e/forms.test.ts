// E2E: changing WinForms control properties in the stopped program (WinForms Controls view, "Change Property...").

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { failedResult, setterExpression, valueExpression } from '../../controlPropertyCore';
import { DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

const BUTTON = 'System.Windows.Forms.Application.OpenForms[0].Controls[0].Controls[0]';

describe('changing control properties', { skip: e2eSkip || (process.env.DOTNETX86_SKIP_UI_TESTS ? 'DOTNETX86_SKIP_UI_TESTS is set' : false) }, () => {
    let s: DapSession;
    let frameId = 0;

    before(async () => {
        const program = path.join(buildApp('Forms'), 'Forms.exe');
        const source = appSource('Forms', 'Program.cs');
        s = new DapSession();
        const first = s.nextStop();
        await s.launch(program, { [source]: [{ line: lineOf(source, 'shown') }] });
        frameId = (await s.topFrame((await first).body.threadId)).id;
    });
    after(async () => {
        await s?.close();
    });

    const set = async (property: string, kind: Parameters<typeof valueExpression>[0], input: string) => {
        const value = valueExpression(kind, input);
        assert.ok('expression' in value);
        return s.evaluate(setterExpression(BUTTON, property, value.expression), frameId);
    };

    for (const [property, kind, input, expected] of [
        ['Text', 'string', 'Changed "here"', '"Changed \\"here\\""'],
        ['Visible', 'bool', 'false', 'false'],
        ['Width', 'int', '150', '150'],
        ['BackColor', 'color', '#ff0080', '"{Name = ffff0080, ARGB = (255, 255, 0, 128)}"'],
        ['ForeColor', 'color', 'Red', '"{Name = Red, ARGB = (255, 255, 0, 0)}"'],
    ] as const) {
        it(`sets ${property} through its setter`, { timeout: 60_000 }, async () => {
            const r = await set(property, kind, input);
            assert.equal(r.success, true, r.message);
            assert.equal(failedResult(r.body), undefined);
            assert.equal((await s.evaluate(`${BUTTON}.${property}`, frameId)).body.result, expected);
        });
    }

    // netcoredbg's evaluator cannot pass enum values (the command explains it); the new engine (dotnet-x86dbg) can.
    if (process.env.DOTNETX86_E2E_DEBUGGER) {
        it('passes an enum value', { timeout: 60_000 }, async () => {
            const r = await set('Dock', 'expression', 'System.Windows.Forms.DockStyle.Fill');
            assert.equal(r.success, true, r.message);
            assert.equal(failedResult(r.body), undefined);
            assert.equal((await s.evaluate(`${BUTTON}.Dock`, frameId)).body.result, 'Fill');
        });
    } else {
        it('cannot pass an enum value (a netcoredbg limitation the command explains)', { timeout: 60_000 }, async () => {
            const r = await set('Dock', 'expression', 'System.Windows.Forms.DockStyle.Fill');
            assert.ok(!r.success || failedResult(r.body) !== undefined, JSON.stringify(r.body));
            assert.equal((await s.evaluate(`${BUTTON}.Dock`, frameId)).body.result, 'None');
        });
    }
});
