// E2E: MCP through the relay. The engine is started as the extension starts it with dotnetX86.mcp.enabled (--mcp-listen);
// an AI client (here fetch) uses the endpoint the engine announces, and what it does reaches the IDE side as DAP events.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { MCP_ENDPOINT_EVENT, McpEndpoint, parseEndpoint } from '../../mcpCore';
import { DapSession, IS_NETCOREDBG, appSource, buildApp, e2eSkip, lineOf } from './harness';

const TIMEOUT = 120_000;
const PROGRAM_CS = appSource('Basic', 'Program.cs');

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One JSON-RPC request to the engine's MCP endpoint; resolves with the HTTP status and the parsed body. */
async function post(endpoint: McpEndpoint, message: Record<string, unknown>, token = endpoint.token): Promise<{ status: number; body: any }> {
    const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

let nextId = 1;
/** Calls a tool; resolves with its text (the engine writes values as JSON text). */
async function callTool(endpoint: McpEndpoint, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const { body } = await post(endpoint, { id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    const result = body.result;
    assert.notEqual(result?.isError, true, `${name}: ${result?.content?.[0]?.text}`);
    return result.content[0].text;
}

describe('MCP through the relay', { skip: e2eSkip || (IS_NETCOREDBG && 'netcoredbg has no MCP') }, () => {
    let program = '';
    let session: DapSession | undefined;

    before(() => {
        program = path.join(buildApp('Basic'), 'Basic.exe');
    });
    after(async () => {
        await session?.close();
    });

    it('announces the endpoint, and an AI client drives the session the IDE sees', { timeout: TIMEOUT }, async () => {
        session = new DapSession({}, ['--mcp-listen']);
        const announced = session.waitFor((m) => m.type === 'event' && m.event === MCP_ENDPOINT_EVENT, TIMEOUT, 'the MCP endpoint');
        const firstStop = session.nextStop(TIMEOUT);
        await session.launch(program, { [PROGRAM_CS]: [{ line: lineOf(PROGRAM_CS, 'loop') }] });
        const endpoint = parseEndpoint((await announced).body);
        assert.ok(endpoint, 'the event body is a local endpoint with a token');
        const stop = await firstStop;

        // Without the token the engine refuses.
        assert.equal((await post(endpoint, { id: nextId++, method: 'tools/list' }, 'wrong')).status, 401);

        const init = await post(endpoint, { id: nextId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
        assert.equal(init.body.result.serverInfo.name, 'dotnet-x86dbg');

        // The stop the IDE got is the AI's too.
        assert.match(await callTool(endpoint, 'debug_status'), /"stopped"/);
        assert.match(await callTool(endpoint, 'evaluate', { expression: 'i' }), /"1"|: 1\b/);

        // The AI continues: the IDE gets the next stop (the next pass of the loop).
        const nextStop = session.nextStop(TIMEOUT);
        await callTool(endpoint, 'debug_continue', { waitMs: 0 });
        const second = await nextStop;
        assert.equal(second.body.threadId, stop.body.threadId);
        const frame = await session.topFrame(second.body.threadId);
        assert.equal((await session.evaluate('i', frame.id)).body.result, '2');
    });
});
