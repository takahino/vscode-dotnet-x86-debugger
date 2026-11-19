import * as vscode from 'vscode';

/**
 * Features that can be turned off with `dotnetX86.<feature>.enabled` (all on by default). Menus, views and the
 * Command Palette hide a turned-off feature through `config.dotnetX86.<feature>.enabled` in their `when` clauses;
 * the code checks it where a feature works in the background (sampling, evaluating on every stop).
 */
export type Feature =
    | 'memoryGraph'
    | 'inlineValues'
    | 'autos'
    | 'modules'
    | 'exceptionSettings'
    | 'winforms'
    | 'heapSnapshot'
    | 'parallelStacks'
    | 'valueTrend'
    | 'pinnedValues'
    | 'breakpointCommands'
    | 'variableTools'
    | 'generateTest'
    | 'sessionReport'
    | 'stepHistory'
    | 'exceptionLog'
    | 'sqlLog'
    | 'eventTrace'
    | 'evidence'
    | 'editAndContinue';

export function isEnabled(feature: Feature, scope?: vscode.Uri): boolean {
    return vscode.workspace.getConfiguration(`dotnetX86.${feature}`, scope).get<boolean>('enabled', true);
}

/** Fires `listener` when the setting of `feature` changes. */
export function onDidChangeFeature(feature: Feature, listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`dotnetX86.${feature}.enabled`)) {
            listener();
        }
    });
}
