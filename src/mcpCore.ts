// MCP (Model Context Protocol) without the vscode module: the engine's endpoint event and the connection settings for
// AI clients outside VS Code. The engine does the work (dotnet-x86dbg --mcp-listen / --mcp-connect); the extension only
// shows VS Code's AI where it listens, and tells other AI clients how to start the bridge.

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

/** AI clients the connection settings are written for. */
export type McpClient = 'claudeCode' | 'copilotCli' | 'json';

export const MCP_CLIENTS: readonly McpClient[] = ['claudeCode', 'copilotCli', 'json'];

/** A path as one command-line argument (quoted: the user folder may contain spaces). */
function quoted(path: string): string {
    return `"${path}"`;
}

/**
 * What to run or write to register the bridge (`<engine> --mcp-connect`) with a client. The bridge is an ordinary stdio
 * MCP server: it connects to the engine debugging in VS Code at each call, so it can be registered once.
 */
export function connectionSettings(client: McpClient, engine: string): string {
    switch (client) {
        case 'claudeCode':
            return `claude mcp add --scope user ${MCP_SERVER_NAME} -- ${quoted(engine)} --mcp-connect`;
        case 'copilotCli':
            return `copilot mcp add ${MCP_SERVER_NAME} -- ${quoted(engine)} --mcp-connect`;
        case 'json':
            return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: engine, args: ['--mcp-connect'] } } }, null, 2);
    }
}
