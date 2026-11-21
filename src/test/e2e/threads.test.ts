// E2E: Parallel Stacks (all threads' stacks merged) and freezing threads.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { buildStackGraph } from '../../parallelStacksCore';
import { DapSession, FRAMEWORK, appSource, buildApp, e2eSkip, lineOf } from './harness';

describe('threads', { skip: e2eSkip }, () => {
    let s: DapSession;
    let mainThread = 0;
    const source = appSource('Threads', 'Program.cs');

    before(async () => {
        const program = path.join(buildApp('Threads'), 'Threads.exe');
        s = new DapSession();
        const first = s.nextStop();
        await s.launch(program, { [source]: ['first', 'second', 'third', 'fourth'].map((m) => ({ line: lineOf(source, m) })) });
        mainThread = (await first).body.threadId;
    });
    after(async () => {
        await s?.close();
    });

    const count = async (index: number) => {
        const frame = await s.topFrame(mainThread);
        return Number((await s.evaluate(`Program.Counts[${index}]`, frame.id)).body.result);
    };
    const workers = async () => {
        const threads: { id: number; name: string }[] = (await s.request('threads')).body.threads;
        return { a: threads.find((t) => t.name === 'worker-a')!, b: threads.find((t) => t.name === 'worker-b')! };
    };
    const next = async (marker: string) => {
        const stop = await s.continueTo(mainThread);
        assert.equal(stop.event, 'stopped');
        assert.equal((await s.topFrame(stop.body.threadId)).line, lineOf(source, marker));
    };

    it('merges the stacks of the threads into boxes', { timeout: 60_000 }, async () => {
        const threads: { id: number; name: string }[] = (await s.request('threads')).body.threads;
        const stacks = await Promise.all(threads.map(async (t) => ({ ...t, frames: (await s.request('stackTrace', { threadId: t.id, levels: 50 })).body.stackFrames ?? [] })));
        const graph = buildStackGraph(stacks);
        const { a, b } = await workers();
        // Both workers start in the runtime's thread entry (one box for the two), then run different lambdas into Work.
        // (Thread.StartCallback on .NET, ThreadHelper.ThreadStart on .NET Framework.)
        const shared = graph.find((n) => n.threadIds.includes(a.id) && n.threadIds.includes(b.id));
        assert.ok(shared, JSON.stringify(graph.map((n) => n.frames.map((f) => f.name))));
        assert.match(shared.frames[0].name, FRAMEWORK === 'net48' ? /ThreadHelper\.ThreadStart/ : /StartCallback/);
        type Node = ReturnType<typeof buildStackGraph>[number];
        const reachesWork = (n: Node, thread: number): boolean =>
            n.threadIds.includes(thread) && (n.frames.some((f) => /Program\.Work\(/.test(f.name)) || n.children.some((c) => reachesWork(c, thread)));
        assert.ok(reachesWork(shared, a.id) && reachesWork(shared, b.id));
        assert.equal(graph.find((n) => n.threadIds.includes(mainThread))?.threadIds.length, 1, 'Main has a box of its own');
    });

    it('keeps a frozen thread suspended across continues and evaluations, until it is thawed', { timeout: 60_000 }, async () => {
        const { a } = await workers();
        assert.equal((await s.request('dotnetX86.freezeThread', { threadId: a.id, frozen: true })).success, true);
        const names = async () => ((await s.request('threads')).body.threads as { name: string }[]).map((t) => t.name);
        assert.ok((await names()).includes('worker-a [frozen]'), 'the Call Stack view says it is frozen');
        const frozenAt = await count(0);
        const otherAt = await count(1);

        await next('second');
        assert.equal(await count(0), frozenAt, 'the frozen worker did not count');
        assert.ok((await count(1)) > otherAt, 'the other worker kept counting');

        // count() evaluated expressions, which runs the other threads for a moment: worker-a must still be frozen.
        await next('third');
        assert.equal(await count(0), frozenAt, 'still frozen after evaluating expressions');

        assert.equal((await s.request('dotnetX86.freezeThread', { threadId: a.id, frozen: false })).success, true);
        assert.ok((await names()).includes('worker-a'));
        await next('fourth');
        assert.ok((await count(0)) > frozenAt, 'counting again once thawed');
    });
});
