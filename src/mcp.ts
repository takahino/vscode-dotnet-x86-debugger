import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { MCP_CLIENTS, MCP_ENDPOINT_EVENT, McpClient, McpEndpoint, connectionSettings, parseEndpoint } from './mcpCore';

/** Id of the contributed MCP server definition provider (package.json `mcpServerDefinitionProviders`). */
const PROVIDER_ID = 'dotnetX86.mcp';

/** Whether debug sessions open MCP (`dotnetX86.mcp.enabled`, off by default: AI tools run code in the program). */
export function isMcpEnabled(): boolean {
    return vscode.workspace.getConfiguration('dotnetX86.mcp').get<boolean>('enabled', false);
}

/**
 * MCP for AI clients, a thin layer over the engine:
 * - VS Code's AI: the endpoint of the latest debug session is offered as an HTTP MCP server (VS Code 1.101 and later).
 * - Other AI clients (Claude Code, GitHub Copilot CLI, any `mcpServers` JSON): a command copies the settings that start
 *   the engine's stdio bridge (`--mcp-connect`). The bridge is a copy of the engine at a fixed path, so the registration
 *   survives extension updates (the extension's own folder changes with every version).
 */
export class McpIntegration implements vscode.Disposable {
    private readonly endpoints = new Map<string, McpEndpoint>();
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[] = [this.changed];

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
        // VS Code before 1.101 has no MCP API: only the settings for other AI clients are offered there.
        if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
            this.disposables.push(
                vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
                    onDidChangeMcpServerDefinitions: this.changed.event,
                    provideMcpServerDefinitions: () => this.definitions(),
                }),
            );
        }
        if (fs.existsSync(bridgePath())) {
            this.updateBridge(); // a copy made by an earlier version: bring it to this version's engine
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
        const enable = vscode.l10n.t('Enable MCP');
        const message = vscode.l10n.t('Copied the settings for {0}. The AI client can use a debug session started in VS Code.', picked.label);
        if (isMcpEnabled()) {
            vscode.window.showInformationMessage(message);
            return;
        }
        const answer = await vscode.window.showWarningMessage(`${message} ${vscode.l10n.t('MCP is off (dotnetX86.mcp.enabled): turn it on for debug sessions to accept AI clients.')}`, enable);
        if (answer === enable) {
            await vscode.workspace.getConfiguration('dotnetX86.mcp').update('enabled', true, vscode.ConfigurationTarget.Global);
        }
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
        this.disposables.forEach((d) => d.dispose());
    }
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
