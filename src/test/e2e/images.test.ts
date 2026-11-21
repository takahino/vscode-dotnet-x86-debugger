// E2E: "View as Image" makes the debuggee save Image / Bitmap / Icon variables as PNG.

import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { pngSize, saveAsPngExpression } from '../../imageCore';
import { DapSession, appSource, buildApp, e2eSkip, lineOf } from './harness';

describe('View as Image', { skip: e2eSkip || (process.env.DOTNETX86_SKIP_UI_TESTS ? 'DOTNETX86_SKIP_UI_TESTS is set' : false) }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetx86-images-'));
    let s: DapSession;
    let frameId = 0;

    before(async () => {
        const program = path.join(buildApp('Images'), 'Images.exe');
        const source = appSource('Images', 'Program.cs');
        s = new DapSession();
        const first = s.nextStop();
        await s.launch(program, { [source]: [{ line: lineOf(source, 'images') }] });
        frameId = (await s.topFrame((await first).body.threadId)).id;
    });
    after(async () => {
        await s?.close();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    for (const [variable, typeName, size] of [
        ['bitmap', 'System.Drawing.Bitmap', { width: 120, height: 80 }],
        ['image', 'System.Drawing.Bitmap', { width: 120, height: 80 }],
        ['icon', 'System.Drawing.Icon', { width: 32, height: 32 }],
    ] as const) {
        it(`saves ${variable} as a PNG of its size`, { timeout: 60_000 }, async () => {
            const png = path.join(dir, `${variable}.png`);
            const r = await s.evaluate(saveAsPngExpression(variable, typeName, png), frameId);
            assert.equal(r.success, true, r.message);
            assert.deepEqual(pngSize(fs.readFileSync(png)), size);
        });
    }
});
