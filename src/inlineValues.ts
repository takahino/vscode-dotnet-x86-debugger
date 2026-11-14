import * as vscode from 'vscode';
import { DEBUG_TYPE } from './configProvider';
import { findInlineTargets } from './inlineValuesCore';

/**
 * Shows variable values at the end of lines while stopped (like Visual Studio's inline values).
 * Locals are looked up by name in the frame's variables; fields (`_x`, `this._x`) are evaluated.
 */
export class CSharpInlineValuesProvider implements vscode.InlineValuesProvider {
    provideInlineValues(
        document: vscode.TextDocument,
        viewPort: vscode.Range,
        context: vscode.InlineValueContext,
    ): vscode.InlineValue[] | undefined {
        // Leave other debuggers' sessions (e.g. the C# extension) alone.
        if (vscode.debug.activeDebugSession?.type !== DEBUG_TYPE) {
            return undefined;
        }
        const stoppedLine = context.stoppedLocation.end.line;
        const lines: string[] = [];
        for (let i = 0; i <= stoppedLine && i < document.lineCount; i++) {
            lines.push(document.lineAt(i).text);
        }
        return findInlineTargets(lines, stoppedLine)
            .filter((t) => t.line >= viewPort.start.line && t.line <= viewPort.end.line)
            .map((t) => {
                const range = new vscode.Range(t.line, t.start, t.line, t.end);
                return t.kind === 'lookup'
                    ? new vscode.InlineValueVariableLookup(range, t.text, true)
                    : new vscode.InlineValueEvaluatableExpression(range, t.text);
            });
    }
}
