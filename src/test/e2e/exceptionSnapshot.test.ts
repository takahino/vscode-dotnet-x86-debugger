// E2E: the exception log keeps a snapshot (call stack and locals) of an exception that is thrown and caught.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { EXCEPTION_EVENT } from '../../dapProxy';
import { DapSession, buildApp, e2eSkip } from './harness';

describe('exception snapshots', { skip: e2eSkip }, () => {
    let program = '';
    const sessions: DapSession[] = [];
    before(() => {
        program = path.join(buildApp('Basic'), 'Basic.exe');
    });
    after(async () => {
        for (const s of sessions) {
            await s.close();
        }
    });

    const logged = async (exceptionSnapshot: boolean) => {
        const s = new DapSession({ exceptionLog: true, exceptionSnapshot });
        sessions.push(s);
        const end = s.waitFor((m) => m.event === 'terminated', 120_000, 'the end');
        await s.launch(program);
        await end;
        const event = s.events.find((e) => e.event === EXCEPTION_EVENT && e.body.typeName === 'System.FormatException');
        assert.ok(event, 'the FormatException was logged');
        return event.body;
    };

    it('records the call stack and the locals of the user code at the throw, without stopping', { timeout: 120_000 }, async () => {
        const body = await logged(true);
        assert.equal(body.stopped, false);
        const frames: { name: string; readLocals: boolean; locals?: { name: string; value: string }[] }[] = body.snapshot.frames;
        assert.ok(frames.some((f) => !f.readLocals), 'framework frames are kept, without locals');
        // Main is async: its body runs as Program.<Main>d__0.MoveNext().
        const main = frames.find((f) => f.readLocals && /Program\.<?Main/.test(f.name));
        assert.ok(main, frames.map((f) => f.name).join(', '));
        const total = main.locals?.find((l) => l.name === 'total');
        assert.equal(total?.value, '15', JSON.stringify(main.locals));
        assert.match(body.snapshot.stackTrace ?? '', /Int32\.Parse|Number/);
    });

    it('records no snapshot when it is turned off', { timeout: 120_000 }, async () => {
        assert.equal((await logged(false)).snapshot, undefined);
    });
});
