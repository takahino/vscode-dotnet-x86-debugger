// PE headers and the Source Link map in a PDB, from bytes and files made here
// (no build, no debugger).

import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { findSourceLinkJson } from '../../pdbDocuments';
import { engineArchitecture, inspectPe, rvaToOffset } from '../../peInfo';

const PE_OFFSET = 0x80;
const OPT = PE_OFFSET + 24;
const OPT_SIZE = 224; // PE32 optional header with 16 data directories
const SECTIONS = OPT + OPT_SIZE;
const TEXT_RVA = 0x2000;
const TEXT_RAW = 0x400;
const CLR_HEADER_RVA = TEXT_RVA + 0x8;

interface PeShape {
    machine?: number;
    dll?: boolean;
    magic?: number;
    /** Undefined: a native image (no CLR header). */
    clrFlags?: number;
}

/** A minimal PE image: DOS header, PE header, PE32 optional header, one .text section holding the CLR header. */
function pe(shape: PeShape): Buffer {
    const buf = Buffer.alloc(0x600);
    buf.writeUInt16LE(0x5a4d, 0); // "MZ"
    buf.writeUInt32LE(PE_OFFSET, 0x3c);
    buf.writeUInt32LE(0x00004550, PE_OFFSET); // "PE\0\0"
    const coff = PE_OFFSET + 4;
    buf.writeUInt16LE(shape.machine ?? 0x014c, coff);
    buf.writeUInt16LE(1, coff + 2); // sections
    buf.writeUInt16LE(OPT_SIZE, coff + 16);
    buf.writeUInt16LE(shape.dll ? 0x2000 : 0, coff + 18);
    buf.writeUInt16LE(shape.magic ?? 0x10b, OPT);
    if (shape.clrFlags !== undefined) {
        buf.writeUInt32LE(CLR_HEADER_RVA, OPT + 96 + 14 * 8);
        buf.writeUInt32LE(72, OPT + 96 + 14 * 8 + 4);
        buf.writeUInt32LE(shape.clrFlags, TEXT_RAW + (CLR_HEADER_RVA - TEXT_RVA) + 16);
    }
    // .text: virtual size, virtual address, raw size, raw pointer
    buf.writeUInt32LE(0x200, SECTIONS + 8);
    buf.writeUInt32LE(TEXT_RVA, SECTIONS + 12);
    buf.writeUInt32LE(0x200, SECTIONS + 16);
    buf.writeUInt32LE(TEXT_RAW, SECTIONS + 20);
    return buf;
}

describe('inspectPe', () => {
    let dir: string;
    const write = (name: string, bytes: Buffer) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, bytes);
        return file;
    };
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetx86-pe-'));
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('tells an x86 managed assembly (32BITREQUIRED) from an AnyCPU one', () => {
        assert.deepEqual(inspectPe(write('x86.dll', pe({ dll: true, clrFlags: 0x1 | 0x2 }))), { bitness: 'x86', managed: true });
        assert.deepEqual(inspectPe(write('any.dll', pe({ dll: true, clrFlags: 0x1 }))), { bitness: 'anycpu', managed: true });
    });

    it('runs an exe with "Prefer 32-bit" as x86, but not a dll (it takes its host\'s bitness)', () => {
        const preferred = 0x1 | 0x20000;
        assert.equal(inspectPe(write('pref.exe', pe({ clrFlags: preferred }))).bitness, 'x86');
        assert.equal(inspectPe(write('pref.dll', pe({ dll: true, clrFlags: preferred }))).bitness, 'anycpu');
    });

    it('sees a native x86 image (the apphost) and a 64-bit image', () => {
        assert.deepEqual(inspectPe(write('apphost.exe', pe({}))), { bitness: 'x86', managed: false });
        assert.deepEqual(inspectPe(write('x64.exe', pe({ machine: 0x8664 }))), { bitness: 'x64', managed: false });
    });

    it('sees a .NET Framework exe built for x64 (PE32+ with a CLR header) as managed', () => {
        const image = pe({ machine: 0x8664, magic: 0x20b });
        image.writeUInt16LE(240, PE_OFFSET + 4 + 16); // PE32+ optional header with 16 data directories
        image.writeUInt32LE(CLR_HEADER_RVA, OPT + 112 + 14 * 8);
        assert.deepEqual(inspectPe(write('framework-x64.exe', image)), { bitness: 'x64', managed: true });
    });

    it('picks the engine of the bitness the program runs as', () => {
        assert.equal(engineArchitecture('x86'), 'x86');
        assert.equal(engineArchitecture('x64'), 'x64');
        assert.equal(engineArchitecture('anycpu'), 'x64');
        assert.equal(engineArchitecture('unknown'), 'x86');
    });

    it('does not guess for what is not a readable PE32 image', () => {
        const unknown = { bitness: 'unknown', managed: false };
        assert.deepEqual(inspectPe(path.join(dir, 'missing.dll')), unknown);
        assert.deepEqual(inspectPe(write('text.dll', Buffer.from('not a program'))), unknown);
        const noPe = pe({});
        noPe.writeUInt32LE(0, PE_OFFSET);
        assert.deepEqual(inspectPe(write('nope.dll', noPe)), unknown);
        assert.deepEqual(inspectPe(write('pe32plus.dll', pe({ magic: 0x20b, clrFlags: 1 }))), unknown);
    });
});

describe('rvaToOffset', () => {
    it('maps an RVA inside a section to its file offset, and nothing outside', () => {
        const buf = pe({});
        assert.equal(rvaToOffset(buf, SECTIONS, 1, TEXT_RVA + 0x10), TEXT_RAW + 0x10);
        assert.equal(rvaToOffset(buf, SECTIONS, 1, TEXT_RVA - 1), undefined);
        assert.equal(rvaToOffset(buf, SECTIONS, 1, TEXT_RVA + 0x200), undefined);
        // A section table that runs past the end of the file is not read.
        assert.equal(rvaToOffset(buf, buf.length - 10, 1, TEXT_RVA), undefined);
    });
});


describe('findSourceLinkJson', () => {
    const map = '{"documents":{"C:\\\\src\\\\*":"https://raw.githubusercontent.com/o/r/abc/*","x":"a \\"}\\" b"}}';

    it('reads the map out of the PDB bytes, up to its closing brace (braces in strings do not count)', () => {
        const pdb = Buffer.concat([Buffer.from([0x42, 0x53, 0x4a, 0x42, 0, 0, 7]), Buffer.from(map, 'utf8'), Buffer.from([0, 0, 0x7d, 0x7d])]);
        assert.equal(findSourceLinkJson(pdb), map);
        assert.deepEqual(Object.keys(JSON.parse(findSourceLinkJson(pdb)!).documents), ['C:\\src\\*', 'x']);
    });

    it('finds nothing in a PDB without Source Link, or with a cut map', () => {
        assert.equal(findSourceLinkJson(Buffer.from('BSJB no map here')), undefined);
        assert.equal(findSourceLinkJson(Buffer.from('{"documents":{"a":"b"', 'utf8')), undefined);
    });
});
