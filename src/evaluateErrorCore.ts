// Helpers for benign DAP evaluate failures (no vscode import).

/**
 * Engine errors that are expected when inline values or the Variables view probe a name
 * (type only, not in scope yet, …). Not worth a toast outside the Debug Console.
 */
export function isBenignEvaluateError(message: string | undefined): boolean {
    if (!message) {
        return false;
    }
    if (
        (/は型の名前です/.test(message) && /メンバーを指定/.test(message)) ||
        (/is a type name/i.test(message) && /specify a member/i.test(message))
    ) {
        return true;
    }
    return (
        /という名前の変数、メンバー、型が見つかりません/.test(message) ||
        (/no variable|member|type/i.test(message) && /found|exist/i.test(message)) ||
        /does not exist in the current context/i.test(message)
    );
}

/** Back-compat alias. */
export const isTypeNameOnlyEvaluateError = isBenignEvaluateError;

/** Do not pop up toasts for these DAP evaluate contexts (inline values, Variables view, …). */
export function shouldQuietAutomaticEvaluateError(context: string | undefined): boolean {
    return context !== 'repl' && context !== 'clipboard' && context !== 'commands';
}

/** @deprecated Use shouldQuietAutomaticEvaluateError */
export const shouldQuietTypeNameEvaluateError = shouldQuietAutomaticEvaluateError;