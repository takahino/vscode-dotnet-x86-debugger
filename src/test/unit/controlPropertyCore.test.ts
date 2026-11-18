import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { EDITABLE_PROPERTIES, failedResult, setterExpression, valueExpression } from '../../controlPropertyCore';

describe('valueExpression', () => {
    it('quotes text as a C# string literal', () => {
        assert.deepEqual(valueExpression('string', 'Say "hi"\\now'), { expression: '"Say \\"hi\\"\\\\now"' });
        assert.deepEqual(valueExpression('string', ''), { expression: '""' });
    });

    it('accepts true / false for bool', () => {
        assert.deepEqual(valueExpression('bool', ' True '), { expression: 'true' });
        assert.ok('error' in valueExpression('bool', 'yes'));
    });

    it('accepts whole numbers for int', () => {
        assert.deepEqual(valueExpression('int', '-12'), { expression: '-12' });
        assert.ok('error' in valueExpression('int', '1.5'));
    });

    it('writes enum members with their type, combining several with |', () => {
        assert.deepEqual(valueExpression('enum', 'Fill', 'System.Windows.Forms.DockStyle'), { expression: 'System.Windows.Forms.DockStyle.Fill' });
        assert.deepEqual(valueExpression('enum', 'Top, Left', 'System.Windows.Forms.AnchorStyles'), {
            expression: 'System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left',
        });
        assert.deepEqual(valueExpression('enum', 'Top | Left', 'A'), { expression: 'A.Top | A.Left' });
        assert.ok('error' in valueExpression('enum', '', 'A'));
        assert.ok('error' in valueExpression('enum', 'Top,', 'A'));
        assert.ok('error' in valueExpression('enum', 'Fill()', 'A'));
    });

    it('lists Dock and Anchor as enum properties', () => {
        assert.equal(EDITABLE_PROPERTIES.find((p) => p.name === 'Dock')?.enumType, 'System.Windows.Forms.DockStyle');
        assert.equal(EDITABLE_PROPERTIES.find((p) => p.name === 'Anchor')?.enumType, 'System.Windows.Forms.AnchorStyles');
    });

    it('accepts color names, #RRGGBB, #AARRGGBB and R,G,B', () => {
        assert.deepEqual(valueExpression('color', 'Red'), { expression: 'System.Drawing.Color.Red' });
        assert.deepEqual(valueExpression('color', '#ff0080'), { expression: 'System.Drawing.Color.FromArgb(255, 0, 128)' });
        assert.deepEqual(valueExpression('color', '#80ff0080'), { expression: 'System.Drawing.Color.FromArgb(128, 255, 0, 128)' });
        assert.deepEqual(valueExpression('color', '10, 20,30'), { expression: 'System.Drawing.Color.FromArgb(10, 20, 30)' });
        assert.ok('error' in valueExpression('color', '#12'));
        assert.ok('error' in valueExpression('color', '300,0,0'));
        assert.ok('error' in valueExpression('color', 'Not a color!'));
    });

    it('takes any C# expression as it is', () => {
        assert.deepEqual(valueExpression('expression', ' System.Drawing.SystemFonts.CaptionFont '), { expression: 'System.Drawing.SystemFonts.CaptionFont' });
        assert.ok('error' in valueExpression('expression', '  '));
    });
});

describe('setterExpression', () => {
    it('calls the property setter (netcoredbg cannot assign through an indexer result)', () => {
        assert.equal(setterExpression('Forms[0].Controls[1]', 'Text', '"a"'), 'Forms[0].Controls[1].set_Text("a")');
    });

    it('refuses names that are not identifiers', () => {
        assert.throws(() => setterExpression('c', 'Text); x(', '1'));
    });
});

describe('failedResult', () => {
    it('sees an exception returned as the result of the setter', () => {
        assert.equal(failedResult({ result: '{System.ComponentModel.InvalidEnumArgumentException}', type: 'System.ComponentModel.InvalidEnumArgumentException' }), 'System.ComponentModel.InvalidEnumArgumentException');
        assert.equal(failedResult({ result: 'Expression has been evaluated and has no value', type: 'void' }), undefined);
    });
});

describe('EDITABLE_PROPERTIES', () => {
    it('lists the common properties with their kinds', () => {
        assert.deepEqual(EDITABLE_PROPERTIES.find((p) => p.name === 'BackColor')?.kind, 'color');
        assert.deepEqual(EDITABLE_PROPERTIES.find((p) => p.name === 'Visible')?.kind, 'bool');
    });
});
