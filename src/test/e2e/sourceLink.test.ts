// E2E: Source Link and symbol servers, against a local HTTP server (port 43117, as LinkedLib's Source Link map says):
// /linked/<path> serves test/apps/LinkedLib, /symbols/<SSQP key> serves LinkedLib's PDB.

import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { SYMBOL_DIRS_ENV } from '../../symbolDirs';
import { readAssemblyIdentity } from '../../pdbDocuments';
import { sourceCachePath, symbolServerUrl } from '../../sourceLinkCore';
import { downloadSymbols } from '../../symbolDownload';
import { DapSession, REPO, appSource, buildApp, e2eSkip, lineOf } from './harness';

const PORT = 43117;
const SERVER = `http://127.0.0.1:${PORT}`;
const AREA_CS = path.join(REPO, 'test', 'apps', 'LinkedLib', 'Shapes', 'Area.cs');

describe('Source Link and symbol servers', { skip: e2eSkip }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetx86-sourcelink-'));
    const requests: string[] = [];
    let server: http.Server;
    let program = '';
    let pdb: Buffer;
    let symbolPath = '';
    const sessions: DapSession[] = [];
    const programCs = appSource('Basic', 'Program.cs');

    before(async () => {
        const dir = buildApp('Basic');
        program = path.join(dir, 'Basic.exe');
        pdb = fs.readFileSync(path.join(dir, 'LinkedLib.pdb'));
        const codeView = readAssemblyIdentity(path.join(dir, 'LinkedLib.dll'))!.codeView!;
        symbolPath = new URL(symbolServerUrl(`${SERVER}/symbols`, codeView.pdbName, codeView.guid)).pathname;
        server = http.createServer((req, res) => {
            requests.push(req.url ?? '');
            const url = decodeURIComponent(req.url ?? '');
            if (url.startsWith('/linked/')) {
                const file = path.join(REPO, 'test', 'apps', 'LinkedLib', ...url.slice('/linked/'.length).split('/'));
                if (fs.existsSync(file)) {
                    res.end(fs.readFileSync(file));
                    return;
                }
            } else if (url === symbolPath) {
                res.end(pdb);
                return;
            }
            res.statusCode = 404;
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    });
    after(async () => {
        for (const s of sessions) {
            await s.close();
        }
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    /** Steps from Program.cs into LinkedLib's Area.Circle; resolves with the frame it arrives at. */
    const stepIntoLinked = async (s: DapSession, exe: string) => {
        sessions.push(s);
        const first = s.nextStop();
        await s.launch(exe, { [programCs]: [{ line: lineOf(programCs, 'call-linked') }] });
        const stop = await first;
        const stepped = s.nextStop();
        await s.request('stepIn', { threadId: stop.body.threadId });
        return s.topFrame((await stepped).body.threadId);
    };

    it('downloads the source of a stop through the PDB\'s Source Link map', { timeout: 120_000 }, async () => {
        const cacheRoot = path.join(temp, 'sources-a');
        const frame = await stepIntoLinked(new DapSession({ sourceLink: { cacheRoot } }), program);
        assert.match(frame.name, /LinkedLib\.Shapes\.Area\.Circle\(/);
        const expected = sourceCachePath(cacheRoot, `${SERVER}/linked/Shapes/Area.cs`);
        assert.equal(frame.source.path.toLowerCase(), expected.toLowerCase());
        assert.equal(fs.readFileSync(expected, 'utf8'), fs.readFileSync(AREA_CS, 'utf8'));
        assert.ok(requests.includes('/linked/Shapes/Area.cs'));
    });

    it('downloads the PDB of an assembly without symbols from a symbol server, then its source', { timeout: 120_000 }, async () => {
        // A copy of the app whose LinkedLib.pdb is gone, as with a NuGet package that ships no symbols.
        const appDir = path.join(temp, 'app');
        fs.cpSync(path.dirname(program), appDir, { recursive: true });
        fs.rmSync(path.join(appDir, 'LinkedLib.pdb'));
        const symbolCache = path.join(temp, 'symbols');
        const result = await downloadSymbols(path.join(appDir, 'LinkedLib.dll'), [`${SERVER}/nothing-here`, `${SERVER}/symbols`], symbolCache);
        assert.equal(result.ok, true, JSON.stringify(result));

        const cacheRoot = path.join(temp, 'sources-b');
        const s = new DapSession({ sourceLink: { cacheRoot }, symbolDirs: [symbolCache], env: { [SYMBOL_DIRS_ENV]: symbolCache } });
        const frame = await stepIntoLinked(s, path.join(appDir, 'Basic.exe'));
        assert.match(frame.name, /LinkedLib\.Shapes\.Area\.Circle\(/);
        assert.ok(fs.existsSync(frame.source.path), frame.source.path);
        const module = s.events.find((e) => e.event === 'module' && /LinkedLib\.dll$/i.test(e.body.module.path ?? ''));
        assert.equal(module?.body.module.symbolStatus, 'Symbols loaded.');
    });

    it('says why when no symbol server has the PDB', { timeout: 60_000 }, async () => {
        const result = await downloadSymbols(path.join(path.dirname(program), 'LinkedLib.dll'), [`${SERVER}/nothing-here`], path.join(temp, 'none'));
        assert.deepEqual({ ok: result.ok, reason: !result.ok && result.reason }, { ok: false, reason: 'not-found' });
        const noPdb = await downloadSymbols(path.join(path.dirname(program), 'NoPdbLib.dll'), [`${SERVER}/symbols`], path.join(temp, 'none'));
        assert.equal(!noPdb.ok && noPdb.reason, 'no-pdb-info');
    });
});
