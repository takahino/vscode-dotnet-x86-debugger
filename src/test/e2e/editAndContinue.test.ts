// E2E: Edit and Continue through the relay. The app is copied to a temporary folder and built there (the test edits its
// source); the edit is applied with netdbg.applyChanges, as the extension does on save, and the program runs it.

import * as assert from 'assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { APPLY_CHANGES_REQUEST, CHANGES_APPLIED_EVENT } from '../../editAndContinueCore';
import { ARCH, DapSession, FRAMEWORK, REPO, e2eSkip, lineOf } from './harness';

const TIMEOUT = 180_000;

/** Copies test/apps/EditAndContinue to a temporary folder and builds it for the bitness and framework under test. */
function buildCopy(): { program: string; source: string } {
    const work = path.join(os.tmpdir(), 'netdbg-e2e-enc', `${ARCH}-${FRAMEWORK ?? 'net10.0'}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const app = path.join(REPO, 'test', 'apps', 'EditAndContinue');
    for (const file of fs.readdirSync(app).filter((f) => /\.(cs|csproj)$/.test(f))) {
        let text = fs.readFileSync(path.join(app, file), 'utf8');
        if (file.endsWith('.csproj')) {
            text = text.replace(/x86/g, ARCH);
            if (FRAMEWORK) text = text.replace('<TargetFramework>net10.0</TargetFramework>', `<TargetFramework>${FRAMEWORK}</TargetFramework>`);
        }
        fs.writeFileSync(path.join(work, file), text);
    }
    const out = path.join(work, 'bin');
    const result = cp.spawnSync('dotnet', ['build', work, '-c', 'Debug', '-o', out, '-nologo', '-v', 'q'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`dotnet build failed:\n${result.stdout}\n${result.stderr}`);
    return { program: path.join(out, 'EditAndContinue.exe'), source: path.join(work, 'Program.cs') };
}

describe('Edit and Continue through the relay', { skip: e2eSkip }, () => {
    let app = { program: '', source: '' };
    let session: DapSession | undefined;

    before(() => {
        app = buildCopy();
    });
    after(async () => {
        await session?.close();
    });

    it('applies a saved edit to the stopped program, which runs the new code from the next call', { timeout: TIMEOUT }, async () => {
        session = new DapSession({});
        const firstStop = session.nextStop(TIMEOUT);
        await session.launch(app.program, { [app.source]: [{ line: lineOf(app.source, 'loop') }] }, { editAndContinue: true });
        const stop = await firstStop;
        let frame = await session.topFrame(stop.body.threadId);
        assert.equal((await session.evaluate('r', frame.id)).body.result, '11');

        fs.writeFileSync(app.source, fs.readFileSync(app.source, 'utf8').replace('return x + 1;', 'return x * 100;'));
        const event = session.waitFor((m) => m.type === 'event' && m.event === CHANGES_APPLIED_EVENT, TIMEOUT, 'the applied event');
        const applied = await session.request(APPLY_CHANGES_REQUEST, { files: [app.source] }, TIMEOUT);
        assert.equal(applied.success, true, applied.message);
        assert.equal(applied.body.status, 'applied', JSON.stringify(applied.body));
        assert.equal((await event).body.status, 'applied');

        const next = await session.continueTo(stop.body.threadId, TIMEOUT);
        frame = await session.topFrame(next.body.threadId);
        assert.equal((await session.evaluate('r', frame.id)).body.result, '1000');
        assert.equal((await session.evaluate('total', frame.id)).body.result, '11');
    });

    it('says where an edit cannot be applied, and the program keeps running the code it has', { timeout: TIMEOUT }, async () => {
        assert.ok(session);
        fs.writeFileSync(app.source, fs.readFileSync(app.source, 'utf8').replace('static int Compute(int x)', 'static int Compute(int x, int y = 0)'));
        const refused = await session.request(APPLY_CHANGES_REQUEST, { files: [app.source] }, TIMEOUT);
        assert.equal(refused.body.status, 'rude', JSON.stringify(refused.body));
        assert.ok(refused.body.problems.some((p: { line: number; message: string }) => p.line > 0 && /Compute/.test(p.message)), JSON.stringify(refused.body.problems));
    });
});
