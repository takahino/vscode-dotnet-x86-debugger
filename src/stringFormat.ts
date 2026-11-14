// Detects and pretty-prints the content of a string value (JSON / XML / HTML / plain text).
// Kept free of the vscode module so it can be tested outside VS Code.

export type StringFormat = 'json' | 'xml' | 'html' | 'text';

export function detectFormat(value: string): StringFormat {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && tryParseJson(trimmed) !== undefined) {
        return 'json';
    }
    if (trimmed.startsWith('<')) {
        return /^<!doctype html|^<html[\s>]/i.test(trimmed) ? 'html' : 'xml';
    }
    return 'text';
}

/** Returns the formatted text; content that does not parse as the requested format is returned unchanged. */
export function formatString(value: string, format: StringFormat): string {
    switch (format) {
        case 'json': {
            const parsed = tryParseJson(value.trim());
            return parsed === undefined ? value : JSON.stringify(parsed, null, 2);
        }
        case 'xml':
            return formatXml(value);
        default:
            // HTML is formatted by VS Code's built-in formatter; text is shown as-is.
            return value;
    }
}

function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Minimal XML pretty-printer: one element per line, indented by nesting depth.
 * An element that only contains text stays on one line (`<a>text</a>`).
 */
export function formatXml(xml: string): string {
    const tokens = xml
        .replace(/>\s+</g, '><')
        .split(/(<[^>]+>)/)
        .filter((t) => t.trim() !== '');
    const lines: string[] = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const isClosing = token.startsWith('</');
        const isOpening = token.startsWith('<') && !isClosing && !token.endsWith('/>') && !token.startsWith('<?') && !token.startsWith('<!');

        if (isOpening && i + 2 < tokens.length && !tokens[i + 1].startsWith('<') && tokens[i + 2].startsWith('</')) {
            lines.push('  '.repeat(depth) + token + tokens[i + 1].trim() + tokens[i + 2]);
            i += 2;
            continue;
        }
        if (isClosing) {
            depth = Math.max(0, depth - 1);
        }
        lines.push('  '.repeat(depth) + token.trim());
        if (isOpening) {
            depth++;
        }
    }
    return lines.join('\n');
}
