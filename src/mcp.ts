import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { CursorServerConfig, MCP_CLIENTS, MCP_ENDPOINT_EVENT, MCP_SERVER_NAME, McpClient, McpEndpoint, claudeCodeRegistration, connectionSettings, cursorServer, parseEndpoint } from './mcpCore';

/** Id of the contributed MCP server definition provider (package.json `mcpServerDefinitionProviders`). */
const PROVIDER_ID = 'dotnetX86.mcp';

/** Whether debug sessions open MCP (`dotnetX86.mcp.enabled`, off by default: AI tools run code in the program). */
export function isMcpEnabled(): boolean {
    return vscode.workspace.getConfiguration('dotnetX86.mcp').get<boolean>('enabled', false);
}

/** Cursor's MCP extension API (`vscode.cursor.mcp`); not in VS Code's typings. */
interface CursorMcpApi {
    registerServer(config: CursorServerConfig): void;
    unregisterServer(name: string): void;
}

/** The API when the extension runs in Cursor. */
function cursorMcpApi(): CursorMcpApi | undefined {
    const api = (vscode as unknown as { cursor?: { mcp?: Partial<CursorMcpApi> } }).cursor?.mcp;
    return typeof api?.registerServer === 'function' && typeof api.unregisterServer === 'function' ? (api as CursorMcpApi) : undefined;
}

/**
 * MCP for AI clients, a thin layer over the engine:
 * - VS Code's AI: the endpoint of the latest debug session is offered as an HTTP MCP server (VS Code 1.101 and later).
 * - Cursor's AI: while the setting is on, the engine's stdio bridge (`--mcp-connect`) is registered through Cursor's API.
 * - Claude Code: a command registers the bridge with the `claude` CLI.
 * - Other AI clients (GitHub Copilot CLI, any `mcpServers` JSON): a command copies the settings that start the bridge.
 * The bridge is a copy of the engine at a fixed path, so registrations survive extension updates (the extension's own
 * folder changes with every version).
 */
export class McpIntegration implements vscode.Disposable {
    private readonly endpoints = new Map<string, McpEndpoint>();
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [this.changed];
    private readonly cursor = cursorMcpApi();
    private cursorRegistered = false;

    constructor(
        private readonly extensionPath: string,
        private readonly output: vscode.OutputChannel,
    ) {
        this.disposables.push(
            vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
                if (e.session.type === DEBUG_TYPE && e.event === MCP_ENDPOINT_EVENT) {
                    this.add(e.session, e.body);
                }
            }),
            vscode.debug.onDidTerminateDebugSession((session) => {
                if (this.endpoints.delete(session.id)) {
                    this.changed.fire();
                }
            }),
        );
        if (fs.existsSync(bridgePath())) {
            this.updateBridge(); // a copy made by an earlier version: bring it to this version's engine
        }
        if (this.cursor) {
            // Cursor: its own API (one registration while the setting is on). The VS Code provider is skipped so that a
            // Cursor that also had it would not list the tools twice.
            this.syncCursor();
            this.disposables.push(
                vscode.workspace.onDidChangeConfiguration((e) => {
                    if (e.affectsConfiguration('dotnetX86.mcp.enabled')) {
                        this.syncCursor();
                    }
                }),
            );
        } else if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
            // VS Code before 1.101 has no MCP API: only the settings for other AI clients are offered there.
            this.disposables.push(
                vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
                    onDidChangeMcpServerDefinitions: this.changed.event,
                    provideMcpServerDefinitions: () => this.definitions(),
                }),
            );
        }
    }

    /** Registers the bridge with Cursor while the setting is on, and removes it when the setting is turned off. */
    private syncCursor(): void {
        if (!this.cursor) {
            return;
        }
        try {
            if (isMcpEnabled()) {
                const bridge = this.updateBridge();
                if (bridge) {
                    this.cursor.registerServer(cursorServer(bridge));
                    this.cursorRegistered = true;
                    this.output.appendLine(`[mcp] registered with Cursor as ${MCP_SERVER_NAME}`);
                }
            } else if (this.cursorRegistered) {
                this.cursor.unregisterServer(MCP_SERVER_NAME);
                this.cursorRegistered = false;
                this.output.appendLine(`[mcp] removed from Cursor`);
            }
        } catch (e) {
            this.output.appendLine(`[mcp] Cursor's MCP API failed: ${(e as Error).message}`);
        }
    }

    private add(session: vscode.DebugSession, body: unknown): void {
        const endpoint = parseEndpoint(body);
        if (!endpoint) {
            this.output.appendLine(`[mcp] ignored an endpoint event that is not a local MCP endpoint`);
            return;
        }
        this.endpoints.set(session.id, endpoint);
        this.output.appendLine(`[mcp] ${session.name}: AI clients can use this session at ${endpoint.url}`);
        this.changed.fire();
    }

    /** The latest session's endpoint: one server with a fixed name, so VS Code's AI keeps its tools across sessions. */
    private definitions(): vscode.McpServerDefinition[] {
        const latest = [...this.endpoints.values()].pop();
        if (!latest) {
            return [];
        }
        return [new vscode.McpHttpServerDefinition('.NET x86 Debugger', vscode.Uri.parse(latest.url), { Authorization: `Bearer ${latest.token}` }, String(latest.enginePid))];
    }

    /** Command: copies the connection settings for the chosen AI client. */
    async copyConnectionSettings(): Promise<void> {
        const labels: Record<McpClient, { label: string; detail: string }> = {
            claudeCode: { label: 'Claude Code', detail: vscode.l10n.t('A command to run in a terminal') },
            copilotCli: { label: 'GitHub Copilot CLI', detail: vscode.l10n.t('A command to run in a terminal') },
            json: { label: vscode.l10n.t('Other (mcpServers JSON)'), detail: vscode.l10n.t('For Cursor, Claude Desktop and other clients configured with an mcpServers JSON') },
        };
        const picked = await vscode.window.showQuickPick(
            MCP_CLIENTS.map((client) => ({ ...labels[client], client })),
            { placeHolder: vscode.l10n.t('Which AI client will debug through MCP?') },
        );
        if (!picked) {
            return;
        }
        const bridge = this.updateBridge();
        if (!bridge) {
            return;
        }
        await vscode.env.clipboard.writeText(connectionSettings(picked.client, bridge));
        await reportWithSetting(vscode.l10n.t('Copied the settings for {0}. The AI client can use a debug session started in VS Code.', picked.label));
    }

    /**
     * Command: registers the bridge with Claude Code (user scope) by running the `claude` CLI. Without the CLI on PATH,
     * the command line is copied instead.
     */
    async registerWithClaudeCode(): Promise<void> {
        const bridge = this.updateBridge();
        if (!bridge) {
            return;
        }
        const commands = claudeCodeRegistration(bridge);
        if (!(await onPath('claude'))) {
            await vscode.env.clipboard.writeText(commands.add);
            vscode.window.showWarningMessage(vscode.l10n.t('The Claude Code CLI (claude) was not found on PATH. The command that registers the server was copied: run it in a terminal where claude works.'));
            return;
        }
        const failure = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Registering the MCP server with Claude Code...') },
            async () => {
                await run(commands.remove); // fails when there is no earlier registration
                const added = await run(commands.add);
                return added.ok ? undefined : added.output;
            },
        );
        if (failure !== undefined) {
            this.output.appendLine(`[mcp] ${commands.add}\n${failure}`);
            vscode.window.showErrorMessage(vscode.l10n.t('Could not register the MCP server with Claude Code: {0}', failure.trim()));
            return;
        }
        this.output.appendLine(`[mcp] registered with Claude Code: ${commands.add}`);
        await reportWithSetting(vscode.l10n.t('Registered {0} with Claude Code for all projects. Claude Code sessions started from now on can use a debug session started in VS Code.', MCP_SERVER_NAME));
    }

    /**
     * Copies the bundled x86 engine to the bridge's fixed path when it is missing or differs, and returns that path.
     * The bridge only relays MCP over HTTP, so one bitness serves both engines. A bridge running in an AI client locks
     * the file: the older copy is kept then (the relay does not change between versions).
     */
    private updateBridge(): string | undefined {
        const source = path.join(this.extensionPath, 'debugger', 'dotnet-x86dbg-x86', 'dotnet-x86dbg.exe');
        const target = bridgePath();
        try {
            if (sameFile(source, target)) {
                return target;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
            this.output.appendLine(`[mcp] bridge for AI clients: ${target}`);
            return target;
        } catch (e) {
            if (fs.existsSync(target)) {
                this.output.appendLine(`[mcp] the bridge was not updated (${(e as Error).message}); the copy in place is used`);
                return target;
            }
            vscode.window.showErrorMessage(vscode.l10n.t('Could not put the MCP bridge at {0}: {1}', target, (e as Error).message));
            return undefined;
        }
    }

    dispose(): void {
        if (this.cursor && this.cursorRegistered) {
            try {
                this.cursor.unregisterServer(MCP_SERVER_NAME);
            } catch {
                // Cursor is shutting down: nothing to undo then.
            }
        }
        this.disposables.forEach((d) => d.dispose());
    }
}

/** Shows a result; when the setting is off, says so and offers to turn it on (nothing reaches the AI until then). */
async function reportWithSetting(message: string): Promise<void> {
    if (isMcpEnabled()) {
        vscode.window.showInformationMessage(message);
        return;
    }
    const enable = vscode.l10n.t('Enable MCP');
    const answer = await vscode.window.showWarningMessage(`${message} ${vscode.l10n.t('MCP is off (dotnetX86.mcp.enabled): turn it on for debug sessions to accept AI clients.')}`, enable);
    if (answer === enable) {
        await vscode.workspace.getConfiguration('dotnetX86.mcp').update('enabled', true, vscode.ConfigurationTarget.Global);
    }
}

/** Whether a command is found on PATH (`where.exe`; the CLI may be an .exe or an npm .cmd shim). */
function onPath(command: string): Promise<boolean> {
    return new Promise((resolve) => execFile('where.exe', [command], { windowsHide: true }, (error) => resolve(!error)));
}

/**
 * Runs a command line through the shell (an npm-installed `claude` is a .cmd shim, which needs one). The lines are built
 * by `claudeCodeRegistration`: fixed words and the quoted bridge path.
 */
function run(commandLine: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) =>
        exec(commandLine, { windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` || (error?.message ?? '') })),
    );
}

/** `%LOCALAPPDATA%\dotnet-x86dbg\bin\dotnet-x86dbg.exe`: next to the engine's endpoint files (`...\dotnet-x86dbg\mcp`). */
function bridgePath(): string {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
    return path.join(localAppData, 'dotnet-x86dbg', 'bin', 'dotnet-x86dbg.exe');
}

/** Whether two files have the same size and contents (the engine is a few MB: comparing bytes is cheap enough). */
function sameFile(a: string, b: string): boolean {
    if (!fs.existsSync(b) || fs.statSync(a).size !== fs.statSync(b).size) {
        return false;
    }
    return fs.readFileSync(a).equals(fs.readFileSync(b));
}
