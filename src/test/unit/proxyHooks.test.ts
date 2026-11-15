// The DAP relay's own breakpoints (SQL log, event trace) against a scripted stand-in for netcoredbg (fakeDebugger):
// what netcoredbg gets, what VS Code is shown, and that stops at them never reach VS Code.

import * as assert from 'assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EVENT_TRACE_EVENT, EVENT_TRACE_REQUEST, SQL_EVENT } from '../../dapProxy';
import { Client, Message, stopped } from './fakeClient';
import { FakeStop } from './fakeDebugger';

/* eslint-disable @typescript-eslint/no-explicit-any */


const EXECUTE_READER = 'Oracle.ManagedDataAccess.Client.OracleCommand.ExecuteReader';
const SOURCE = { path: 'C:\\app\\MyDb.cs' };


/** A stop at ExecuteReader called from MyDb.Query, reading "SELECT ... :name" with one parameter. */
function sqlStop(firstFrameId: number, extraFrames: FakeStop['frames'] = []): FakeStop {
    return {
        reason: 'breakpoint',
        frames: [
            { id: firstFrameId, name: `${EXECUTE_READER}()` },
            ...extraFrames,
            { id: firstFrameId + 10, name: 'MyDb.Query()', source: SOURCE, line: 31 },
            { id: firstFrameId + 11, name: 'Program.Main()', source: { path: 'C:\\app\\Program.cs' }, line: 41 },
        ],
        values: {
            'this.CommandText': { result: '"SELECT * FROM EMP WHERE ENAME = :name"', type: 'string' },
            'this.CommandType.ToString()': { result: '"Text"', type: 'string' },
            'this.BindByName': { result: 'true', type: 'bool' },
            'this.Parameters.Count': { result: '1', type: 'int' },
            'this.Parameters[0].ParameterName': { result: '"name"', type: 'string' },
            'this.Parameters[0].Direction.ToString()': { result: '"Input"', type: 'string' },
            'this.Parameters[0].Value': { result: '"Smith"', type: 'string' },
        },
    };
}

const userStop: FakeStop = { reason: 'breakpoint', frames: [{ id: 900, name: 'Program.Main()', source: { path: 'C:\\app\\Program.cs' }, line: 50 }] };

describe('the relay\'s own breakpoints', () => {
    let client: Client | undefined;
    afterEach(async () => {
        await client?.close();
        client = undefined;
    });

    it('sets the SQL log\'s breakpoints (binding without symbols) before the program runs, when VS Code has no function breakpoints', async () => {
        client = new Client({ stops: [] }, [EXECUTE_READER]);
        await client.start();
        const sent = await client.sentToDebugger();
        const commands = sent.map((r) => r.command);
        const set = commands.indexOf('setFunctionBreakpoints');
        assert.ok(set >= 0 && set < commands.indexOf('configurationDone'), commands.join(', '));
        assert.deepEqual(sent[set].arguments.breakpoints, [{ name: EXECUTE_READER, anyCode: true }]);
    });

    it('sends VS Code\'s function breakpoints with them, and shows VS Code only its own (responses and events)', async () => {
        client = new Client({ stops: [] }, [EXECUTE_READER]);
        let response: Message | undefined;
        await client.start(async () => {
            response = await client!.request('setFunctionBreakpoints', { breakpoints: [{ name: 'Program.Main' }] });
        });
        const sent = (await client.sentToDebugger()).filter((r) => r.command === 'setFunctionBreakpoints');
        assert.equal(sent.length, 1, 'no second set at configurationDone');
        assert.deepEqual(sent[0].arguments.breakpoints, [{ name: 'Program.Main' }, { name: EXECUTE_READER, anyCode: true }]);
        const own = response!.body.breakpoints;
        assert.equal(own.length, 1);
        const shownIds = client.events('breakpoint').map((m) => m.body.breakpoint.id);
        assert.deepEqual(shownIds, [own[0].id]);
    });

    it('reads the command at an Execute* stop, reports it and resumes without VS Code seeing the stop', async () => {
        client = new Client({ stops: [sqlStop(1), userStop] }, [EXECUTE_READER]);
        await client.start();
        const stop = await client.waitFor(stopped, 'event stop');
        assert.equal(stop.event, 'stopped');
        assert.deepEqual(client.events('stopped').length, 1);
        assert.equal(client.events('continued').length, 0, 'the relay\'s own continue is not shown');
        const top = (await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 })).body.stackFrames[0];
        assert.equal(top.name, 'Program.Main()', 'the shown stop is the user\'s');

        const sql = client.events(SQL_EVENT);
        assert.equal(sql.length, 1);
        const body = sql[0].body;
        assert.equal(body.method, EXECUTE_READER);
        assert.equal(body.typeName, 'Oracle.ManagedDataAccess.Client.OracleCommand');
        assert.equal(body.commandText, 'SELECT * FROM EMP WHERE ENAME = :name');
        assert.equal(body.bindByName, true);
        assert.deepEqual(body.parameters, [{ name: 'name', kind: 'string', value: 'Smith', direction: 'Input' }]);
        assert.deepEqual(body.frames.map((f: any) => f.name), ['MyDb.Query()', 'Program.Main()'], 'the caller frames, without the provider\'s');
        assert.equal(body.frames[0].line, 31);
    });

    it('reports a statement once when Execute* calls another Execute* overload', async () => {
        const nested = sqlStop(1, [{ id: 2, name: `${EXECUTE_READER}(CommandBehavior)` }]);
        client = new Client({ stops: [nested, sqlStop(20), userStop] }, [EXECUTE_READER]);
        await client.start();
        await client.waitFor(stopped, 'event stop');
        assert.equal(client.events(SQL_EVENT).length, 1);
    });

    it('passes a stop elsewhere on to VS Code unchanged', async () => {
        client = new Client({ stops: [userStop] }, [EXECUTE_READER]);
        await client.start();
        const stop = await client.waitFor(stopped, 'event stop');
        assert.equal(stop.body.reason, 'breakpoint');
        assert.equal(client.events(SQL_EVENT).length, 0);
    });

    describe('event trace', () => {
        const handlerStop: FakeStop = {
            reason: 'breakpoint',
            frames: [{ id: 300, name: 'Program.OnOkClick()', source: { path: 'C:\\app\\Program.cs' }, line: 28 }],
            values: { 'sender.Name': { result: '"okButton"', type: 'string' } },
        };
        const trace = { handlers: [{ breakpointName: 'Program.OnOkClick', label: 'Program.OnOkClick', event: 'Click', control: 'okButton' }] };

        it('sets the traced handlers\' breakpoints, records each firing with its sender and resumes', async () => {
            client = new Client({ stops: [userStop, handlerStop, userStop] }, []);
            await client.start();
            await client.waitFor(stopped, 'event stop');
            const response = await client.request(EVENT_TRACE_REQUEST, trace);
            assert.equal(response.body.count, 1);
            const set = (await client.sentToDebugger()).filter((r) => r.command === 'setFunctionBreakpoints').pop();
            assert.deepEqual(set?.arguments.breakpoints, [{ name: 'Program.OnOkClick' }], 'handlers have symbols: no anyCode');

            const next = client.waitFor((m) => stopped(m) && client!.events('stopped').length === 2, 'the next shown stop');
            await client.request('continue', { threadId: 1 });
            await next;
            const fired = client.events(EVENT_TRACE_EVENT);
            assert.equal(fired.length, 1);
            assert.deepEqual(
                { events: fired[0].body.events, controls: fired[0].body.controls, sender: fired[0].body.sender, handler: fired[0].body.handler, line: fired[0].body.line },
                { events: ['Click'], controls: ['okButton'], sender: 'okButton', handler: 'Program.OnOkClick()', line: 28 },
            );
            assert.equal(client.events('breakpoint').length, 0, 'the trace\'s breakpoint is not shown');
        });

        it('still stops in a traced handler the user also has a breakpoint on', async () => {
            client = new Client({ stops: [userStop, handlerStop] }, []);
            await client.start(async () => client!.request('setFunctionBreakpoints', { breakpoints: [{ name: 'Program.OnOkClick' }] }));
            await client.waitFor(stopped, 'event stop');
            await client.request(EVENT_TRACE_REQUEST, trace);
            const set = (await client.sentToDebugger()).filter((r) => r.command === 'setFunctionBreakpoints').pop();
            assert.deepEqual(set?.arguments.breakpoints, [{ name: 'Program.OnOkClick' }], 'sent once, as the user\'s');

            const next = client.waitFor((m) => stopped(m) && client!.events('stopped').length === 2, 'the handler stop');
            await client.request('continue', { threadId: 1 });
            const stop = await next;
            assert.equal(stop.event, 'stopped');
            assert.equal(client.events(EVENT_TRACE_EVENT).length, 1, 'recorded too');
        });

        it('forgets every traced handler on clear', async () => {
            client = new Client({ stops: [userStop] }, []);
            await client.start();
            await client.waitFor(stopped, 'event stop');
            await client.request(EVENT_TRACE_REQUEST, trace);
            const response = await client.request(EVENT_TRACE_REQUEST, { clear: true });
            assert.equal(response.body.count, 0);
            const set = (await client.sentToDebugger()).filter((r) => r.command === 'setFunctionBreakpoints').pop();
            assert.deepEqual(set?.arguments.breakpoints, []);
        });
    });
});
