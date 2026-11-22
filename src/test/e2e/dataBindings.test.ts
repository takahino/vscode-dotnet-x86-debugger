// E2E: the data bindings view reads the WinForms bindings of a stopped form.

import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { DataBindings, readDataBindings } from '../../dataBindingsCore';
import { DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

describe('data bindings', { skip: e2eSkip || (process.env.NETDBG_SKIP_UI_TESTS ? 'NETDBG_SKIP_UI_TESTS is set' : false) }, () => {
    let s: DapSession;
    let bindings: DataBindings;

    before(async () => {
        const program = path.join(buildApp('Bindings'), 'Bindings.exe');
        const source = appSource('Bindings', 'Program.cs');
        s = new DapSession();
        const first = s.nextStop();
        await s.launch(program, { [source]: [{ line: lineOf(source, 'shown') }] });
        const frameId = (await s.topFrame((await first).body.threadId)).id;
        // As the extension's evaluator does: strings without their quotes, errors thrown.
        const evaluate = async (expression: string) => {
            const r = await s.evaluate(expression, frameId);
            if (!r.success) {
                throw new Error(r.message);
            }
            const value = String(r.body.result);
            return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
        };
        bindings = await readDataBindings([{ expression: 'System.Windows.Forms.Application.OpenForms[0]' }], evaluate);
    });
    after(async () => {
        await s?.close();
    });

    const simple = (control: string) => bindings.simple.find((b) => b.control.endsWith(control));
    const list = (control: string) => bindings.lists.find((b) => b.control.endsWith(control));

    it('walks the form and the controls inside a panel', () => {
        // 7 of the app's own, plus the parts of NumericUpDown and DataGridView (their number depends on the runtime).
        assert.ok(bindings.controls >= 7, String(bindings.controls));
        assert.equal(bindings.truncated, false);
        assert.equal(simple('ageLabel')?.control, 'customerForm › detailPanel › ageLabel');
    });

    it('shows an edit of the text box that was not written back to the current item', () => {
        const b = simple('nameBox');
        assert.equal(b?.property, 'Text');
        assert.equal(b?.member, 'Name');
        assert.equal(b?.controlValue, 'Edited');
        assert.equal(b?.sourceValue, 'Bob');
        assert.equal(b?.updateMode, 'OnValidation');
        assert.equal(b?.differs, true);
        assert.deepEqual(b?.position, { index: 1, count: 2 });
        assert.deepEqual(b?.bindingSource, { dataSourceType: 'BindingList<Customer>', dataMember: '', filter: '', sort: '' });
    });

    it('does not flag a binding whose values agree, or one with a format string', () => {
        assert.equal(simple('ageBox')?.sourceValue, '40');
        assert.equal(simple('ageBox')?.differs, false);
        assert.equal(simple('ageLabel')?.formatString, 'Age: {0}');
        assert.equal(simple('ageLabel')?.differs, false);
    });

    it('reads the list bindings of a ComboBox and a DataGridView', () => {
        const combo = list('customerCombo');
        assert.equal(combo?.sourceType, 'BindingList<Customer>');
        assert.equal(combo?.displayMember, 'Name');
        assert.equal(combo?.valueMember, 'Age');
        assert.equal(combo?.selectedValue, '30');
        assert.deepEqual(combo?.position, { index: 0, count: 2 });
        const grid = list('customerGrid');
        assert.equal(grid?.sourceType, 'BindingSource');
        assert.deepEqual(grid?.position, { index: 1, count: 2 });
        assert.equal(grid?.bindingSource?.dataSourceType, 'BindingList<Customer>');
    });
});
