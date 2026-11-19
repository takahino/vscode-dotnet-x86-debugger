// MCP without VS Code: reading the engine's endpoint event and the connection settings for AI clients.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { claudeCodeRegistration, connectionSettings, cursorServer, parseEndpoint } from '../../mcpCore';

describe('parseEndpoint', () => {
    it('reads the endpoint the engine announces', () => {
        assert.deepEqual(parseEndpoint({ url: 'http://127.0.0.1:50123/mcp', token: 'abc', enginePid: 42 }), { url: 'http://127.0.0.1:50123/mcp', token: 'abc', enginePid: 42 });
    });

    it('accepts only a local endpoint with a token', () => {
        assert.equal(parseEndpoint({ url: 'http://example.com:80/mcp', token: 'abc', enginePid: 42 }), undefined);
        assert.equal(parseEndpoint({ url: 'http://127.0.0.1:50123/mcp', token: '', enginePid: 42 }), undefined);
        assert.equal(parseEndpoint({ url: 'http://127.0.0.1:50123/mcp', token: 'abc' }), undefined);
        assert.equal(parseEndpoint(undefined), undefined);
    });
});

describe('connectionSettings', () => {
    const engine = 'C:\\Users\\a b\\AppData\\Local\\dotnet-x86dbg\\bin\\dotnet-x86dbg.exe';

    it('registers the bridge with Claude Code for every project', () => {
        assert.equal(connectionSettings('claudeCode', engine), `claude mcp add --scope user dotnet-x86 -- "${engine}" --mcp-connect`);
    });

    it('registers the bridge with GitHub Copilot CLI', () => {
        assert.equal(connectionSettings('copilotCli', engine), `copilot mcp add dotnet-x86 -- "${engine}" --mcp-connect`);
    });

    it('writes an mcpServers JSON for other clients', () => {
        assert.deepEqual(JSON.parse(connectionSettings('json', engine)), { mcpServers: { 'dotnet-x86': { command: engine, args: ['--mcp-connect'] } } });
    });
});

describe('claudeCodeRegistration', () => {
    const engine = 'C:\\Users\\a b\\AppData\\Local\\dotnet-x86dbg\\bin\\dotnet-x86dbg.exe';

    it('removes the earlier entry of the user scope, then adds the bridge there', () => {
        assert.deepEqual(claudeCodeRegistration(engine), {
            remove: 'claude mcp remove --scope user dotnet-x86',
            add: `claude mcp add --scope user dotnet-x86 -- "${engine}" --mcp-connect`,
        });
    });
});

describe('cursorServer', () => {
    it('registers the bridge as a stdio server, which needs no token', () => {
        assert.deepEqual(cursorServer('C:\\x\\dotnet-x86dbg.exe'), { name: 'dotnet-x86', server: { command: 'C:\\x\\dotnet-x86dbg.exe', args: ['--mcp-connect'], env: {} } });
    });
});
