// Helpers for benign DAP evaluate failures (no vscode import).

/** Engine message when the expression names a type, not a value (e.g. System.Decimal). */
export function isTypeNameOnlyEvaluateError(message: string | undefined): boolean {
    if (!message) {
        return false;
    }
    return (
        (/は型の名前です/.test(message) && /メンバーを指定/.test(message)) ||
        (/is a type name/i.test(message) && /specify a member/i.test(message))
    );
}

/** Do not pop up toasts for these DAP evaluate contexts (inline values, Variables view, …). */
export function shouldQuietTypeNameEvaluateError(context: string | undefined): boolean {
    return context !== 'repl' && context !== 'clipboard' && context !== 'commands';
}