// E2E: code coverage as the editor shows it: the launch argument `coverage` (from the setting dotnetX86.coverage.enabled),
// the engine's `dotnetX86.coverageChanged` naming the source, and `dotnetX86.coverage { file }` read into the editor's marks.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { COVERAGE_CHANGED_EVENT, COVERAGE_REQUEST, coverageMarks, samePath } from '../../coverageCore';
import { DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

describe('code coverage in the editor', { skip: e2eSkip }, () => {
    let s: DapSession;
    const source = appSource('Basic', 'Program.cs');

    before(async () => {
        const program = path.join(buildApp('Basic'), 'Basic.exe');
        s = new DapSession();
        const first = s.nextStop();
        // Stop after the order lines were created: the lines before have run, the method that counts has not.
        await s.launch(program, { [source]: [{ line: lineOf(source, 'orders') }] }, { coverage: true });
        await first;
    });
    after(async () => {
        await s?.close();
    });

    it('names the changed source, and its lines become run and not-run marks', { timeout: 120_000 }, async () => {
        const deadline = Date.now() + 10_000;
        while (!s.events.some((e) => e.event === COVERAGE_CHANGED_EVENT && (e.body?.files ?? []).some((f: string) => samePath(f, source))) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const changed = s.events.filter((e) => e.event === COVERAGE_CHANGED_EVENT).at(-1);
        assert.ok(changed, 'no dotnetX86.coverageChanged');
        assert.ok(changed.body.linesValid > 0 && changed.body.lineRate > 0, JSON.stringify(changed.body));

        const r = await s.request(COVERAGE_REQUEST, { file: source });
        assert.ok(r.success, r.message);
        const marks = coverageMarks(r.body.lines);
        assert.ok(marks.hit.includes(lineOf(source, 'nested') - 1), `@nested ran: ${JSON.stringify(marks)}`);
        assert.ok(marks.missed.includes(lineOf(source, 'call-label') - 1), `@call-label (after the stop) has not run: ${JSON.stringify(marks)}`);
    });
});
