// Generates the engine API document (docs/engine-api.json and docs/engine-api.html) from src/engineProtocol.ts:
// the interfaces become JSON Schemas and their JSDoc the descriptions, the exported tables are listed as they are.
// Used by scripts/gen-engine-api.js and by a unit test that checks the committed files are up to date. Development only
// (it needs the typescript package; out/tools is not packaged).

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { ENGINE_CAPABILITIES, ENGINE_STARTUP, STANDARD_REQUESTS, VALUE_CONVENTIONS } from '../engineProtocol';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Schema = Record<string, any>;

interface Message {
    name: string;
    kind: 'request' | 'event';
    /** engine: crosses the engine boundary; proxy: handled or sent by the extension's DAP relay. */
    side: 'engine' | 'proxy';
    description: string;
    arguments?: Schema;
    response?: Schema;
    body?: Schema;
}

export interface EngineApi {
    title: string;
    version: string;
    launch: Schema;
    attach: Schema;
    messages: Message[];
    definitions: Record<string, Schema>;
    standardRequests: typeof STANDARD_REQUESTS;
    capabilities: typeof ENGINE_CAPABILITIES;
    startup: typeof ENGINE_STARTUP;
    valueConventions: typeof VALUE_CONVENTIONS;
}

/** Reads src/engineProtocol.ts under `repo`. */
export function buildEngineApi(repo: string): EngineApi {
    const file = path.join(repo, 'src', 'engineProtocol.ts');
    // Parent pointers are needed to read the JSDoc tags.
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const interfaces = new Map<string, ts.InterfaceDeclaration>();
    source.forEachChild((node) => {
        if (ts.isInterfaceDeclaration(node)) {
            interfaces.set(node.name.text, node);
        }
    });

    const definitions: Record<string, Schema> = {};
    const used = new Set<string>();
    const typeSchema = (node: ts.TypeNode): Schema => {
        switch (node.kind) {
            case ts.SyntaxKind.StringKeyword:
                return { type: 'string' };
            case ts.SyntaxKind.NumberKeyword:
                return { type: 'number' };
            case ts.SyntaxKind.BooleanKeyword:
                return { type: 'boolean' };
            case ts.SyntaxKind.UnknownKeyword:
            case ts.SyntaxKind.AnyKeyword:
                return {};
        }
        if (ts.isLiteralTypeNode(node)) {
            if (node.literal.kind === ts.SyntaxKind.NullKeyword) {
                return { type: 'null' };
            }
            if (ts.isStringLiteral(node.literal)) {
                return { const: node.literal.text };
            }
            if (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword) {
                return { const: node.literal.kind === ts.SyntaxKind.TrueKeyword };
            }
            if (ts.isNumericLiteral(node.literal)) {
                return { const: Number(node.literal.text) };
            }
        }
        if (ts.isArrayTypeNode(node)) {
            return { type: 'array', items: typeSchema(node.elementType) };
        }
        if (ts.isParenthesizedTypeNode(node)) {
            return typeSchema(node.type);
        }
        if (ts.isUnionTypeNode(node)) {
            const parts = node.types.map(typeSchema);
            // 'a' | 'b' -> enum; anything else -> anyOf.
            if (parts.every((p) => 'const' in p && typeof p.const === 'string')) {
                return { type: 'string', enum: parts.map((p) => p.const) };
            }
            return { anyOf: parts };
        }
        if (ts.isTypeLiteralNode(node)) {
            return objectSchema(node.members);
        }
        if (ts.isTypeReferenceNode(node)) {
            const name = node.typeName.getText(source);
            if (name === 'Record' && node.typeArguments?.length === 2) {
                return { type: 'object', additionalProperties: typeSchema(node.typeArguments[1]) };
            }
            if (interfaces.has(name)) {
                used.add(name);
                return { $ref: `#/definitions/${name}` };
            }
        }
        throw new Error(`engineProtocol.ts: type not supported by the document generator: ${node.getText(source)}`);
    };
    const objectSchema = (members: ts.NodeArray<ts.TypeElement>): Schema => {
        const properties: Record<string, Schema> = {};
        const required: string[] = [];
        for (const member of members) {
            if (!ts.isPropertySignature(member) || !member.type) {
                continue;
            }
            const name = member.name.getText(source);
            const description = docText(member);
            properties[name] = { ...typeSchema(member.type), ...(description ? { description } : {}) };
            if (!member.questionToken) {
                required.push(name);
            }
        }
        // Extra properties are allowed: VS Code adds its own (name, type, request, ...) and the engine ignores what it does not know.
        return { type: 'object', properties, ...(required.length ? { required } : {}) };
    };
    const interfaceSchema = (name: string): Schema => {
        const node = interfaces.get(name)!;
        const description = docText(node);
        return { ...(description ? { description } : {}), ...objectSchema(node.members) };
    };

    let launch: Schema | undefined;
    let attach: Schema | undefined;
    const messages = new Map<string, Message>();
    const message = (name: string, kind: Message['kind']): Message => {
        const key = `${kind}:${name}`;
        let m = messages.get(key);
        if (!m) {
            m = { name, kind, side: 'engine', description: '' };
            messages.set(key, m);
        }
        return m;
    };
    for (const [name, node] of interfaces) {
        const tags = docTags(node);
        if (tags.arguments === 'launch') {
            launch = interfaceSchema(name);
        } else if (tags.arguments === 'attach') {
            attach = interfaceSchema(name);
        } else if (tags.request) {
            const m = message(tags.request, 'request');
            m.side = side(tags.handledBy, name);
            m.description = docText(node);
            m.arguments = interfaceSchema(name);
            delete m.arguments.description;
        } else if (tags.response) {
            message(tags.response, 'request').response = interfaceSchema(name);
        } else if (tags.event) {
            const m = message(tags.event, 'event');
            m.side = side(tags.sentBy, name);
            m.description = docText(node);
            m.body = interfaceSchema(name);
            delete m.body.description;
        }
    }
    if (!launch || !attach) {
        throw new Error('engineProtocol.ts: the launch and attach arguments (@arguments) are missing');
    }
    for (const m of messages.values()) {
        if (m.kind === 'request' && !m.arguments) {
            throw new Error(`engineProtocol.ts: @response ${m.name} has no @request`);
        }
    }
    // Interfaces referenced from the messages (in the order they first appear).
    for (const name of [...used]) {
        definitions[name] = interfaceSchema(name);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    // The display name is localized (%displayName% in package.nls.json).
    const nls = JSON.parse(fs.readFileSync(path.join(repo, 'package.nls.json'), 'utf8'));
    const displayName = String(pkg.displayName ?? pkg.name).replace(/^%(.+)%$/, (_, key: string) => nls[key] ?? key);
    return {
        title: `${displayName} - debug engine API`,
        version: String(pkg.version),
        launch,
        attach,
        messages: [...messages.values()].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)),
        definitions,
        standardRequests: STANDARD_REQUESTS,
        capabilities: ENGINE_CAPABILITIES,
        startup: ENGINE_STARTUP,
        valueConventions: VALUE_CONVENTIONS,
    };

    function docText(node: ts.Node): string {
        const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
        return docs.map((d) => (typeof d.comment === 'string' ? d.comment : ts.getTextOfJSDocComment(d.comment) ?? '')).join('\n').replace(/\s*\n\s*/g, ' ').trim();
    }
}

function docTags(node: ts.Node): Record<string, string> {
    const tags: Record<string, string> = {};
    for (const tag of ts.getJSDocTags(node)) {
        tags[tag.tagName.text] = (typeof tag.comment === 'string' ? tag.comment : ts.getTextOfJSDocComment(tag.comment) ?? '').trim();
    }
    return tags;
}

function side(value: string | undefined, where: string): 'engine' | 'proxy' {
    if (value !== 'engine' && value !== 'proxy') {
        throw new Error(`engineProtocol.ts: ${where} needs @handledBy / @sentBy engine or proxy`);
    }
    return value;
}

/** Engine requests, relay requests, engine events, relay events. */
function order(m: Message): number {
    return (m.kind === 'request' ? 0 : 2) + (m.side === 'engine' ? 0 : 1);
}

/** The requests dotnet-x86dbg dispatches (`"command" =>` in src/debugger/engine.rs; src/adapter.rs before the engine was split), to compare with the document. */
export function engineDispatchedRequests(engineRepo: string): string[] {
    const file = [path.join(engineRepo, 'src', 'debugger', 'engine.rs'), path.join(engineRepo, 'src', 'adapter.rs')].find((f) => fs.existsSync(f)) ?? path.join(engineRepo, 'src', 'debugger', 'engine.rs');
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(/^\s*"([A-Za-z][\w.]*)"\s*=>/gm)].map((m) => m[1]).sort();
}

/** The requests the document says the engine handles. */
export function documentedEngineRequests(api: EngineApi): string[] {
    return [
        ...api.standardRequests.filter((r) => r.handledBy !== 'proxy').map((r) => r.command),
        ...api.messages.filter((m) => m.kind === 'request' && m.side === 'engine').map((m) => m.name),
    ].sort();
}

/* ------------------------------------------------------------------------------------------------------------------ */

export function renderJson(api: EngineApi): string {
    return JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...api }, null, 2) + '\n';
}

export function renderHtml(api: EngineApi): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // `code` in descriptions.
    const text = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
    const anchor = (kind: string, name: string) => `${kind}-${name.replace(/[^\w]/g, '-')}`;

    const typeText = (s: Schema): string => {
        if (s.$ref) {
            const name = s.$ref.split('/').pop();
            return `<a href="#def-${name}">${name}</a>`;
        }
        if (s.enum) {
            return s.enum.map((v: string) => `<code>"${esc(v)}"</code>`).join(' | ');
        }
        if ('const' in s) {
            return `<code>${esc(JSON.stringify(s.const))}</code>`;
        }
        if (s.anyOf) {
            return s.anyOf.map(typeText).join(' | ');
        }
        if (s.type === 'array') {
            return `${typeText(s.items)}[]`;
        }
        if (s.type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object') {
            return `{ [name]: ${typeText(s.additionalProperties)} }`;
        }
        if (s.type === 'object' && s.properties) {
            return 'object';
        }
        return esc(s.type ?? 'any');
    };
    const table = (schema: Schema | undefined, prefix = ''): string => {
        if (!schema?.properties || !Object.keys(schema.properties).length) {
            return prefix ? '' : '<p class="none">No fields.</p>';
        }
        const rows: string[] = [];
        for (const [name, s] of Object.entries<Schema>(schema.properties)) {
            const required = schema.required?.includes(name);
            rows.push(`<tr><td><code>${esc(prefix + name)}</code>${required ? '' : '<span class="opt">optional</span>'}</td><td>${typeText(s)}</td><td>${text(s.description ?? '')}</td></tr>`);
            const inner = s.type === 'array' ? s.items : s;
            if (inner?.type === 'object' && inner.properties) {
                rows.push(table(inner, `${prefix}${name}${s.type === 'array' ? '[]' : ''}.`).replace(/^<table>|<\/table>$/g, '').replace(/<thead>.*?<\/thead>/s, ''));
            }
        }
        const body = rows.join('\n');
        return prefix ? body : `<table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>\n${body}\n</table>`;
    };
    const example = (schema: Schema | undefined): unknown => {
        if (!schema) {
            return undefined;
        }
        if (schema.$ref) {
            return example(api.definitions[schema.$ref.split('/').pop()]);
        }
        if ('const' in schema) {
            return schema.const;
        }
        if (schema.enum) {
            return schema.enum[0];
        }
        if (schema.anyOf) {
            return example(schema.anyOf[0]);
        }
        switch (schema.type) {
            case 'string':
                return '';
            case 'number':
                return 0;
            case 'boolean':
                return false;
            case 'array':
                return [example(schema.items)];
            case 'object':
                if (schema.properties) {
                    return Object.fromEntries(Object.entries<Schema>(schema.properties).map(([k, v]) => [k, example(v)]));
                }
                return {};
        }
        return null;
    };
    const sample = (title: string, value: unknown) => `<details><summary>${title}</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>`;
    const sideBadge = (side: string) => `<span class="badge ${side}">${side === 'engine' ? 'engine' : 'extension relay'}</span>`;

    const messageHtml = (m: Message): string => {
        const id = anchor(m.kind, m.name);
        const parts = [`<section class="op" id="${id}"><h3><span class="verb ${m.kind}">${m.kind}</span> <code>${esc(m.name)}</code> ${sideBadge(m.side)}</h3>`, `<p>${text(m.description)}</p>`];
        if (m.kind === 'request') {
            parts.push('<h4>arguments</h4>', table(m.arguments), sample('Example request', { type: 'request', seq: 1, command: m.name, arguments: example(m.arguments) }));
            parts.push('<h4>response body</h4>', m.response ? table(m.response) : '<p class="none">None (an empty body; <code>success</code> tells the result).</p>');
            if (m.response) {
                parts.push(sample('Example response', { type: 'response', request_seq: 1, success: true, command: m.name, body: example(m.response) }));
            }
        } else {
            parts.push('<h4>body</h4>', table(m.body), sample('Example event', { type: 'event', seq: 1, event: m.name, body: example(m.body) }));
        }
        parts.push('</section>');
        return parts.join('\n');
    };

    const nav = [
        '<a href="#overview">Overview</a>',
        '<a href="#startup">Starting the engine</a>',
        '<a href="#arguments-launch">launch</a>',
        '<a href="#arguments-attach">attach</a>',
        '<a href="#standard">Standard requests</a>',
        '<a href="#capabilities">Capabilities</a>',
        ...api.messages.map((m) => `<a class="sub ${m.side}" href="#${anchor(m.kind, m.name)}">${m.kind === 'request' ? 'req' : 'evt'} ${esc(m.name)}</a>`),
        '<a href="#values">Value conventions</a>',
        '<a href="#definitions">Shared types</a>',
    ].join('\n');

    const standardRows = api.standardRequests
        .map((r) => `<tr><td><code>${esc(r.command)}</code></td><td>${sideBadge(r.handledBy === 'proxy' ? 'proxy' : 'engine')}${r.handledBy === 'both' ? ' ' + sideBadge('proxy') : ''}</td><td>${text(r.notes)}</td></tr>`)
        .join('\n');
    const startupRows = api.startup.map((s) => `<tr><td><code>${esc(s.name)}</code></td><td>${text(s.notes)}</td></tr>`).join('\n');
    const valueRows = api.valueConventions.map((v) => `<tr><td>${esc(v.what)}</td><td>${text(v.rule)}</td></tr>`).join('\n');
    const definitions = Object.entries(api.definitions)
        .map(([name, s]) => `<section class="op" id="def-${name}"><h3><code>${name}</code></h3>${s.description ? `<p>${text(s.description)}</p>` : ''}${table(s)}</section>`)
        .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(api.title)}</title>
<!-- Generated by npm run docs:api from src/engineProtocol.ts. Do not edit by hand. -->
<style>
:root { --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #fff; --side: #f6f8fa; --engine: #0969da; --proxy: #8250df; --req: #1a7f37; --evt: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --side: #151b23; --engine: #4493f8; --proxy: #ab7df8; --req: #3fb950; --evt: #d29922; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", "Yu Gothic UI", sans-serif; color: var(--fg); background: var(--bg); }
nav { position: fixed; inset: 0 auto 0 0; width: 280px; overflow-y: auto; padding: 16px; background: var(--side); border-right: 1px solid var(--line); font-size: 13px; }
nav a { display: block; padding: 3px 6px; color: var(--fg); text-decoration: none; border-radius: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
nav a:hover { background: var(--line); }
nav a.sub { padding-left: 14px; font-family: ui-monospace, Consolas, monospace; }
nav a.sub.engine { border-left: 3px solid var(--engine); }
nav a.sub.proxy { border-left: 3px solid var(--proxy); }
main { margin-left: 280px; padding: 24px 40px 80px; max-width: 1100px; }
h1 { margin-top: 0; } h2 { border-bottom: 1px solid var(--line); padding-bottom: 6px; margin-top: 40px; }
code, pre { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
pre { background: var(--side); border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
th, td { border: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: var(--side); }
.op { border: 1px solid var(--line); border-radius: 8px; padding: 4px 16px 12px; margin: 16px 0; }
.verb { display: inline-block; min-width: 64px; text-align: center; color: #fff; border-radius: 4px; font-size: 12px; padding: 1px 6px; text-transform: uppercase; }
.verb.request { background: var(--req); } .verb.event { background: var(--evt); }
.badge { display: inline-block; font-size: 11px; border-radius: 10px; padding: 0 8px; border: 1px solid; font-weight: normal; }
.badge.engine { color: var(--engine); } .badge.proxy { color: var(--proxy); }
.opt { margin-left: 6px; font-size: 11px; color: var(--muted); }
.none { color: var(--muted); }
summary { cursor: pointer; color: var(--muted); }
pre.diagram { line-height: 1.3; }
main a { color: var(--engine); }
</style>
</head>
<body>
<nav>
<strong>${esc(api.title)}</strong>
<div style="color:var(--muted);margin-bottom:8px">version ${esc(api.version)}</div>
${nav}
</nav>
<main>
<h1 id="overview">${esc(api.title)}</h1>
<p>The extension talks to its debug engine, <strong>dotnet-x86dbg</strong>, with the <a href="https://microsoft.github.io/debug-adapter-protocol/specification">Debug Adapter Protocol</a> (DAP) over the engine's stdin and stdout. Between VS Code and the engine sits the extension's DAP relay (<code>DapProxy</code>), which adds logpoints, hit counts, Step Into Specific, the exception log, the SQL log and more on top of what the engine offers.</p>
<pre class="diagram">VS Code  &lt;-- DAP --&gt;  DapProxy (extension)  &lt;-- DAP over stdin/stdout --&gt;  dotnet-x86dbg.exe (x86 or x64)</pre>
<p>${sideBadge('engine')} marks messages that cross the engine boundary; ${sideBadge('proxy')} marks messages the relay handles or sends itself (they never reach the engine). The engine of the program's bitness is started: ICorDebug needs a debugger of the same bitness as the program.</p>
<p>Generated from <code>src/engineProtocol.ts</code> by <code>npm run docs:api</code>; the same data as JSON Schema is in <a href="engine-api.json">engine-api.json</a>.</p>

<h2 id="startup">Starting the engine</h2>
<table><thead><tr><th>Argument / variable</th><th>Meaning</th></tr></thead>
${startupRows}
</table>

<h2 id="arguments-launch">launch arguments</h2>
<p>${text(api.launch.description ?? '')}</p>
${table(api.launch)}
${sample('Example', { type: 'request', seq: 2, command: 'launch', arguments: example(api.launch) })}

<h2 id="arguments-attach">attach arguments</h2>
<p>${text(api.attach.description ?? '')}</p>
${table(api.attach)}

<h2 id="standard">Standard DAP requests</h2>
<p>The requests VS Code and the relay use, with what the extension relies on beyond the DAP specification.</p>
<table><thead><tr><th>Command</th><th>Handled by</th><th>Notes</th></tr></thead>
${standardRows}
</table>

<h2 id="capabilities">Capabilities</h2>
<p>The engine's <code>initialize</code> response. Only implemented features are reported.</p>
<pre>${esc(JSON.stringify(api.capabilities, null, 2))}</pre>

<h2 id="messages">Custom requests and events</h2>
${api.messages.map(messageHtml).join('\n')}

<h2 id="values">Value conventions</h2>
<p>The <code>value</code> / <code>result</code> strings of <code>variables</code> and <code>evaluate</code>. The extension parses them, so they are part of the contract.</p>
<table><thead><tr><th>Values</th><th>Written as</th></tr></thead>
${valueRows}
</table>

<h2 id="definitions">Shared types</h2>
${definitions}
</main>
</body>
</html>
`;
}
