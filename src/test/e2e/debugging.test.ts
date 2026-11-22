// E2E: the relay and the engine's features against the test/apps programs.

import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { MAKE_OBJECT_ID_REQUEST } from '../../objectIds';
import { SourcePathMapper } from '../../sourceMapCore';
import { captureValues, findMethodSignature, generateTest, parseFrameName } from '../../testGenCore';
import { DapSession, REPO, appSource, buildApp, e2eSkip, lineOf } from './harness';

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
        // The engine reads the calls from the IL and names them Type.Method.
        assert.deepEqual(targets.map((t: { label: string }) => t.label), ['Program.Inner1', 'Program.Inner2', 'Program.Outer']);
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

    it('steps into an assembly without symbols, which the engine decompiles to C#', { timeout: TIMEOUT }, async () => {
        // The program has its PDB, so NoPdbLib is not user code: step in with Just My Code off to enter it. The line first
        // makes its decimal arguments (.NET's own code, no source: the step comes back to the line), so step in until there.
        const s = session();
        const first = s.nextStop();
        await s.launch(program, { [PROGRAM_CS]: [{ line: line('call-nopdb') }] }, { justMyCode: false });
        const stop = await first;
        let frame = await s.topFrame(stop.body.threadId);
        for (let i = 0; i < 5 && !/NoPdbLib/.test(frame.name); i++) {
            const stepped = s.nextStop();
            await s.request('stepIn', { threadId: stop.body.threadId });
            frame = await s.topFrame((await stepped).body.threadId);
        }
        assert.match(frame.name, /NoPdbLib\.Pricing\.WithTax\(/);
        assert.match(frame.source.path, /\\netdbg\\decompiled\\.*\\Pricing\.cs$/i);
        assert.ok(fs.readFileSync(frame.source.path, 'utf8').split(/\r?\n/)[frame.line - 1].trim().length > 0, 'the frame\'s line has code');
    });
});

describe('UI freeze detection', { skip: e2eSkip || (process.env.NETDBG_SKIP_UI_TESTS ? 'NETDBG_SKIP_UI_TESTS is set' : false) }, () => {
    it('pauses on the UI thread that stopped answering', { timeout: TIMEOUT }, async () => {
        const program = path.join(buildApp('Freeze'), 'Freeze.exe');
        // The engine watches the UI itself (with the extension's settings); the relay gives the stop the extension's words.
        const s = new DapSession({ freezeDescription: (ms) => `Frozen for ${(ms / 1000).toFixed(1)} s`, uiFreeze: { enabled: true, thresholdMs: 2000 } });
        try {
            const paused = s.nextStop(TIMEOUT);
            await s.launch(program);
            const stop = await paused;
            assert.equal(stop.body.reason, 'pause');
            assert.match(stop.body.description, /^Frozen for \d\.\d s$/);
            const console = s.events.filter((m) => m.event === 'output').map((m) => String(m.body?.output)).join('');
            assert.ok(console.includes(`${stop.body.description}\n`) && !console.includes('UI not responding'), console);
            const names = (await s.frames(stop.body.threadId)).map((f) => f.name);
            assert.ok(names.some((n) => /Program\.Freeze\(/.test(n)), names.join(', '));
        } finally {
            await s.close();
        }
    });
});
