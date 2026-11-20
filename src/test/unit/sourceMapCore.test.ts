import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, describe, it } from 'node:test';
import { pathKey, SourcePathMapper } from '../../sourceMapCore';

describe('pathKey', () => {
    it('ignores case and slash direction', () => {
        assert.equal(pathKey('C:/Src/A.cs'), pathKey('c:\\src\\a.cs'));
    });
});

describe('SourcePathMapper with sourceFileMap', () => {
    const mapper = new SourcePathMapper({
        sourceFileMap: { 'C:\\build\\Lib': 'D:\\work\\Lib', '/_/': 'D:\\work\\Det\\', 'C:\\build\\Lib\\Sub': 'E:\\sub' },
        fileExists: () => false,
    });

    it('replaces the longest matching prefix', () => {
        assert.equal(mapper.toLocal('C:\\build\\Lib\\A.cs'), 'D:\\work\\Lib\\A.cs');
        assert.equal(mapper.toLocal('C:\\build\\Lib\\Sub\\B.cs'), 'E:\\sub\\B.cs');
    });

    it('handles deterministic "/_/" paths', () => {
        assert.equal(mapper.toLocal('/_/Folder/C.cs'), 'D:\\work\\Det\\Folder\\C.cs');
    });

    it('matches whole path segments only', () => {
        assert.equal(mapper.toLocal('C:\\build\\Library\\A.cs'), 'C:\\build\\Library\\A.cs');
    });

    it('maps local paths back to the PDB style', () => {
        assert.equal(mapper.toDebugger('d:\\WORK\\lib\\x\\A.cs'), 'C:\\build\\Lib\\x\\A.cs');
        assert.equal(mapper.toDebugger('D:\\work\\Det\\Folder\\C.cs'), '/_/Folder/C.cs');
    });

    it('leaves unrelated paths alone', () => {
        assert.equal(mapper.toDebugger('F:\\other\\A.cs'), 'F:\\other\\A.cs');
    });
});

describe('SourcePathMapper with sourceSearchPaths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetx86-map-'));
    const write = (relative: string) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
        return file;
    };
    const calc = write('repo\\MyLib\\Sub\\Calc.cs');
    const copyA = write('a\\Shared\\Util.cs');
    const copyB = write('b\\Shared\\Util.cs');
    write('repo\\MyLib\\obj\\Debug\\Calc.cs'); // obj is never searched
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    it('finds the file whose trailing folders match best', () => {
        const mapper = new SourcePathMapper({ sourceSearchPaths: [root] });
        assert.equal(mapper.toLocal('C:\\agent\\_work\\3\\s\\MyLib\\Sub\\Calc.cs'), calc);
        assert.equal(mapper.toDebugger(calc), 'C:\\agent\\_work\\3\\s\\MyLib\\Sub\\Calc.cs');
    });

    it('does not guess between equally good matches', () => {
        const mapper = new SourcePathMapper({ sourceSearchPaths: [root] });
        assert.equal(mapper.toLocal('C:\\x\\Shared\\Util.cs'), 'C:\\x\\Shared\\Util.cs');
        assert.deepEqual(mapper.unresolved('C:\\x\\Shared\\Util.cs')?.candidates.sort(), [copyA, copyB].sort());
    });

    it('reports which local files changed their debugger-side path when documents are learned', () => {
        const mapper = new SourcePathMapper({ sourceSearchPaths: [root] });
        const changed = mapper.addDocuments(['C:\\agent\\MyLib\\Sub\\Calc.cs']);
        assert.deepEqual(changed, [{ local: calc, previous: calc, pdbPath: 'C:\\agent\\MyLib\\Sub\\Calc.cs' }]);
        assert.deepEqual(mapper.addDocuments(['C:\\agent\\MyLib\\Sub\\Calc.cs']), []);
    });

    it('rewrites paths inside text such as stack traces', () => {
        const mapper = new SourcePathMapper({ sourceSearchPaths: [root] });
        mapper.addDocuments(['C:\\agent\\MyLib\\Sub\\Calc.cs']);
        assert.equal(mapper.rewriteText('at Calc.Add() in C:\\agent\\MyLib\\Sub\\Calc.cs:line 6'), `at Calc.Add() in ${calc}:line 6`);
    });

    it('stops indexing at the file limit and says so', () => {
        const mapper = new SourcePathMapper({ sourceSearchPaths: [root], maxIndexedFiles: 1 });
        mapper.toLocal('C:\\nowhere\\Calc.cs');
        assert.equal(mapper.truncated, true);
    });
});

describe('SourcePathMapper with exact file pairs', () => {
    it('maps relative PDB document names both ways', () => {
        const mapper = new SourcePathMapper();
        assert.equal(mapper.enabled, false);
        mapper.addFilePairs([{ pdbPath: 'Lib\\Type.cs', local: 'C:\\cache\\guid\\src\\Lib\\Type.cs' }]);
        assert.equal(mapper.enabled, true);
        assert.equal(mapper.toLocal('Lib\\Type.cs'), 'C:\\cache\\guid\\src\\Lib\\Type.cs');
        assert.equal(mapper.toDebugger('c:\\cache\\guid\\src\\lib\\type.cs'), 'Lib\\Type.cs');
    });
});
