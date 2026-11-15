import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { eventNameFromField, functionBreakpointName, handlerLabel, readEventHandlers } from '../../eventHandlersCore';

describe('eventNameFromField', () => {
    it('reads the event name from the WinForms key fields of .NET and .NET Framework', () => {
        assert.equal(eventNameFromField('s_clickEvent'), 'Click');
        assert.equal(eventNameFromField('s_selectedIndexChangedEvent'), 'SelectedIndexChanged');
        assert.equal(eventNameFromField('EventClick'), 'Click');
        assert.equal(eventNameFromField('EVENT_LOAD'), 'Load');
        assert.equal(eventNameFromField('s_cache'), undefined);
    });
});

describe('functionBreakpointName', () => {
    it('joins nested types with dots, as netcoredbg expects', () => {
        assert.equal(functionBreakpointName('Program', 'OnOkClick'), 'Program.OnOkClick');
        assert.equal(functionBreakpointName('Program+<>c', '<Main>b__0_0'), 'Program.<>c.<Main>b__0_0');
    });
});

describe('handlerLabel', () => {
    it('names lambdas after the method they are written in', () => {
        assert.equal(handlerLabel('Program', 'OnOkClick'), 'Program.OnOkClick');
        assert.equal(handlerLabel('MyApp.MainForm+<>c', '<InitializeComponent>b__12_0'), 'lambda in MyApp.MainForm.InitializeComponent');
    });
});

describe('readEventHandlers', () => {
    // A fake debugger holding Click (two handlers) and MouseDown (one).
    const values: Record<string, string> = {
        'c.Events._head': '{ListEntry}',
        'c.Events._head._handler._invocationList': 'null',
        'c.Events._head._handler.Method.Name': '"OnMouseDown"',
        'c.Events._head._handler.Method.DeclaringType.FullName': '"Form1"',
        'c.Events._head._next': '{ListEntry}',
        'c.Events._head._next._handler._invocationList': '{object[2]}',
        'c.Events._head._next._handler._invocationCount': '2',
        'c.Events._head._next._handler._invocationList[0].Method.Name': '"OnClick"',
        'c.Events._head._next._handler._invocationList[0].Method.DeclaringType.FullName': '"Form1"',
        'c.Events._head._next._handler._invocationList[1].Method.Name': '"<Init>b__0_0"',
        'c.Events._head._next._handler._invocationList[1].Method.DeclaringType.FullName': '"Form1+<>c"',
        'c.Events._head._next._next': 'null',
        'System.Object.ReferenceEquals(c.Events._head._key, Button.s_mouseDownEvent)': 'true',
        'System.Object.ReferenceEquals(c.Events._head._next._key, Button.s_clickEvent)': 'true',
    };
    const evaluate = async (expression: string) => {
        if (expression in values) {
            return values[expression];
        }
        if (expression.startsWith('System.Object.ReferenceEquals(')) {
            return 'false';
        }
        throw new Error(`cannot evaluate ${expression}`);
    };
    const keys = [{ field: 's_clickEvent', expression: 'Button.s_clickEvent' }, { field: 's_mouseDownEvent', expression: 'Button.s_mouseDownEvent' }];

    it('walks the event list, opens multicast delegates and names the events', async () => {
        const handlers = await readEventHandlers('c', keys, evaluate);
        assert.deepEqual(handlers.map((h) => `${h.event}: ${h.breakpointName}`), [
            'MouseDown: Form1.OnMouseDown',
            'Click: Form1.OnClick',
            'Click: Form1.<>c.<Init>b__0_0',
        ]);
    });

    it('also reads the .NET Framework field names', async () => {
        const framework: Record<string, string> = {};
        for (const [k, v] of Object.entries(values)) {
            framework[k.replace(/\._head/g, '.head').replace(/\._next/g, '.next').replace(/\._handler/g, '.handler').replace(/\._key/g, '.key')] = v;
        }
        const handlers = await readEventHandlers('c', keys, async (e) => {
            if (e in framework) {
                return framework[e];
            }
            if (e.startsWith('System.Object.ReferenceEquals(')) {
                return 'false';
            }
            throw new Error(`cannot evaluate ${e}`);
        });
        assert.equal(handlers.length, 3);
    });
});
