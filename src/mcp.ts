import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { AI_CLIENTS, AiClient, ClientFolders, CursorServerConfig, MCP_ENDPOINT_EVENT, MCP_SERVER_NAME, McpEndpoint, Registration, cursorServer, genericSettings, parseEndpoint } from './mcpCore';

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
 * - Other AI clients (Claude Code, GitHub Copilot CLI, Codex, Claude Desktop, ...): a command registers the bridge with
 *   the clients picked (their own command, or their settings file); another copies the settings to register by hand.
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

    /** AI clients offered by the commands. In Cursor, Cursor itself is left out: the API registration covers it. */
    private clients(): readonly AiClient[] {
        return AI_CLIENTS.filter((client) => !(this.cursor && client.id === 'cursor'));
    }

    /** Command: copies the connection settings for the chosen AI client. */
    async copyConnectionSettings(): Promise<void> {
        const bridge = this.updateBridge();
        if (!bridge) {
            return;
        }
        const folders = clientFolders();
        const items = this.clients().map((client) => {
            const registration = client.registration(bridge, folders);
            const detail = registration.kind === 'cli' ? vscode.l10n.t('A command to run in a terminal') : vscode.l10n.t('Add to {0}', registration.file);
            return { label: client.label, detail, settings: client.settings(bridge) };
        });
        items.push({ label: vscode.l10n.t('Other (mcpServers JSON)'), detail: vscode.l10n.t('For other clients configured with an mcpServers JSON'), settings: genericSettings(bridge) });
        const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Which AI client will debug through MCP?') });
        if (!picked) {
            return;
        }
        await vscode.env.clipboard.writeText(picked.settings);
        await reportWithSetting(vscode.l10n.t('Copied the settings for {0}. The AI client can use a debug session started in VS Code.', picked.label));
    }

    /**
     * Command: registers the bridge with the AI clients picked, with each client's own command or by adding the entry
     * to its settings file. Nothing is registered without being picked: these are other programs' settings.
     */
    async registerWithClients(): Promise<void> {
        const bridge = this.updateBridge();
        if (!bridge) {
            return;
        }
        const folders = clientFolders();
        const candidates = await Promise.all(
            this.clients().map(async (client) => {
                const registration = client.registration(bridge, folders);
                return { client, registration, found: await isInstalled(registration) };
            }),
        );
        candidates.sort((a, b) => Number(b.found) - Number(a.found)); // the stable sort keeps the list's order otherwise
        const picked = await vscode.window.showQuickPick(
            candidates.map((candidate) => ({
                label: candidate.client.label,
                description: candidate.found ? vscode.l10n.t('found') : vscode.l10n.t('not found'),
                detail: candidate.registration.kind === 'cli' ? candidate.registration.add : candidate.registration.file,
                candidate,
            })),
            { canPickMany: true, placeHolder: vscode.l10n.t('Register the MCP server with which AI clients?') },
        );
        if (!picked || picked.length === 0) {
            return;
        }
        const results = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Registering the MCP server...') },
            async () => {
                const done: { label: string; failure?: string; settings: string }[] = [];
                for (const { candidate } of picked) {
                    done.push({ label: candidate.client.label, failure: await register(candidate.registration), settings: candidate.client.settings(bridge) });
                }
                return done;
            },
        );
        const registered = results.filter((r) => r.failure === undefined).map((r) => r.label);
        for (const result of results) {
            this.output.appendLine(`[mcp] ${result.label}: ${result.failure ?? 'registered'}`);
        }
        for (const failed of results.filter((r) => r.failure !== undefined)) {
            const copy = vscode.l10n.t('Copy the Settings');
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not register the MCP server with {0}: {1}', failed.label, failed.failure ?? ''), copy).then((answer) => {
                if (answer === copy) {
                    void vscode.env.clipboard.writeText(failed.settings);
                }
            });
        }
        if (registered.length > 0) {
            await reportWithSetting(vscode.l10n.t('Registered {0} with {1}. Restart the client or start a new session there to see the tools.', MCP_SERVER_NAME, registered.join(', ')));
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

/**
 * The folders the clients' settings are in. Claude Desktop installed from the Microsoft Store reads its own copy of
 * `%APPDATA%\Claude` (in its package's LocalCache), so a change to `%APPDATA%\Claude` would not reach it.
 */
function clientFolders(): ClientFolders {
    const home = process.env.USERPROFILE ?? os.homedir();
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    let claudeDesktop = path.join(appData, 'Claude');
    try {
        const packages = path.join(localAppData, 'Packages');
        const storeApp = fs.readdirSync(packages).find((name) => /^Claude_[a-z0-9]+$/i.test(name));
        const storeCopy = storeApp && path.join(packages, storeApp, 'LocalCache', 'Roaming', 'Claude');
        if (storeCopy && fs.existsSync(storeCopy)) {
            claudeDesktop = storeCopy;
        }
    } catch {
        // no Packages folder: not the Store app
    }
    return { home, claudeDesktop };
}

/** Whether a client looks installed: its command is on PATH, or its settings folder exists. */
async function isInstalled(registration: Registration): Promise<boolean> {
    return registration.kind === 'cli' ? onPath(registration.program) : fs.existsSync(path.dirname(registration.file));
}

/** Registers the bridge; the reason when it could not. */
async function register(registration: Registration): Promise<string | undefined> {
    if (registration.kind === 'cli') {
        if (!(await onPath(registration.program))) {
            return vscode.l10n.t('{0} was not found on PATH.', registration.program);
        }
        await run(registration.remove); // fails when there is no earlier registration
        const added = await run(registration.add);
        return added.ok ? undefined : added.output.trim();
    }
    const file = registration.file;
    try {
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
        let updated: string;
        try {
            updated = registration.update(text);
        } catch (e) {
            return vscode.l10n.t('{0} was left as it was: it could not be read ({1}).', file, (e as Error).message);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (text !== undefined) {
            fs.writeFileSync(`${file}.dotnet-x86.bak`, text, 'utf8'); // the settings before this change, to undo it by hand
        }
        // Written beside and renamed over: the client never reads a half-written file.
        const temporary = `${file}.dotnet-x86.tmp`;
        fs.writeFileSync(temporary, updated, 'utf8');
        fs.renameSync(temporary, file);
        return undefined;
    } catch (e) {
        return (e as Error).message;
    }
}

/** Whether a command is found on PATH (`where.exe`; the CLI may be an .exe or an npm .cmd shim). */
function onPath(command: string): Promise<boolean> {
    return new Promise((resolve) => execFile('where.exe', [command], { windowsHide: true }, (error) => resolve(!error)));
}

/**
 * Runs a command line through the shell (an npm-installed `claude` is a .cmd shim, which needs one). The lines are built
 * from `AI_CLIENTS`: fixed words and the quoted bridge path.
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
