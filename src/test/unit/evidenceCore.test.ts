// "Capture Evidence" without a debugger: file names, the values read per control type, and the Markdown file.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { EvidenceData, buildEvidence, evidenceFolderName, pictureFileName, valuePropertiesOf } from '../../evidenceCore';

const identity = (text: string) => text;

function data(extra: Partial<EvidenceData> = {}): EvidenceData {
    return { time: new Date(2026, 10, 16, 9, 5, 7), stack: [], locals: [], forms: [], sql: [], ...extra };
}

describe('evidence names', () => {
    it('names the folder after the time, sortable', () => {
        assert.equal(evidenceFolderName(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
        assert.equal(evidenceFolderName(new Date(2026, 10, 16, 23, 59, 59)), '20261116-235959');
    });

    it('names a picture after its form, with only safe characters', () => {
        assert.equal(pictureFileName(0, 'mainForm'), 'form-1-mainForm.png');
        assert.equal(pictureFileName(2, 'Order Entry/Edit'), 'form-3-Order_Entry_Edit.png');
        assert.equal(pictureFileName(1, '受注画面'), 'form-2-_.png');
        assert.equal(pictureFileName(1, ''), 'form-2-form.png');
    });
});

describe('valuePropertiesOf', () => {
    it('reads the value of input controls, by the short type name', () => {
        assert.deepEqual(valuePropertiesOf('System.Windows.Forms.CheckBox').map((p) => p.label), ['Checked']);
        assert.deepEqual(valuePropertiesOf('System.Windows.Forms.ListBox').map((p) => p.label), ['SelectedIndex', 'Items']);
        assert.match(valuePropertiesOf('System.Windows.Forms.DateTimePicker')[0].property, /^Value\.ToString\("yyyy-MM-dd HH:mm:ss"\)$/);
    });

    it('reads nothing more for controls whose Text is their value', () => {
        assert.deepEqual(valuePropertiesOf('System.Windows.Forms.TextBox'), []);
        assert.deepEqual(valuePropertiesOf('System.Windows.Forms.Label'), []);
    });
});

describe('buildEvidence', () => {
    it('writes the location with its code, each form with its picture, controls and grid, the variables, the stack and the SQL', () => {
        const md = buildEvidence(data({
            program: 'Orders.exe',
            location: { name: 'OrderForm.Save', file: 'OrderForm.cs', line: 42, code: '        repository.Save(order);   ' },
            forms: [{
                name: 'orderForm', type: 'Orders.OrderForm', title: 'Order 1001', screenshot: 'form-1-orderForm.png', truncated: false,
                controls: [
                    { depth: 0, name: 'header', type: 'System.Windows.Forms.Panel', text: '', visible: true, enabled: true },
                    { depth: 1, name: 'customer', type: 'System.Windows.Forms.TextBox', text: 'A | B\r\nC', visible: true, enabled: false },
                    { depth: 1, name: 'express', type: 'System.Windows.Forms.CheckBox', text: 'Express', visible: false, enabled: true, value: 'Checked: True' },
                    { depth: 0, name: 'lines', type: 'System.Windows.Forms.DataGridView', text: '', visible: true, enabled: true, grid: { headers: ['Item', 'Qty'], rows: [['Pen', '2']], rowCount: 5 } },
                ],
            }],
            locals: [{ name: 'order', value: '{Order}', type: 'Orders.Order' }],
            stack: ['OrderForm.Save  OrderForm.cs:42', 'Program.Main'],
            sql: ["INSERT INTO ORDERS VALUES (1001, 'A');"],
        }), identity);

        assert.match(md, /^# Evidence /);
        assert.match(md, /- Program: `Orders\.exe`/);
        assert.match(md, /- Stopped at: `OrderForm\.Save` \(OrderForm\.cs:42\)/);
        assert.match(md, /```csharp\nrepository\.Save\(order\);\n```/);
        assert.match(md, /## Form 1: orderForm "Order 1001"\n\n!\[orderForm\]\(form-1-orderForm\.png\)/);
        // Nesting is shown by indentation; | and line breaks in a value do not break the table.
        assert.match(md, /\|  customer \| TextBox \| A \\\| B C \|  \| disabled \|/);
        assert.match(md, /\|  express \| CheckBox \| Express \| Checked: True \| hidden \|/);
        assert.match(md, /### lines \(5 rows\)\n\n\| Item \| Qty \|\n\|---\|---\|\n\| Pen \| 2 \|/);
        assert.match(md, /## Variables\n\n\| Name \| Value \| Type \|\n\|---\|---\|---\|\n\| order \| \{Order\} \| Orders\.Order \|/);
        assert.match(md, /## Call stack\n\n```\nOrderForm\.Save {2}OrderForm\.cs:42\nProgram\.Main\n```/);
        assert.match(md, /## SQL since the previous capture\n\n```sql\nINSERT INTO ORDERS VALUES \(1001, 'A'\);\n```/);
    });

    it('says why a form has no picture and when not every control was read', () => {
        const md = buildEvidence(data({
            forms: [{ name: '', type: 'Orders.SplashForm', title: '', screenshotProblem: 'minimized', truncated: true, controls: [] }],
        }), identity);
        assert.match(md, /## Form 1: Orders\.SplashForm\n\n_No picture: minimized_/);
        assert.match(md, /_Only the first controls were read\._/);
        assert.doesNotMatch(md, /\| Control \|/);
    });

    it('leaves out the sections it has nothing for, and says when forms could not be read', () => {
        const md = buildEvidence(data({ formsProblem: 'not a WinForms program' }), identity);
        assert.match(md, /_Forms were not read: not a WinForms program_/);
        for (const heading of ['## Variables', '## Call stack', '## SQL', '## Form']) {
            assert.ok(!md.includes(heading), heading);
        }
    });

    it('translates the headings with the given function', () => {
        const md = buildEvidence(data({ locals: [{ name: 'x', value: '1' }] }), (text) => `[${text}]`);
        assert.match(md, /^# \[Evidence\] /);
        assert.match(md, /## \[Variables\]/);
        assert.match(md, /\| \[Name\] \| \[Value\] \| \[Type\] \|/);
    });
});
