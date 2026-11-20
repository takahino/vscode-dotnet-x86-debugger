import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_SYMBOL_SERVERS, downloadSymbols } from './symbolDownload';

/**
 * "Download Symbols" (Modules view): fetches the PDB of an assembly without symbols from the symbol servers (NuGet,
 * Microsoft, or those in dotnetX86.symbolServers). With its Source Link map, the sources follow when the program stops
 * in it. netcoredbg reads symbols when a module loads, so the result applies from the next debug session.
 */
export class SymbolServer {
    constructor(
        /** <globalStorage>/symbols: one folder per assembly MVID. */
        readonly symbolCache: string,
        /** <globalStorage>/sources: files downloaded through Source Link. */
        readonly sourceCache: string,
        private readonly output: vscode.OutputChannel,
    ) {}

    async download(module?: { name?: string; path?: string }): Promise<void> {
        let assembly = module?.path;
        if (!assembly) {
            const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [vscode.l10n.t('.NET assemblies')]: ['dll', 'exe'] } });
            assembly = picked?.[0]?.fsPath;
            if (!assembly) {
                return;
            }
        }
        const name = path.basename(assembly);
        const servers = vscode.workspace.getConfiguration('dotnetX86').get<string[]>('symbolServers', DEFAULT_SYMBOL_SERVERS);
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading the symbols of {0}…', name) },
            () => downloadSymbols(assembly!, servers, this.symbolCache),
        );
        if (!result.ok) {
            this.output.appendLine(`[symbols] ${name}: ${result.reason}${result.tried.length ? ` (tried ${result.tried.join(', ')})` : ''}`);
            const reasons: Record<typeof result.reason, string> = {
                'not-managed': vscode.l10n.t('{0} is not a .NET assembly.', name),
                'no-pdb-info': vscode.l10n.t('{0} was built without a PDB, so no symbol server has one. The debugger decompiles it to C# when you step into it.', name),
                'windows-pdb': vscode.l10n.t('{0} was built with a Windows PDB, which this debugger cannot read. The debugger decompiles it to C# instead.', name),
                'not-found': vscode.l10n.t('No symbol server has the symbols of {0} (details in the ".NET x86 Debugger" output). The debugger decompiles it to C# when you step into it.', name),
            };
            void vscode.window.showWarningMessage(reasons[result.reason]);
            return;
        }
        this.output.appendLine(`[symbols] ${name}: ${result.server} -> ${result.file}`);
        const restart = vscode.l10n.t('Restart Debugging');
        const running = vscode.debug.activeDebugSession !== undefined;
        const answer = await vscode.window.showInformationMessage(
            running
                ? vscode.l10n.t('The symbols of {0} were downloaded. Restart debugging to step into it (symbols are read when the module loads).', name)
                : vscode.l10n.t('The symbols of {0} were downloaded. The next debug session can step into it.', name),
            ...(running ? [restart] : []),
        );
        if (answer === restart) {
            await vscode.commands.executeCommand('workbench.action.debug.restart');
        }
    }

    async clearCache(): Promise<void> {
        const clear = vscode.l10n.t('Delete');
        const answer = await vscode.window.showWarningMessage(
            vscode.l10n.t('Delete all downloaded symbols and Source Link sources? They are downloaded again when needed.'),
            { modal: true },
            clear,
        );
        if (answer !== clear) {
            return;
        }
        try {
            await fs.promises.rm(this.symbolCache, { recursive: true, force: true });
            await fs.promises.rm(this.sourceCache, { recursive: true, force: true });
            void vscode.window.showInformationMessage(vscode.l10n.t('Downloaded symbols and sources were deleted.'));
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not delete {0}: {1}', this.symbolCache, e instanceof Error ? e.message : String(e)));
        }
    }
}
