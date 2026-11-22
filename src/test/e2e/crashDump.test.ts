// E2E: a crash dump opens through the proxy as a stopped program (the engine reads it; the proxy passes it through).

import * as assert from 'assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { readDumpArchitecture } from '../../dumpInfo';
import { ARCH, DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

describe('crash dumps', { skip: e2eSkip }, () => {
    let s: DapSession;
    let thread = 0;
    const source = appSource('CrashDump', 'Program.cs');
    const dump = path.join(os.tmpdir(), 'netdbg-e2e', `CrashDump-${ARCH}-${process.pid}.dmp`);

    before(async () => {
        const program = path.join(buildApp('CrashDump'), 'CrashDump.exe');
        // Run the app until it waits in the exception filter, then write its dump with the 64-bit PowerShell (a 32-bit
        // process gives a WOW64 dump, as Task Manager and WER write them).
        const app = cp.spawn(program, [], { stdio: ['ignore', 'pipe', 'ignore'] });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the app did not start waiting')), 30_000);
            app.stdout.on('data', (d: Buffer) => d.toString().includes('waiting') && (clearTimeout(timer), resolve()));
        });
        const powershell = path.join(process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const written = cp.spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', appSource('CrashDump', 'write-dump.ps1'), '-ProcessId', String(app.pid), '-Path', dump], { encoding: 'utf8' });
        app.kill();
        assert.equal(written.status, 0, written.stderr);
        s = new DapSession();
        const first = s.nextStop();
        await s.request('initialize', { adapterID: 'netdbg', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
        const launched = await s.request('launch', { dumpPath: dump });
        assert.ok(launched.success, launched.message);
        await s.request('configurationDone');
        thread = (await first).body.threadId;
    });
    after(async () => {
        await s?.close();
        fs.rmSync(dump, { force: true });
    });

    it('chooses the engine of the dumped process', () => {
        assert.equal(readDumpArchitecture(dump), ARCH);
    });

    it('stops on the thread that was throwing, with the stack and the locals', { timeout: 60_000 }, async () => {
        const frames: any[] = await s.frames(thread);
        const validate = frames.find((f) => f.name === 'Program.Validate()');
        assert.ok(validate, JSON.stringify(frames.map((f) => f.name)));
        assert.equal(validate.line, lineOf(source, 'throw'));
        assert.equal((await s.evaluate('order.Customer', validate.id)).body.result, '"C2"');
        const info = await s.request('exceptionInfo', { threadId: thread });
        assert.equal(info.body.details.message, 'Amount 31.0 exceeds 20');
    });

    it('refuses to continue, with the reason', async () => {
        const continued = await s.request('continue', { threadId: thread });
        assert.equal(continued.success, false);
        assert.match(continued.message ?? '', /クラッシュダンプは読むだけ/);
    });
});