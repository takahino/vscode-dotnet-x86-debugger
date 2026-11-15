// Functions that read the stopped program through DAP requests, with the requests answered by fakes: the values of a
// generated test, a dump, the event keys of a control, and the symbol download that gives up early.

import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { DapVariable, DumpCancelledError, dumpVariable } from '../../dumpCore';
import { readEventKeys } from '../../eventHandlersCore';
import { downloadSymbols } from '../../symbolDownload';
import { MethodSignature, captureValues } from '../../testGenCore';

/** Children by variablesReference, as netcoredbg's variables request answers. */
function variablesRequest(children: Record<number, DapVariable[]>) {
    return async (_command: string, args: Record<string, unknown>) => ({ variables: children[args.variablesReference as number] ?? [] });
}

const options = { maxDepth: 3, maxNodes: 100 };

describe('captureValues', () => {
    const order = { result: '{Order}', type: 'Shop.Order', variablesReference: 1 };
    const children = { 1: [{ name: 'Id', value: '7', type: 'int', variablesReference: 0 }] };

    it('reads every argument but "out" ones, and `this` of an instance method, as C#', async () => {
        const signature: MethodSignature = {
            name: 'Save',
            returnType: 'bool',
            isStatic: false,
            parameters: [{ name: 'order', type: 'Order' }, { name: 'count', type: 'int' }, { name: 'error', type: 'string', modifier: 'out' }],
        };
        const asked: string[] = [];
        const evaluate = async (expression: string) => {
            asked.push(expression);
            return expression === 'order' ? order : expression === 'count' ? { result: '3', type: 'int', variablesReference: 0 } : { result: '{Repo}', type: 'Shop.Repo', variablesReference: 0 };
        };
        const captured = await captureValues(signature, evaluate, variablesRequest(children), options);
        assert.deepEqual(asked, ['order', 'count', 'this']);
        assert.match(captured.values.get('order')!, /new Shop\.Order\s*\{[\s\S]*Id = 7/);
        assert.equal(captured.values.get('count'), '3');
        assert.ok(captured.instance !== undefined);
        assert.deepEqual(captured.problems, []);
    });

    it('does not read `this` of a static method, and lists what could not be read', async () => {
        const signature: MethodSignature = { name: 'Parse', returnType: 'int', isStatic: true, parameters: [{ name: 's', type: 'string' }] };
        const captured = await captureValues(signature, async () => { throw new Error('optimized away'); }, variablesRequest({}), options);
        assert.equal(captured.instance, undefined);
        assert.equal(captured.values.size, 0);
        assert.deepEqual(captured.problems, ['s: optimized away']);
    });

    it('says when a value was cut short by the dump limits', async () => {
        const deep: Record<number, DapVariable[]> = {};
        for (let i = 1; i <= 5; i++) {
            deep[i] = [{ name: 'Next', value: '{Node}', type: 'Node', variablesReference: i + 1 }];
        }
        const signature: MethodSignature = { name: 'Walk', returnType: 'void', isStatic: true, parameters: [{ name: 'head', type: 'Node' }] };
        const captured = await captureValues(signature, async () => ({ result: '{Node}', type: 'Node', variablesReference: 1 }), variablesRequest(deep), { maxDepth: 2, maxNodes: 100 });
        assert.deepEqual(captured.problems, ['head: not expanded completely (dump limits)']);
    });
});

describe('dumpVariable', () => {
    it('gives the value as JSON (with its type) and the number of values read', async () => {
        const root: DapVariable = { name: 'order', value: '{Order}', type: 'Order', variablesReference: 1 };
        const result = await dumpVariable(variablesRequest({
            1: [{ name: 'Id', value: '7', type: 'int', variablesReference: 0 }, { name: 'Note', value: '"rush"', type: 'string', variablesReference: 0 }],
        }), root, options);
        assert.deepEqual(result.value, { $type: 'Order', Id: 7, Note: 'rush' });
        assert.equal(result.truncated, false);
        assert.ok(result.nodes >= 3);
    });

    it('stops when cancelled', async () => {
        const root: DapVariable = { name: 'order', value: '{Order}', type: 'Order', variablesReference: 1 };
        await assert.rejects(
            dumpVariable(variablesRequest({ 1: [{ name: 'Id', value: '7', type: 'int', variablesReference: 0 }] }), root, { ...options, isCancelled: () => true }),
            DumpCancelledError,
        );
    });
});

describe('readEventKeys', () => {
    it('lists the static event key fields of the control (inherited ones included), with the expression netcoredbg gives', async () => {
        const request = async (command: string, args: Record<string, unknown>) => {
            if (command === 'evaluate') {
                return { result: '{Button}', variablesReference: 1 };
            }
            const byRef: Record<number, unknown[]> = {
                1: [{ name: 'Text', variablesReference: 0 }, { name: 'Static members', variablesReference: 2 }],
                2: [
                    { name: 's_clickEvent', type: 'object', evaluateName: 'System.Windows.Forms.Control.s_clickEvent' },
                    { name: 'EventMouseDown', type: 'object', evaluateName: 'System.Windows.Forms.Control.EventMouseDown' },
                    { name: 's_defaultFont', type: 'System.Drawing.Font', evaluateName: 'System.Windows.Forms.Control.s_defaultFont' },
                    { name: 's_somethingEvent', type: 'object' }, // no expression to reach it
                    { name: 'counter', type: 'object', evaluateName: 'X.counter' },
                ],
            };
            return { variables: byRef[args.variablesReference as number] ?? [] };
        };
        const keys = await readEventKeys('form.okButton', 1, request);
        assert.deepEqual(keys, [
            { field: 's_clickEvent', expression: 'System.Windows.Forms.Control.s_clickEvent' },
            { field: 'EventMouseDown', expression: 'System.Windows.Forms.Control.EventMouseDown' },
        ]);
    });

    it('finds nothing for a value that is not an object, or has no static members', async () => {
        assert.deepEqual(await readEventKeys('x', 1, async () => ({ result: '1', variablesReference: 0 })), []);
        assert.deepEqual(await readEventKeys('x', 1, async (command) => (command === 'evaluate' ? { variablesReference: 1 } : { variables: [] })), []);
    });
});

describe('downloadSymbols', () => {
    it('gives up without asking any server for a file that is not a .NET assembly', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetx86-symbols-'));
        try {
            const file = path.join(dir, 'native.dll');
            fs.writeFileSync(file, Buffer.from('MZ not really a program'));
            const asked: string[] = [];
            const result = await downloadSymbols(file, ['https://symbols.example'], dir, async (url) => {
                asked.push(url);
                return Buffer.alloc(0);
            });
            assert.deepEqual(result, { ok: false, reason: 'not-managed', tried: [] });
            assert.deepEqual(asked, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
