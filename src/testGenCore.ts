// Builds a unit test that calls the stopped method again with the values it has now: the method is found in the
// source from netcoredbg's frame name, and the caller supplies the values as C# expressions.
// Kept free of the vscode module.

import { toCSharp } from './csharpInitializer';
import { DapRequest, DumpOptions, collectTree } from './dumpCore';

export type TestFramework = 'xunit' | 'nunit' | 'mstest';

export interface FrameMethod {
    /** "MyApp.Orders" -> namespace "MyApp", class "Orders" (empty namespace for top-level classes). */
    namespace: string;
    className: string;
    method: string;
}

export interface Parameter {
    name: string;
    type: string;
    modifier?: 'ref' | 'out' | 'in' | 'params' | 'this';
}

export interface MethodSignature {
    name: string;
    returnType: string;
    isStatic: boolean;
    parameters: Parameter[];
}

export interface TestInput {
    framework: TestFramework;
    frame: FrameMethod;
    signature: MethodSignature;
    /** C# expression of each argument's current value, by parameter name ("out" ones are not needed). */
    values: Map<string, string>;
    /** C# expression of `this` (instance methods). */
    instance?: string;
    /** "Orders.cs:42", for the comment saying where the values come from. */
    location: string;
}

const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'async', 'virtual', 'override', 'sealed', 'new', 'extern', 'unsafe', 'partial', 'readonly', 'abstract']);
const PARAMETER_MODIFIERS = new Set(['ref', 'out', 'in', 'params', 'this', 'scoped']);
/** How far below a method name the signature may still continue (long parameter lists). */
const MAX_SIGNATURE_LINES = 30;

/**
 * Splits netcoredbg's frame name ("MyApp.Orders.Save()"). The body of an async method or iterator runs in a state
 * machine ("MyApp.Orders.<SaveAsync>d__3.MoveNext()"): that is the method SaveAsync. Lambdas, local functions
 * ("<Main>b__0") and constructors have no method a test can call: undefined.
 */
export function parseFrameName(frameName: string): FrameMethod | undefined {
    const name = frameName
        .replace(/\(.*$/, '')
        .trim()
        .replace(/\.<([A-Za-z_]\w*)>d__\d+\.MoveNext$/, '.$1');
    if (!name || name.includes('<') || /\.\.?c?ctor$/.test(name)) {
        return undefined;
    }
    const parts = name.split('.');
    if (parts.length < 2) {
        return undefined;
    }
    return { namespace: parts.slice(0, -2).join('.'), className: parts[parts.length - 2], method: parts[parts.length - 1] };
}

/**
 * The declaration of `method` that encloses `line` (1-based): the nearest line above it that declares a method of that
 * name (a type before the name, and `{`, `=>` or `where` after the parameter list). Undefined when none is found.
 */
export function findMethodSignature(lines: string[], line: number, method: string): MethodSignature | undefined {
    const declaration = new RegExp(`(^|[\\s>\\]])${escapeRegExp(method)}\\s*(<[^()]*>)?\\s*\\(`);
    for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
        const match = declaration.exec(lines[i]);
        if (!match) {
            continue;
        }
        // Only what follows the last brace / semicolon belongs to this declaration ("class C { int M(").
        const before = (lines[i].slice(0, match.index + match[1].length).split(/[{};]/).pop() ?? '').trim();
        const words = before.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
        const typeWords = words.filter((w) => !MODIFIERS.has(w));
        if (typeWords.length === 0 || /[=(;]|\breturn\b/.test(before)) {
            continue; // a call ("Save(x);", "return Save(x)") or an expression, not a declaration
        }
        const text = lines.slice(i, i + MAX_SIGNATURE_LINES).join('\n');
        const open = text.indexOf('(', text.indexOf(method, match.index) + method.length);
        const close = matchingParen(text, open);
        if (close < 0) {
            continue;
        }
        const after = text.slice(close + 1).trimStart();
        if (!/^(\{|=>|where\b)/.test(after)) {
            continue;
        }
        return {
            name: method,
            returnType: typeWords.join(' '),
            isStatic: words.includes('static'),
            parameters: splitTopLevel(text.slice(open + 1, close)).map(parseParameter).filter((p): p is Parameter => p !== undefined),
        };
    }
    return undefined;
}

/** Test frameworks referenced by the given project files (PackageReference / Reference). */
export function detectFrameworks(projectFiles: string[]): TestFramework[] {
    const found = new Set<TestFramework>();
    for (const text of projectFiles) {
        if (/Include\s*=\s*"xunit(\.v3)?(\.core)?"/i.test(text)) {
            found.add('xunit');
        }
        if (/Include\s*=\s*"NUnit"/i.test(text)) {
            found.add('nunit');
        }
        if (/Include\s*=\s*"MSTest(\.TestFramework)?"/i.test(text) || /Microsoft\.VisualStudio\.QualityTools\.UnitTestFramework/i.test(text)) {
            found.add('mstest');
        }
    }
    return [...found];
}

export interface CapturedValues {
    values: Map<string, string>;
    instance?: string;
    /** Values that could not be read or were cut short by the dump limits ("order: ..."). */
    problems: string[];
}

type Evaluate = (expression: string) => PromiseLike<{ result: string; type?: string; variablesReference: number }>;

/** Reads the arguments (and `this`) in the stopped frame and renders them as C# expressions for the test. */
export async function captureValues(signature: MethodSignature, evaluate: Evaluate, request: DapRequest, options: DumpOptions): Promise<CapturedValues> {
    const captured: CapturedValues = { values: new Map(), problems: [] };
    const read = async (expression: string): Promise<string | undefined> => {
        try {
            const r = await evaluate(expression);
            const result = await collectTree(request, { name: expression, value: r.result, type: r.type, variablesReference: r.variablesReference }, options);
            if (result.truncated) {
                captured.problems.push(`${expression}: not expanded completely (dump limits)`);
            }
            return toCSharp(result.node, '        ');
        } catch (e) {
            captured.problems.push(`${expression}: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    };
    for (const p of signature.parameters) {
        if (p.modifier === 'out') {
            continue;
        }
        const value = await read(p.name);
        if (value !== undefined) {
            captured.values.set(p.name, value);
        }
    }
    if (!signature.isStatic) {
        captured.instance = await read('this');
    }
    return captured;
}

export function generateTest(input: TestInput): string {
    const { framework, frame, signature } = input;
    const body = '        ';
    const task = /^(System\.Threading\.Tasks\.)?(Task|ValueTask)(<(.+)>)?$/.exec(signature.returnType);
    const isAsync = task !== null;
    const resultType = task ? task[4] : signature.returnType === 'void' ? undefined : signature.returnType;

    const arrange: string[] = [];
    if (!signature.isStatic && signature.parameters[0]?.modifier !== 'this') {
        arrange.push(`${body}var sut = ${input.instance ?? `new ${frame.className}() /* TODO: create the object under test */`};`);
    }
    for (const p of signature.parameters) {
        if (p.modifier === 'out') {
            arrange.push(`${body}${p.type} ${p.name};`);
        } else {
            arrange.push(`${body}var ${p.name} = ${input.values.get(p.name) ?? `default(${p.type}) /* TODO: value not available */`};`);
        }
    }
    const args = signature.parameters
        .filter((p) => p.modifier !== 'this')
        .map((p) => (p.modifier === 'ref' || p.modifier === 'out' || p.modifier === 'in' ? `${p.modifier} ${p.name}` : p.name));
    const extensionTarget = signature.parameters[0]?.modifier === 'this' ? signature.parameters[0].name : undefined;
    const receiver = extensionTarget ?? (signature.isStatic ? frame.className : 'sut');
    const call = `${isAsync ? 'await ' : ''}${receiver}.${signature.name}(${args.join(', ')})`;

    const act = resultType ? `${body}var result = ${call};` : `${body}${call};`;
    const assert = resultType
        ? [`${body}var expected = default(${resultType}); // TODO: the value the method should return`, `${body}${assertEqual(framework)}`]
        : [`${body}// TODO: assert on what the method changed`];

    const usings = [frameworkNamespace(framework), isAsync ? 'System.Threading.Tasks' : '', frame.namespace].filter(Boolean).map((u) => `using ${u};`);
    const testMethod = `${signature.name}_ReplaysDebugSession`;
    const [classAttribute, methodAttribute] = attributes(framework);
    return [
        ...usings,
        '',
        `namespace ${frame.namespace ? `${frame.namespace}.Tests` : 'Tests'};`,
        '',
        `// Generated by .NET x86 Debugger from the values at ${input.location}. They are the values at that line:`,
        '// an argument the method changed before it shows the changed value.',
        ...(classAttribute ? [classAttribute] : []),
        `public class ${frame.className}Tests`,
        '{',
        `    ${methodAttribute}`,
        `    public ${isAsync ? 'async Task' : 'void'} ${testMethod}()`,
        '    {',
        `${body}// Arrange`,
        ...arrange,
        '',
        `${body}// Act`,
        act,
        '',
        `${body}// Assert`,
        ...assert,
        '    }',
        '}',
        '',
    ].join('\n');
}

function assertEqual(framework: TestFramework): string {
    switch (framework) {
        case 'xunit':
            return 'Assert.Equal(expected, result);';
        case 'nunit':
            return 'Assert.That(result, Is.EqualTo(expected));';
        case 'mstest':
            return 'Assert.AreEqual(expected, result);';
    }
}

function frameworkNamespace(framework: TestFramework): string {
    switch (framework) {
        case 'xunit':
            return 'Xunit';
        case 'nunit':
            return 'NUnit.Framework';
        case 'mstest':
            return 'Microsoft.VisualStudio.TestTools.UnitTesting';
    }
}

/** [class attribute, method attribute]. */
function attributes(framework: TestFramework): [string | undefined, string] {
    switch (framework) {
        case 'xunit':
            return [undefined, '[Fact]'];
        case 'nunit':
            return ['[TestFixture]', '[Test]'];
        case 'mstest':
            return ['[TestClass]', '[TestMethod]'];
    }
}

function parseParameter(text: string): Parameter | undefined {
    // Attributes, then the default value, go; what is left is "[modifier] Type name".
    const withoutAttributes = text.replace(/^\s*(\[[^\]]*\]\s*)+/, '');
    const withoutDefault = splitTopLevel(withoutAttributes, '=')[0].trim();
    const words = withoutDefault.split(/\s+/).filter(Boolean);
    if (words.length < 2) {
        return undefined;
    }
    const name = words[words.length - 1].replace(/^@/, '');
    let modifier: Parameter['modifier'];
    const typeWords = words.slice(0, -1).filter((w) => {
        if (PARAMETER_MODIFIERS.has(w)) {
            modifier = w === 'scoped' ? modifier : (w as Parameter['modifier']);
            return false;
        }
        return true;
    });
    return { name, type: typeWords.join(' '), modifier };
}

/** Splits at `separator` outside of <>, (), [], {} and string literals. */
function splitTopLevel(text: string, separator = ','): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | undefined;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = undefined;
            }
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if ('<([{'.includes(c)) {
            depth++;
        } else if ('>)]}'.includes(c)) {
            depth--;
        } else if (c === separator && depth === 0 && !(separator === '=' && (text[i + 1] === '>' || text[i - 1] === '=' || text[i + 1] === '='))) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.filter((p) => p.trim() !== '');
}

function matchingParen(text: string, open: number): number {
    if (open < 0) {
        return -1;
    }
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') {
            depth++;
        } else if (text[i] === ')' && --depth === 0) {
            return i;
        }
    }
    return -1;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
