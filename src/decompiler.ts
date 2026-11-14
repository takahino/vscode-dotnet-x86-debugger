import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findX86DotnetHost } from './configProvider';
import { decompileAssembly } from './decompilerCore';

/** The helper's folder relative to the extension (published there by scripts/build-decompiler.ps1). */
const HELPER = path.join('debugger', 'decompiler', 'DotnetX86.Decompiler.dll');

/**
 * "Decompile for Debugging": generates symbols with decompiled C# for an assembly that has none, so the debugger can
 * step through it and stop at breakpoints in it. netcoredbg reads symbols when a module loads, so the result applies
 * from the next debug session (or to an assembly that is not loaded yet).
 */
export class Decompiler {
    constructor(
        private readonly extensionPath: string,
        /** <globalStorage>/decompiled: one folder per assembly MVID. */
        readonly cacheRoot: string,
        private readonly output: vscode.OutputChannel,
    ) {}

    /** From the Modules view (a module item) or the Command Palette (asks for the file). */
    async decompile(module?: { name?: string; path?: string }): Promise<void> {
        let assembly = module?.path;
        if (!assembly) {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { [vscode.l10n.t('.NET assemblies')]: ['dll', 'exe'] },
                openLabel: vscode.l10n.t('Decompile'),
            });
            assembly = picked?.[0]?.fsPath;
            if (!assembly) {
                return;
            }
        }
        const helper = path.join(this.extensionPath, HELPER);
        if (!fs.existsSync(helper)) {
            void vscode.window.showErrorMessage(vscode.l10n.t('The bundled decompiler was not found: {0}. Build it with scripts\\build-decompiler.ps1 and rebuild the VSIX.', helper));
            return;
        }
        const name = path.basename(assembly);
        try {
            const manifest = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Decompiling {0}…', name) },
                () => this.run(helper, assembly!),
            );
            this.output.appendLine(`[decompiler] ${name} -> ${path.dirname(manifest)}`);
            const restart = vscode.l10n.t('Restart Debugging');
            const running = vscode.debug.activeDebugSession !== undefined;
            const answer = await vscode.window.showInformationMessage(
                running
                    ? vscode.l10n.t('{0} was decompiled. Restart debugging to step into it (symbols are read when the module loads).', name)
                    : vscode.l10n.t('{0} was decompiled. The next debug session can step into it.', name),
                ...(running ? [restart] : []),
            );
            if (answer === restart) {
                await vscode.commands.executeCommand('workbench.action.debug.restart');
            }
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not decompile {0}: {1}', name, e instanceof Error ? e.message : String(e)));
        }
    }

    async clearCache(): Promise<void> {
        const clear = vscode.l10n.t('Delete');
        const answer = await vscode.window.showWarningMessage(
            vscode.l10n.t('Delete all decompiled symbols and sources? Debugging then works as before for those assemblies.'),
            { modal: true },
            clear,
        );
        if (answer !== clear) {
            return;
        }
        try {
            await fs.promises.rm(this.cacheRoot, { recursive: true, force: true });
            void vscode.window.showInformationMessage(vscode.l10n.t('Decompiled symbols were deleted. This applies from the next debug session.'));
        } catch (e) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not delete {0}: {1}', this.cacheRoot, e instanceof Error ? e.message : String(e)));
        }
    }

    /** `dotnet` on PATH runs the helper (any .NET 8+ runtime); without one, the x86 runtime the debugger needs anyway. */
    private async run(helper: string, assembly: string): Promise<string> {
        try {
            return await decompileAssembly('dotnet', helper, assembly, this.cacheRoot);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw e;
            }
            return decompileAssembly(findX86DotnetHost(), helper, assembly, this.cacheRoot);
        }
    }
}
