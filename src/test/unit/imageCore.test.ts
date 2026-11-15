import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { imageInfoExpressions, pngSize, saveAsPngExpression } from '../../imageCore';

describe('saveAsPngExpression', () => {
    it('saves an Image with forward slashes in the path', () => {
        assert.equal(
            saveAsPngExpression('this.logo', 'System.Drawing.Bitmap', 'C:\\Temp\\img\\a.png'),
            '(this.logo).Save("C:/Temp/img/a.png", System.Drawing.Imaging.ImageFormat.Png)',
        );
    });

    it('turns an Icon into a Bitmap first', () => {
        assert.equal(saveAsPngExpression('icon', 'System.Drawing.Icon', 'C:/t/a.png'), '(icon).ToBitmap().Save("C:/t/a.png", System.Drawing.Imaging.ImageFormat.Png)');
    });
});

describe('imageInfoExpressions', () => {
    it('reads the pixel format and resolution of images, the size of icons', () => {
        assert.deepEqual(Object.keys(imageInfoExpressions('b', 'System.Drawing.Bitmap')), ['Width', 'Height', 'PixelFormat', 'DPI']);
        assert.deepEqual(Object.keys(imageInfoExpressions('i', 'System.Drawing.Icon')), ['Width', 'Height']);
    });
});

describe('pngSize', () => {
    it('reads the size from the IHDR chunk', () => {
        const png = Buffer.from('89504e470d0a1a0a0000000d494844520000007800000050080600000000', 'hex');
        assert.deepEqual(pngSize(png), { width: 120, height: 80 });
    });

    it('rejects bytes that are not a PNG', () => {
        assert.equal(pngSize(Buffer.from('GIF89a................')), undefined);
    });
});
