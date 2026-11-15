// E2E: the relay's features against the real netcoredbg and the test/apps programs.

import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { FREEZE_PAUSE_REQUEST } from '../../dapProxy';
import { decompileAssembly, readDecompiledAssemblies, SYMBOL_DIRS_ENV } from '../../decompilerCore';
import { MAKE_OBJECT_ID_REQUEST } from '../../objectIds';
import { SourcePathMapper } from '../../sourceMapCore';
import { captureValues, findMethodSignature, generateTest, parseFrameName } from '../../testGenCore';
import { UiFreezeWatch } from '../../uiFreezeWatch';
import { DECOMPILER, DapSession, REPO, appSource, buildApp, e2eSkip, lineOf } from './harness';

const TIMEOUT = 120_000;
const PROGRAM_CS = appSource('Basic', 'Program.cs');
const line = (marker: string) => lineOf(PROGRAM_CS, marker);

describe('debugging the Basic app', { skip: e2eSkip }, () => {
    let program = '';
    const sessions: DapSession[] = [];
    const session = (options = {}) => {
        const s = new DapSession(options);
        sessions.push(s);
        return s;
    };

    before(() => {
        program = path.join(buildApp('Basic'), 'Basic.exe');
    });
    after(async () => {
        for (const s of sessions) {
            await s.close();
        }
    });

    it('prints logpoint messages without stopping', { timeout: TIMEOUT }, async () => {
        const s = session();
        const end = s.waitFor((m) => m.event === 'terminated', TIMEOUT, 'the end');
        await s.launch(program, { [PROGRAM_CS]: [{ line: line('loop'), logMessage: 'i={i} total={total}' }] });
        await end;
        const printed = s.events.filter((e) => e.event === 'output' && /^i=\d/.test(e.body.output)).map((e) => e.body.output.trim());
        assert.deepEqual(printed, ['i=1 total=0', 'i=2 total=1', 'i=3 total=3', 'i=4 total=6', 'i=5 total=10']);
        assert.equal(s.events.filter((e) => e.event === 'stopped').length, 0);
    });

    it('stops only on the pass a hit count asks for', { timeout: TIMEOUT }, async () => {
        const s = session();
        const first = s.nextStop();
        await s.launch(program, { [PROGRAM_CS]: [{ line: line('loop'), hitCondition: '==3' }] });
        const stop = await first;
        const frame = await s.topFrame(stop.body.threadId);
        assert.equal((await s.evaluate('i', frame.id)).body.result, '3');
        assert.equal((await s.continueTo(stop.body.threadId)).event, 'terminated');
    });

    for (const exceptionLog of [false, true]) {
        it(`stops when a checked exception type is thrown (exception log ${exceptionLog ? 'on' : 'off'})`, { timeout: TIMEOUT }, async () => {
            const s = session({ exceptionLog, breakOnExceptionTypes: ['System.FormatException'] });
            const first = s.nextStopOrEnd();
            await s.launch(program);
            const stop = await first;
            assert.equal(stop.event, 'stopped');
            assert.equal(stop.body.reason, 'exception');
            const names = (await s.frames(stop.body.threadId)).map((f) => f.name);
            assert.ok(names.some((n) => /Program\.Main/.test(n)), names.join(', '));
        });

        it(`runs through an exception type that is not checked (exception log ${exceptionLog ? 'on' : 'off'})`, { timeout: TIMEOUT }, async () => {
            const s = session({ exceptionLog, breakOnExceptionTypes: ['System.IO.IOException'] });
            const first = s.nextStopOrEnd();
            await s.launch(program);
            assert.equal((await first).event, 'terminated');
        });
    }

    it('stops at a #caller breakpoint only when the method is a caller', { timeout: TIMEOUT }, async () => {
        const s = session();
        const first = s.nextStop();
        await s.launch(program, { [PROGRAM_CS]: [{ line: line('log'), condition: '#caller B' }] });
        const stop = await first;
        const frames = await s.frames(stop.body.threadId, 2);
        assert.match(frames[1].name, /Program\.B\(/);
        assert.equal((await s.continueTo(stop.body.threadId)).event, 'terminated');
    });

    it('lists step-in targets in the order they run and steps into the picked one', { timeout: TIMEOUT }, async () => {
        const s = session();
        const first = s.nextStop();
        await s.launch(program, { [PROGRAM_CS]: [{ line: line('nested') }] });
        const stop = await first;
        const frame = await s.topFrame(stop.body.threadId);
        const targets = (await s.request('stepInTargets', { frameId: frame.id })).body.targets;
        assert.deepEqual(targets.map((t: { label: string }) => t.label), ['Inner1', 'Inner2', 'Outer']);
        const stepped = s.nextStop();
        await s.request('stepIn', { threadId: stop.body.threadId, targetId: targets[1].id });
        const arrived = await stepped;
        assert.equal(arrived.body.reason, 'step');
        assert.match((await s.topFrame(arrived.body.threadId)).name, /Program\.Inner2\(/);
    });

    it('reaches an object by its ID from another method and in conditions', { timeout: TIMEOUT }, async () => {
        const s = session();
        const first = s.nextStop();
        await s.launch(program, { [PROGRAM_CS]: [{ line: line('total-return') }, { line: line('label-return'), condition: 'sku == $2.Sku' }] });
        let stop = await first;
        let frame = await s.topFrame(stop.body.threadId);
        const lines = (await s.evaluate('lines', frame.id)).body;
        const first1 = (await s.evaluate('lines[0]', frame.id)).body;
        assert.equal((await s.request(MAKE_OBJECT_ID_REQUEST, { variablesReference: lines.variablesReference })).body.id, 1);
        assert.equal((await s.request(MAKE_OBJECT_ID_REQUEST, { variablesReference: first1.variablesReference })).body.id, 2);
        assert.match((await s.evaluate('lines', frame.id)).body.result, /\{\$1\}$/);

        stop = await s.continueTo(stop.body.threadId);
        frame = await s.topFrame(stop.body.threadId);
        assert.match(frame.name, /Orders\.Label\(/, 'the "sku == $2.Sku" condition held');
        assert.equal((await s.evaluate('$1.Count', frame.id)).body.result, '2');
        assert.equal((await s.evaluate('$2.Sku', frame.id)).body.result, '"A-1"');
        assert.equal((await s.evaluate('$9', frame.id)).success, false);
    });

    it('generates a test that replays an async instance method', { timeout: TIMEOUT }, async () => {
        const s = session();
        const first = s.nextStop();
        await s.launch(program, { [PROGRAM_CS]: [{ line: line('count-return') }] });
        const stop = await first;
        const frame = await s.topFrame(stop.body.threadId);
        const method = parseFrameName(frame.name);
        assert.ok(method, frame.name);
        const signature = findMethodSignature(fs.readFileSync(PROGRAM_CS, 'utf8').split(/\r?\n/), frame.line, method.method);
        assert.ok(signature);
        const captured = await captureValues(
            signature,
            async (expression) => (await s.evaluate(expression, frame.id)).body,
            async (command, args) => (await s.request(command, args)).body,
            { maxDepth: 3, maxNodes: 2000 },
        );
        const code = generateTest({ framework: 'xunit', frame: method, signature, values: captured.values, instance: captured.instance, location: 'Program.cs' });
        assert.match(code, /var result = await sut\.CountAsync\(values\);/);
        assert.match(code, /var sut = new Basic\.Orders/);
        assert.match(code, /var values = new int\[\]/);
    });

    it('maps PDB paths of another machine to local sources', { timeout: TIMEOUT }, async () => {
        const dir = path.dirname(program);
        const mapper = new SourcePathMapper({ sourceSearchPaths: [path.join(REPO, 'test', 'apps')] });
        const preloadModules = fs.readdirSync(dir).filter((f) => /\.dll$/i.test(f)).map((f) => path.join(dir, f));
        const s = session({ sourceMapper: mapper, preloadModules });
        const calc = appSource('MappedLib', 'Calc.cs');
        const first = s.nextStop();
        await s.launch(program, { [calc]: [{ line: lineOf(calc, 'add-sum') }] });
        const stop = await first;
        const frame = await s.topFrame(stop.body.threadId);
        assert.match(frame.name, /MappedLib\.Calc\.Add\(/);
        assert.equal(path.resolve(frame.source.path).toLowerCase(), path.resolve(calc).toLowerCase());
    });

    it('steps into a decompiled assembly', { timeout: TIMEOUT, skip: fs.existsSync(DECOMPILER) ? false : 'the decompiler helper is not built' }, async () => {
        const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetx86-decompiled-'));
        // The temp folder may be given in its short 8.3 form (C:\Users\RUNNER~1\...) while paths come back long.
        const realPath = (p: string) => fs.realpathSync.native(p).toLowerCase();
        let s: DapSession | undefined;
        try {
            await decompileAssembly('dotnet', DECOMPILER, path.join(path.dirname(program), 'NoPdbLib.dll'), cache);
            const mapper = new SourcePathMapper();
            mapper.addFilePairs(readDecompiledAssemblies(cache).flatMap((a) => a.documents.map((d) => ({ pdbPath: d.name, local: d.file }))));
            s = session({ sourceMapper: mapper, env: { [SYMBOL_DIRS_ENV]: cache } });
            const first = s.nextStop();
            await s.launch(program, { [PROGRAM_CS]: [{ line: line('call-nopdb') }] });
            const stop = await first;
            const stepped = s.nextStop();
            await s.request('stepIn', { threadId: stop.body.threadId });
            const arrived = await stepped;
            const frame = await s.topFrame(arrived.body.threadId);
            assert.match(frame.name, /NoPdbLib\.Pricing\.WithTax\(/);
            assert.ok(realPath(frame.source.path).startsWith(realPath(cache)), frame.source.path);
        } finally {
            // netcoredbg holds the generated PDB until it exits, also when an assertion failed above.
            await s?.close();
            // Windows may hold a just-closed file for a moment: retry, and never fail the test over a temporary folder.
            try {
                fs.rmSync(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
            } catch (e) {
                console.warn(`could not delete ${cache}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    });
});

describe('UI freeze detection', { skip: e2eSkip || (process.env.DOTNETX86_SKIP_UI_TESTS ? 'DOTNETX86_SKIP_UI_TESTS is set' : false) }, () => {
    it('pauses on the UI thread that stopped answering', { timeout: TIMEOUT }, async () => {
        const program = path.join(buildApp('Freeze'), 'Freeze.exe');
        const s = new DapSession({ freezeDescription: (ms) => `UI not responding for ${(ms / 1000).toFixed(1)} s` });
        let watch: UiFreezeWatch | undefined;
        try {
            const started = s.waitFor((m) => m.event === 'process', TIMEOUT, 'the process event');
            await s.launch(program);
            const pid = (await started).body.systemProcessId;
            const hung = await new Promise<{ threadId: number; ms: number }>((resolve) => {
                watch = new UiFreezeWatch(REPO, pid, 2000, (threadId, ms) => resolve({ threadId, ms }), () => undefined);
            });
            watch!.pause();
            const paused = s.nextStop();
            assert.equal((await s.request(FREEZE_PAUSE_REQUEST, { threadId: hung.threadId, ms: hung.ms })).success, true);
            const stop = await paused;
            assert.equal(stop.body.threadId, hung.threadId);
            assert.match(stop.body.description, /^UI not responding for \d\.\d s$/);
            const names = (await s.frames(stop.body.threadId)).map((f) => f.name);
            assert.ok(names.some((n) => /Program\.Freeze\(/.test(n)), names.join(', '));
        } finally {
            watch?.dispose();
            await s.close();
        }
    });
});
