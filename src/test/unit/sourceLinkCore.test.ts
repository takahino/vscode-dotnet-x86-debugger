import * as assert from 'assert/strict';
import * as path from 'path';
import { describe, it } from 'node:test';
import { parseSourceLink, resolveSourceLink, sourceCachePath, symbolServerUrl } from '../../sourceLinkCore';

describe('parseSourceLink', () => {
    it('reads the document map, and nothing from broken JSON', () => {
        assert.deepEqual(parseSourceLink('{"documents":{"C:\\\\src\\\\*":"https://raw.example.com/r/abc/*"}}'), [{ key: 'C:\\src\\*', url: 'https://raw.example.com/r/abc/*' }]);
        assert.deepEqual(parseSourceLink('{"documents":'), []);
        assert.deepEqual(parseSourceLink('{"other":1}'), []);
    });
});

describe('resolveSourceLink', () => {
    const map = parseSourceLink(JSON.stringify({
        documents: {
            'C:\\agent\\_work\\1\\s\\*': 'https://raw.githubusercontent.com/org/repo/0123abc/*',
            'C:\\agent\\_work\\1\\s\\external\\lib\\*': 'https://raw.githubusercontent.com/other/lib/9f9f/*',
            'C:\\gen\\Version.cs': 'https://example.com/version.cs',
            '/_/*': 'https://raw.githubusercontent.com/org/det/beef/*',
        },
    }));

    it('replaces the wildcard with the rest of the path, with forward slashes', () => {
        assert.equal(resolveSourceLink(map, 'C:\\agent\\_work\\1\\s\\src\\Lib\\Calc.cs'), 'https://raw.githubusercontent.com/org/repo/0123abc/src/Lib/Calc.cs');
    });

    it('takes the longest matching key, ignoring case', () => {
        assert.equal(resolveSourceLink(map, 'c:\\AGENT\\_work\\1\\s\\external\\lib\\X.cs'), 'https://raw.githubusercontent.com/other/lib/9f9f/X.cs');
    });

    it('matches keys without a wildcard exactly', () => {
        assert.equal(resolveSourceLink(map, 'C:\\gen\\Version.cs'), 'https://example.com/version.cs');
        assert.equal(resolveSourceLink(map, 'C:\\gen\\Other.cs'), undefined);
    });

    it('handles deterministic paths and escapes what URLs cannot hold', () => {
        assert.equal(resolveSourceLink(map, '/_/src/My File#1.cs'), 'https://raw.githubusercontent.com/org/det/beef/src/My%20File%231.cs');
    });
});

describe('sourceCachePath', () => {
    it('keeps downloaded files by host and URL path', () => {
        assert.equal(
            sourceCachePath('C:\\cache', 'https://raw.githubusercontent.com/org/repo/0123abc/src/My%20File.cs?token=x'),
            path.join('C:\\cache', 'raw.githubusercontent.com', 'org', 'repo', '0123abc', 'src', 'My File.cs'),
        );
    });

    it('never leaves the cache folder', () => {
        for (const url of ['https://h/a/%2e%2e/%2e%2e/x.cs', 'https://h/a/..%5c..%5cx.cs', 'https://h/a/%2e%2e%5cx.cs']) {
            const file = sourceCachePath('C:\\cache', url);
            assert.ok(file.startsWith(path.join('C:\\cache', 'h') + path.sep), `${url} -> ${file}`);
        }
    });
});

describe('symbolServerUrl', () => {
    it('builds the SSQP key of a Portable PDB (GUID + FFFFFFFF, lower case)', () => {
        assert.equal(
            symbolServerUrl('https://symbols.nuget.org/download/symbols/', 'XUnit.Assert.pdb', 'dd42d316-6d63-4063-b47d-baafa5857546'),
            'https://symbols.nuget.org/download/symbols/xunit.assert.pdb/dd42d3166d634063b47dbaafa5857546ffffffff/xunit.assert.pdb',
        );
    });
});
