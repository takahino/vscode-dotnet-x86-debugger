import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { prettyTypeName, readDataBindings, shortTypeName, valuesDiffer } from '../../dataBindingsCore';

describe('prettyTypeName', () => {
    it('drops namespaces and assembly names', () => {
        assert.equal(prettyTypeName('System.Windows.Forms.BindingSource'), 'BindingSource');
        assert.equal(prettyTypeName('System.ComponentModel.BindingList`1[[Customer, Bindings, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null]]'), 'BindingList<Customer>');
    });

    it('writes nested generics, several arguments and arrays as C# does', () => {
        assert.equal(
            prettyTypeName('System.Collections.Generic.Dictionary`2[[System.String, mscorlib],[System.Collections.Generic.List`1[[MyApp.Order, MyApp]], mscorlib]]'),
            'Dictionary<String, List<Order>>',
        );
        assert.equal(prettyTypeName('MyApp.Order[]'), 'Order[]');
        assert.equal(prettyTypeName('System.Int32[,]'), 'Int32[,]');
    });
});

describe('shortTypeName', () => {
    it('joins nested types with dots', () => {
        assert.equal(shortTypeName('MyApp.MainForm+Row'), 'MainForm.Row');
    });
});

describe('valuesDiffer', () => {
    it('finds an edit that was not written back', () => {
        assert.equal(valuesDiffer('Edited', 'Bob', false), true);
    });

    it('treats the same number or boolean as equal however it is written', () => {
        assert.equal(valuesDiffer('30', '30.0', false), false);
        assert.equal(valuesDiffer('True', 'true', false), false);
        assert.equal(valuesDiffer('', 'null', false), false);
    });

    it('does not compare formatted bindings or values it could not read', () => {
        assert.equal(valuesDiffer('Age: 40', '40', true), false);
        assert.equal(valuesDiffer('x', undefined, false), false);
    });
});

describe('readDataBindings', () => {
    // A fake debugger: a form holding a bound text box and a combo box bound to a list (.NET Framework field names).
    const F = 'F';
    const values: Record<string, string> = {
        [`${F}.Name`]: 'customerForm',
        [`${F}.GetType().FullName`]: 'MyApp.CustomerForm',
        [`${F}.DataBindings.Count`]: '0',
        [`${F}.Controls.Count`]: '2',
        [`${F}.Controls[0].Name`]: 'nameBox',
        [`${F}.Controls[0].GetType().FullName`]: 'System.Windows.Forms.TextBox',
        [`${F}.Controls[0].DataBindings.Count`]: '1',
        [`${F}.Controls[0].Controls.Count`]: '0',
        [`${F}.Controls[0].Text`]: 'Edited',
        [`${F}.Controls[0].DataBindings[0].PropertyName`]: 'Text',
        [`${F}.Controls[0].DataBindings[0].DataSource.GetType().FullName`]: 'System.Windows.Forms.BindingSource',
        [`${F}.Controls[0].DataBindings[0].FormattingEnabled`]: 'false',
        [`${F}.Controls[0].DataBindings[0].FormatString`]: '',
        [`${F}.Controls[0].DataBindings[0].bindToObject.GetValue()`]: 'Bob',
        [`${F}.Controls[0].DataBindings[0].IsBinding`]: 'true',
        [`${F}.Controls[0].DataBindings[0].BindingMemberInfo.BindingMember`]: 'Name',
        [`${F}.Controls[0].DataBindings[0].DataSourceUpdateMode.ToString()`]: 'OnValidation',
        [`${F}.Controls[0].DataBindings[0].BindingManagerBase.Position`]: '1',
        [`${F}.Controls[0].DataBindings[0].BindingManagerBase.Count`]: '2',
        [`${F}.Controls[0].DataBindings[0].DataSource.DataSource.GetType().FullName`]: 'System.ComponentModel.BindingList`1[[MyApp.Customer, MyApp]]',
        [`${F}.Controls[0].DataBindings[0].DataSource.DataMember`]: '',
        [`${F}.Controls[0].DataBindings[0].DataSource.Filter`]: 'null',
        [`${F}.Controls[0].DataBindings[0].DataSource.Sort`]: 'Name',
        [`${F}.Controls[1].Name`]: 'customerCombo',
        [`${F}.Controls[1].GetType().FullName`]: 'System.Windows.Forms.ComboBox',
        [`${F}.Controls[1].DataBindings.Count`]: '0',
        [`${F}.Controls[1].Controls.Count`]: '0',
        [`${F}.Controls[1].DataSource`]: '{System.ComponentModel.BindingList<MyApp.Customer>}',
        [`${F}.Controls[1].DataSource.GetType().FullName`]: 'System.ComponentModel.BindingList`1[[MyApp.Customer, MyApp]]',
        [`${F}.Controls[1].DisplayMember`]: 'Name',
        [`${F}.Controls[1].ValueMember`]: 'Age',
        [`${F}.Controls[1].SelectedValue`]: '{int}',
        [`${F}.Controls[1].SelectedValue.ToString()`]: '30',
        [`${F}.Controls[1].DataManager.Position`]: '0',
        [`${F}.Controls[1].DataManager.Count`]: '2',
    };
    const evaluate = async (expression: string) => {
        if (expression in values) {
            return values[expression];
        }
        throw new Error(`error: 0x80004005 (${expression})`);
    };

    it('reads a simple binding with both values, its position and the BindingSource', async () => {
        const r = await readDataBindings([{ expression: F }], evaluate);
        assert.deepEqual(r.simple, [{
            control: 'customerForm › nameBox',
            controlExpression: 'F.Controls[0]',
            property: 'Text',
            sourceType: 'BindingSource',
            member: 'Name',
            controlValue: 'Edited',
            sourceValue: 'Bob',
            updateMode: 'OnValidation',
            formattingEnabled: false,
            formatString: '',
            active: true,
            position: { index: 1, count: 2 },
            bindingSource: { dataSourceType: 'BindingList<Customer>', dataMember: '', filter: '', sort: 'Name' },
            differs: true,
        }]);
    });

    it('reads a list binding of a ComboBox, with its selected value', async () => {
        const r = await readDataBindings([{ expression: F }], evaluate);
        assert.deepEqual(r.lists, [{
            control: 'customerForm › customerCombo',
            controlExpression: 'F.Controls[1]',
            controlType: 'ComboBox',
            sourceType: 'BindingList<Customer>',
            dataMember: '',
            displayMember: 'Name',
            valueMember: 'Age',
            selectedValue: '30',
            position: { index: 0, count: 2 },
            bindingSource: undefined,
        }]);
        assert.equal(r.controls, 3);
    });

    it('labels the controls under the path given for the root, and stops at the control limit', async () => {
        const r = await readDataBindings([{ expression: `${F}.Controls[0]`, parent: 'customerForm' }], evaluate);
        assert.equal(r.simple[0].control, 'customerForm › nameBox');
        const limited = await readDataBindings([{ expression: F }], evaluate, { maxControls: 1 });
        assert.equal(limited.truncated, true);
        assert.equal(limited.controls, 1);
    });
});
