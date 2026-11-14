import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { MAKE_OBJECT_ID_REQUEST } from './objectIds';
import { VariablesContextArg } from './variableDump';

/**
 * "Make Object ID" (Variables / Watch context menu), as in Visual Studio: the object gets a name ($1, $2, ...) that
 * reaches it from any frame and any later stop - in Watch, the Debug Console, hovers and breakpoint conditions.
 */
export async function makeObjectIdCommand(arg?: VariablesContextArg): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== DEBUG_TYPE) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Not debugging. Stop at a breakpoint and try again.'));
        return;
    }
    const variable = arg?.variable;
    const label = variable?.evaluateName ?? variable?.name ?? '';
    // netcoredbg hands out a variablesReference only for values with members: objects (and structs).
    if (!variable?.variablesReference) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Object IDs can be made for objects only, not for numbers, strings or null.'));
        return;
    }
    try {
        const r = await session.customRequest(MAKE_OBJECT_ID_REQUEST, { variablesReference: variable.variablesReference });
        const name = `$${r.id}`;
        await vscode.env.clipboard.writeText(name);
        void vscode.window.showInformationMessage(
            vscode.l10n.t('{0} now refers to {1}. Use it in Watch, the Debug Console or breakpoint conditions, also in other methods (copied to the clipboard).', name, label),
        );
    } catch (e) {
        void vscode.window.showErrorMessage(
            vscode.l10n.t('Could not make an object ID for {0} ({1}). Object IDs can be made for objects only, not for structs or null.', label, e instanceof Error ? e.message : String(e)),
        );
    }
}
