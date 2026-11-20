// The bitness of the process in a crash dump, from minidump bytes made here.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { dumpArchitecture } from '../../dumpInfo';

/** A minidump with a system information stream (the architecture) and a module list of these names. */
function minidump(architecture: number, modules: string[]): Buffer {
    const names = modules.map((m) => Buffer.from(m, 'utf16le'));
    const directoryAt = 32;
    const systemAt = directoryAt + 2 * 12;
    const listAt = systemAt + 4;
    let nameAt = listAt + 4 + modules.length * 108;
    const file = Buffer.alloc(nameAt + names.reduce((n, b) => n + 4 + b.length, 0));
    file.writeUInt32LE(0x504d444d, 0);
    file.writeUInt32LE(2, 8);
    file.writeUInt32LE(directoryAt, 12);
    [[7, 4, systemAt], [4, 4 + modules.length * 108, listAt]].forEach(([kind, size, rva], i) => {
        file.writeUInt32LE(kind, directoryAt + i * 12);
        file.writeUInt32LE(size, directoryAt + i * 12 + 4);
        file.writeUInt32LE(rva, directoryAt + i * 12 + 8);
    });
    file.writeUInt16LE(architecture, systemAt);
    file.writeUInt32LE(modules.length, listAt);
    names.forEach((name, i) => {
        file.writeUInt32LE(nameAt, listAt + 4 + i * 108 + 20);
        file.writeUInt32LE(name.length, nameAt);
        name.copy(file, nameAt + 4);
        nameAt += 4 + name.length;
    });
    return file;
}

const reader = (file: Buffer) => (offset: number, length: number) => file.subarray(offset, offset + length);

describe('dumpArchitecture', () => {
    it('reads a 32-bit dump as x86', () => {
        assert.equal(dumpArchitecture(reader(minidump(0, ['C:\\app\\App.exe']))), 'x86');
    });
    it('reads a 64-bit dump of a 32-bit process (it has wow64.dll) as x86', () => {
        assert.equal(dumpArchitecture(reader(minidump(9, ['C:\\app\\App.exe', 'C:\\Windows\\System32\\wow64.dll']))), 'x86');
    });
    it('reads a 64-bit dump of a 64-bit process as x64', () => {
        assert.equal(dumpArchitecture(reader(minidump(9, ['C:\\app\\App.exe', 'C:\\Windows\\System32\\ntdll.dll']))), 'x64');
    });
    it('does not take other files or processors', () => {
        assert.equal(dumpArchitecture(reader(Buffer.from('not a dump, not a dump, not a dump'))), undefined);
        assert.equal(dumpArchitecture(reader(minidump(12, []))), undefined);
    });
});