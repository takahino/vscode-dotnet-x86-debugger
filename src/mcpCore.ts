// MCP (Model Context Protocol) without the vscode module: the engine's endpoint event and how AI clients register the
// engine's bridge. The engine does the work (dotnet-x86dbg --mcp-listen / --mcp-connect); the extension only shows the
// editor's AI where it listens, and registers the bridge with other AI clients.

import * as path from 'path';

/** Name the server is registered under in the AI clients. */
export const MCP_SERVER_NAME = 'dotnet-x86';

/** The custom DAP event an engine started with `--mcp-listen` sends with its endpoint. */
export const MCP_ENDPOINT_EVENT = 'dotnetX86.mcpEndpoint';

/** Where an engine started with `--mcp-listen` accepts MCP (the `dotnetX86.mcpEndpoint` event). */
export interface McpEndpoint {
    /** `http://127.0.0.1:<port>/mcp`. */
    url: string;
    /** Sent as `Authorization: Bearer <token>`; made anew for every engine. */
    token: string;
    enginePid: number;
}

/** The endpoint in an event body, or undefined when it is not one (only a local HTTP URL is accepted). */
export function parseEndpoint(body: unknown): McpEndpoint | undefined {
    if (typeof body !== 'object' || body === null) {
        return undefined;
    }
    const { url, token, enginePid } = body as Record<string, unknown>;
    if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) {
        return undefined;
    }
    if (typeof token !== 'string' || token === '' || typeof enginePid !== 'number') {
        return undefined;
    }
    return { url, token, enginePid };
}

/** The bridge's arguments: an ordinary stdio MCP server that connects to the latest debug session at each call. */
const BRIDGE_ARGS = ['--mcp-connect'];

/** A path as one command-line argument (quoted: the user folder may contain spaces). */
function quoted(file: string): string {
    return `"${file}"`;
}

/** Folders AI clients keep their settings in. Passed in, so that this module does not read the environment. */
export interface ClientFolders {
    /** `%USERPROFILE%`. */
    home: string;
    /** Claude Desktop's settings: `%APPDATA%\Claude`, or the Store app's own copy of it. */
    claudeDesktop: string;
}

/**
 * How the bridge is registered with a client:
 * - `cli`: the client's own command (`remove` first: `add` refuses a name that is already there; the removal fails
 *   harmlessly when there is none).
 * - `file`: the client's settings file, with the bridge's entry added or replaced and everything else kept.
 */
export type Registration =
    | { kind: 'cli'; program: string; remove: string; add: string }
    | { kind: 'file'; file: string; update: (text: string | undefined) => string };

export type AiClientId = 'claudeCode' | 'copilotCli' | 'geminiCli' | 'codex' | 'claudeDesktop' | 'cursor' | 'windsurf' | 'lmStudio' | 'opencode';

export interface AiClient {
    id: AiClientId;
    label: string;
    registration(engine: string, folders: ClientFolders): Registration;
    /** What the copy command copies: the command line, or the settings with the bridge's entry. */
    settings(engine: string): string;
}

/** A client with its own command: `<program> <add> -- "<engine>" --mcp-connect`. */
function cliClient(id: AiClientId, label: string, program: string, remove: string, add: string): AiClient {
    const addLine = (engine: string) => `${program} ${add} -- ${quoted(engine)} ${BRIDGE_ARGS.join(' ')}`;
    return {
        id,
        label,
        registration: (engine) => ({ kind: 'cli', program, remove: `${program} ${remove}`, add: addLine(engine) }),
        settings: addLine,
    };
}

/** A client configured with a JSON file that keeps stdio servers under `keys` (`{ command, args }` unless `entry`). */
function jsonClient(id: AiClientId, label: string, file: (folders: ClientFolders) => string, keys: string[] = ['mcpServers'], entry = stdioEntry): AiClient {
    return {
        id,
        label,
        registration: (engine, folders) => ({ kind: 'file', file: file(folders), update: (text) => withJsonServer(text, keys, entry(engine)) }),
        settings: (engine) => withJsonServer(undefined, keys, entry(engine)),
    };
}

function stdioEntry(engine: string): unknown {
    return { command: engine, args: [...BRIDGE_ARGS] };
}

const win = path.win32;

/** AI clients the bridge can be registered with, in the order they are offered. */
export const AI_CLIENTS: readonly AiClient[] = [
    // The terminal and the Claude Code extension read the same user settings.
    cliClient('claudeCode', 'Claude Code', 'claude', `mcp remove --scope user ${MCP_SERVER_NAME}`, `mcp add --scope user ${MCP_SERVER_NAME}`),
    cliClient('copilotCli', 'GitHub Copilot CLI', 'copilot', `mcp remove ${MCP_SERVER_NAME}`, `mcp add ${MCP_SERVER_NAME}`),
    jsonClient('geminiCli', 'Gemini CLI', (f) => win.join(f.home, '.gemini', 'settings.json')),
    {
        // The Codex CLI, its IDE extension and the ChatGPT desktop app share this file.
        id: 'codex',
        label: 'Codex',
        registration: (engine, folders) => ({ kind: 'file', file: win.join(folders.home, '.codex', 'config.toml'), update: (text) => withTomlServer(text, engine) }),
        settings: (engine) => tomlServer(engine),
    },
    jsonClient('claudeDesktop', 'Claude Desktop', (f) => win.join(f.claudeDesktop, 'claude_desktop_config.json')),
    jsonClient('cursor', 'Cursor', (f) => win.join(f.home, '.cursor', 'mcp.json')),
    jsonClient('windsurf', 'Windsurf', (f) => win.join(f.home, '.codeium', 'windsurf', 'mcp_config.json')),
    jsonClient('lmStudio', 'LM Studio', (f) => win.join(f.home, '.lmstudio', 'mcp.json')),
    // opencode: `mcp.<name>` with the command and its arguments in one array (newer versions also read `mcp.servers`).
    jsonClient('opencode', 'opencode', (f) => win.join(f.home, '.config', 'opencode', 'opencode.json'), ['mcp'], (engine) => ({ type: 'local', command: [engine, ...BRIDGE_ARGS], enabled: true })),
];

/** The settings for clients not listed: an `mcpServers` JSON (Claude Desktop's format, which most clients follow). */
export function genericSettings(engine: string): string {
    return withJsonServer(undefined, ['mcpServers'], stdioEntry(engine));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON settings with the bridge's entry at `keys` (added or replaced); everything else is kept. Throws when the text is
 * not plain JSON (comments are not kept, so such a file is left alone) or a key on the way is not an object.
 * opencode's newer `mcp.servers` is used when the file already has it.
 */
export function withJsonServer(text: string | undefined, keys: string[], entry: unknown): string {
    const source = (text ?? '').replace(/^﻿/, '');
    const root: unknown = source.trim() === '' ? {} : JSON.parse(source);
    if (!isObject(root)) {
        throw new Error('the settings are not a JSON object');
    }
    let node = root;
    for (const key of keys) {
        node[key] ??= {};
        const next = node[key];
        if (!isObject(next)) {
            throw new Error(`"${key}" is not a JSON object`);
        }
        node = next;
    }
    if (keys.length === 1 && keys[0] === 'mcp' && isObject(node.servers)) {
        node = node.servers;
    }
    node[MCP_SERVER_NAME] = entry;
    return `${JSON.stringify(root, null, 2)}\n`;
}

/** Codex's table for the bridge. A JSON string is also a TOML basic string (the same escapes). */
function tomlServer(engine: string): string {
    return `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(engine)}\nargs = ${JSON.stringify(BRIDGE_ARGS)}\n`;
}

/**
 * Codex's `config.toml` with the bridge's table: an earlier one (and its sub-tables such as `.env`) is removed, the new
 * one is put at the end, and the rest is kept as it was, comments included.
 */
export function withTomlServer(text: string | undefined, engine: string): string {
    const source = (text ?? '').replace(/^﻿/, '');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const ours = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')\\s*[\\].]`);
    const kept: string[] = [];
    let skipping = false;
    for (const line of source.split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) {
            skipping = ours.test(line);
        }
        if (!skipping) {
            kept.push(line);
        }
    }
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
        kept.pop();
    }
    const table = tomlServer(engine).replace(/\n/g, eol);
    return kept.length > 0 ? `${kept.join(eol)}${eol}${eol}${table}` : table;
}

/** A server for Cursor's extension API (`vscode.cursor.mcp.registerServer`). */
export interface CursorServerConfig {
    name: string;
    server: { command: string; args: string[]; env: Record<string, string> };
}

/**
 * The bridge as a stdio server for Cursor. Not the session's HTTP endpoint: Cursor has been reported to drop the headers
 * (the token) of servers registered this way, and the bridge needs no token and finds the latest session by itself.
 */
export function cursorServer(engine: string): CursorServerConfig {
    return { name: MCP_SERVER_NAME, server: { command: engine, args: [...BRIDGE_ARGS], env: {} } };
}
