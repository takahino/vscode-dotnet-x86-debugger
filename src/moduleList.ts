import * as path from 'path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';

interface ModuleInfo {
    id: string;
    name: string;
    path?: string;
    symbolStatus?: string;
    order: number;
}

/** Modules view (like Visual Studio's Modules window): loaded assemblies and whether their symbols were found. */
export class ModuleList implements vscode.TreeDataProvider<ModuleInfo>, vscode.DebugAdapterTrackerFactory, vscode.Disposable {
    private modules = new Map<string, ModuleInfo>();
    private order = 0;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.debug.onDidStartDebugSession((s) => {
                if (s.type === DEBUG_TYPE) {
                    this.modules.clear();
                    this.changeEmitter.fire();
                }
            }),
        );
    }

    createDebugAdapterTracker(): vscode.DebugAdapterTracker {
        return {
            onDidSendMessage: (m: { type?: string; event?: string; body?: { reason?: string; module?: Omit<ModuleInfo, 'order'> } }) => {
                if (m.type !== 'event' || m.event !== 'module' || !m.body?.module) {
                    return;
                }
                const module = m.body.module;
                if (m.body.reason === 'removed') {
                    this.modules.delete(module.id);
                } else {
                    const existing = this.modules.get(module.id);
                    this.modules.set(module.id, { ...module, order: existing?.order ?? ++this.order });
                }
                this.changeEmitter.fire();
            },
        };
    }

    getTreeItem(m: ModuleInfo): vscode.TreeItem {
        const item = new vscode.TreeItem(m.name);
        const loaded = m.symbolStatus === 'Symbols loaded.';
        item.description = loaded ? vscode.l10n.t('symbols loaded') : vscode.l10n.t('no symbols');
        item.tooltip = `${m.path ?? ''}\n${m.symbolStatus ?? ''}`;
        // Icon shape and the description text both say whether symbols are loaded, not color alone.
        item.iconPath = new vscode.ThemeIcon(loaded ? 'symbol-namespace' : 'library');
        item.contextValue = 'dotnetX86.module';
        item.resourceUri = m.path ? vscode.Uri.file(m.path) : undefined;
        return item;
    }

    /** Assemblies with symbols (usually your own code) first, then by load order. */
    getChildren(): ModuleInfo[] {
        return [...this.modules.values()].sort((a, b) => {
            const sa = a.symbolStatus === 'Symbols loaded.' ? 0 : 1;
            const sb = b.symbolStatus === 'Symbols loaded.' ? 0 : 1;
            return sa - sb || a.order - b.order;
        });
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.changeEmitter.dispose();
    }
}

export async function copyModulePath(m?: ModuleInfo): Promise<void> {
    if (m?.path) {
        await vscode.env.clipboard.writeText(m.path);
    }
}

export async function revealModule(m?: ModuleInfo): Promise<void> {
    if (m?.path) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.normalize(m.path)));
    }
}
