// MCP without VS Code: reading the engine's endpoint event and registering the bridge with AI clients.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { AI_CLIENTS, AiClientId, ClientFolders, Registration, cursorServer, genericSettings, parseEndpoint, withJsonServer, withTomlServer } from '../../mcpCore';

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

const engine = 'C:\\Users\\a b\\AppData\\Local\\dotnet-x86dbg\\bin\\dotnet-x86dbg.exe';
const folders: ClientFolders = { home: 'C:\\Users\\a b', claudeDesktop: 'C:\\Users\\a b\\AppData\\Roaming\\Claude' };

function registration(id: AiClientId): Registration {
    const client = AI_CLIENTS.find((c) => c.id === id);
    assert.ok(client, id);
    return client.registration(engine, folders);
}

function file(id: AiClientId): Extract<Registration, { kind: 'file' }> {
    const r = registration(id);
    assert.equal(r.kind, 'file');
    return r as Extract<Registration, { kind: 'file' }>;
}

describe('AI_CLIENTS', () => {
    it('registers with Claude Code for every project, removing an earlier entry first', () => {
        assert.deepEqual(registration('claudeCode'), {
            kind: 'cli',
            program: 'claude',
            remove: 'claude mcp remove --scope user dotnet-x86',
            add: `claude mcp add --scope user dotnet-x86 -- "${engine}" --mcp-connect`,
        });
    });

    it('registers with GitHub Copilot CLI', () => {
        assert.deepEqual(registration('copilotCli'), { kind: 'cli', program: 'copilot', remove: 'copilot mcp remove dotnet-x86', add: `copilot mcp add dotnet-x86 -- "${engine}" --mcp-connect` });
    });

    it('knows where each client keeps its settings', () => {
        const files = Object.fromEntries((['geminiCli', 'codex', 'claudeDesktop', 'cursor', 'windsurf', 'lmStudio', 'opencode'] as const).map((id) => [id, file(id).file]));
        assert.deepEqual(files, {
            geminiCli: 'C:\\Users\\a b\\.gemini\\settings.json',
            codex: 'C:\\Users\\a b\\.codex\\config.toml',
            claudeDesktop: 'C:\\Users\\a b\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
            cursor: 'C:\\Users\\a b\\.cursor\\mcp.json',
            windsurf: 'C:\\Users\\a b\\.codeium\\windsurf\\mcp_config.json',
            lmStudio: 'C:\\Users\\a b\\.lmstudio\\mcp.json',
            opencode: 'C:\\Users\\a b\\.config\\opencode\\opencode.json',
        });
    });

    it('adds the bridge to an mcpServers file and keeps the rest', () => {
        const updated = file('claudeDesktop').update('{"preferences":{"x":1},"mcpServers":{"other":{"command":"o"}}}');
        assert.deepEqual(JSON.parse(updated), { preferences: { x: 1 }, mcpServers: { other: { command: 'o' }, 'dotnet-x86': { command: engine, args: ['--mcp-connect'] } } });
    });

    it('writes opencode\'s local server with the command and arguments in one array', () => {
        assert.deepEqual(JSON.parse(file('opencode').update(undefined)), { mcp: { 'dotnet-x86': { type: 'local', command: [engine, '--mcp-connect'], enabled: true } } });
    });

    it('copies the same settings it would register', () => {
        const settings = Object.fromEntries(AI_CLIENTS.map((c) => [c.id, c.settings(engine)]));
        assert.equal(settings.claudeCode, `claude mcp add --scope user dotnet-x86 -- "${engine}" --mcp-connect`);
        assert.deepEqual(JSON.parse(settings.windsurf), { mcpServers: { 'dotnet-x86': { command: engine, args: ['--mcp-connect'] } } });
        assert.equal(settings.codex, `[mcp_servers.dotnet-x86]\ncommand = "C:\\\\Users\\\\a b\\\\AppData\\\\Local\\\\dotnet-x86dbg\\\\bin\\\\dotnet-x86dbg.exe"\nargs = ["--mcp-connect"]\n`);
        assert.deepEqual(JSON.parse(genericSettings(engine)), { mcpServers: { 'dotnet-x86': { command: engine, args: ['--mcp-connect'] } } });
    });
});

describe('withJsonServer', () => {
    it('creates the settings when there are none', () => {
        assert.deepEqual(JSON.parse(withJsonServer(undefined, ['mcpServers'], { command: 'e' })), { mcpServers: { 'dotnet-x86': { command: 'e' } } });
        assert.deepEqual(JSON.parse(withJsonServer('  \n', ['mcpServers'], { command: 'e' })), { mcpServers: { 'dotnet-x86': { command: 'e' } } });
    });

    it('replaces an earlier entry and reads a file with a BOM', () => {
        assert.deepEqual(JSON.parse(withJsonServer('\uFEFF{"mcpServers":{"dotnet-x86":{"command":"old"}}}', ['mcpServers'], { command: 'new' })), { mcpServers: { 'dotnet-x86': { command: 'new' } } });
    });

    it('leaves a file it cannot keep as it was', () => {
        assert.throws(() => withJsonServer('{ // comment\n}', ['mcpServers'], {}));
        assert.throws(() => withJsonServer('[]', ['mcpServers'], {}), /not a JSON object/);
        assert.throws(() => withJsonServer('{"mcpServers":[]}', ['mcpServers'], {}), /"mcpServers" is not a JSON object/);
    });

    it('uses opencode\'s newer mcp.servers when the file has it', () => {
        assert.deepEqual(JSON.parse(withJsonServer('{"mcp":{"servers":{}}}', ['mcp'], { type: 'local' })), { mcp: { servers: { 'dotnet-x86': { type: 'local' } } } });
    });
});

describe('withTomlServer', () => {
    it('creates the table when there is no file', () => {
        assert.equal(withTomlServer(undefined, 'C:\\e.exe'), '[mcp_servers.dotnet-x86]\ncommand = "C:\\\\e.exe"\nargs = ["--mcp-connect"]\n');
    });

    it('replaces an earlier table with its sub-tables and keeps the rest, comments included', () => {
        const before = [
            'model = "x" # comment',
            '',
            '[mcp_servers.dotnet-x86]',
            'command = "old"',
            '',
            '[mcp_servers.dotnet-x86.env]',
            'A = "1"',
            '',
            '[mcp_servers.other]',
            'command = "o"',
            '',
        ].join('\r\n');
        assert.equal(
            withTomlServer(before, 'C:\\e.exe'),
            ['model = "x" # comment', '', '[mcp_servers.other]', 'command = "o"', '', '[mcp_servers.dotnet-x86]', 'command = "C:\\\\e.exe"', 'args = ["--mcp-connect"]', ''].join('\r\n'),
        );
    });

    it('recognizes a quoted table name', () => {
        assert.equal(withTomlServer('[mcp_servers."dotnet-x86"]\ncommand = "old"\n', 'e'), '[mcp_servers.dotnet-x86]\ncommand = "e"\nargs = ["--mcp-connect"]\n');
    });
});

describe('cursorServer', () => {
    it('registers the bridge as a stdio server, which needs no token', () => {
        assert.deepEqual(cursorServer('C:\\x\\dotnet-x86dbg.exe'), { name: 'dotnet-x86', server: { command: 'C:\\x\\dotnet-x86dbg.exe', args: ['--mcp-connect'], env: {} } });
    });
});
