import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { ResourceType, diffResources, handleStatsArguments, resourceKind, withKinds } from '../../resourceLeakCore';

describe('handleStatsArguments', () => {
    it('asks for the handle field of each type under its .NET and .NET Framework names', () => {
        const fields = handleStatsArguments().fields;
        assert.ok(fields.some((f) => f.type === 'System.Drawing.Font' && f.field === '_nativeFont'));
        assert.ok(fields.some((f) => f.type === 'System.Drawing.Font' && f.field === 'nativeFont'));
        assert.ok(fields.some((f) => f.type === 'System.Windows.Forms.NativeWindow' && f.field === '<HWND>k__BackingField'));
    });
});

describe('resourceKind', () => {
    it('tells GDI+ objects from USER objects by the declaring type of the field', () => {
        assert.equal(resourceKind('System.Drawing.Image._nativeImage'), 'GDI+');
        assert.equal(resourceKind('System.Drawing.Icon.handle'), 'USER');
        assert.equal(resourceKind('My.Thing._handle'), '?');
    });
});

describe('diffResources', () => {
    const font = (count: number, live: number): ResourceType => ({ name: 'System.Drawing.Font', count, live, field: 'System.Drawing.Font._nativeFont', kind: 'GDI+' });
    const brush = (count: number, live: number): ResourceType => ({ name: 'System.Drawing.SolidBrush', count, live, field: 'System.Drawing.Brush._nativeBrush', kind: 'GDI+' });

    it('puts the types that hold more handles than at the baseline first', () => {
        const rows = diffResources([brush(10, 10), font(12, 9)], [brush(10, 10), font(4, 3)]);
        assert.deepEqual(rows.map((r) => [r.name, r.liveDelta, r.countDelta]), [['System.Drawing.Font', 6, 8], ['System.Drawing.SolidBrush', 0, 0]]);
    });

    it('shows a type that is gone with 0, and nothing changed without a baseline', () => {
        assert.deepEqual(diffResources([], [font(2, 2)]).map((r) => [r.count, r.live, r.liveDelta]), [[0, 0, -2]]);
        assert.equal(diffResources([font(2, 1)])[0].liveDelta, 0);
    });

    it('keeps the kind withKinds added', () => {
        const [t] = withKinds([{ name: 'System.Drawing.Icon', count: 1, live: 1, field: 'System.Drawing.Icon._handle' }]);
        assert.equal(diffResources([t])[0].kind, 'USER');
    });
});
