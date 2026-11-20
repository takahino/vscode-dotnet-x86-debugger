import * as fs from 'fs';

/**
 * Bitness of the process in a crash dump (.dmp), which decides the engine that opens it: the engine's DAC must match the
 * process. A 32-bit process written by a 64-bit tool (Task Manager, WER, 64-bit procdump) gives a 64-bit dump that still
 * holds a 32-bit process (WOW64): its module list has wow64.dll. Reads the header, the stream directory, the system
 * information and the module names only (a dump can be several GB).
 */
export function dumpArchitecture(read: (offset: number, length: number) => Buffer): 'x86' | 'x64' | undefined {
    const SIGNATURE = 0x504d444d; // "MDMP"
    const MODULE_LIST = 4;
    const SYSTEM_INFO = 7;
    const header = read(0, 32);
    if (header.length < 32 || header.readUInt32LE(0) !== SIGNATURE) {
        return undefined;
    }
    const count = header.readUInt32LE(8);
    const directory = read(header.readUInt32LE(12), count * 12);
    let architecture: number | undefined;
    let modules: string[] = [];
    for (let i = 0; i + 12 <= directory.length; i += 12) {
        const [kind, size, rva] = [directory.readUInt32LE(i), directory.readUInt32LE(i + 4), directory.readUInt32LE(i + 8)];
        if (kind === SYSTEM_INFO && size >= 2) {
            architecture = read(rva, 2).readUInt16LE(0);
        } else if (kind === MODULE_LIST && size >= 4) {
            modules = moduleNames(read, read(rva, size));
        }
    }
    if (architecture === 0) {
        return 'x86';
    }
    if (architecture === 9) {
        return modules.some((m) => /(^|[\\/])wow64\.dll$/i.test(m)) ? 'x86' : 'x64';
    }
    return undefined;
}

/** MINIDUMP_MODULE_LIST: a count, then 108-byte entries whose ModuleNameRva (+20) points at a length and UTF-16 text. */
function moduleNames(read: (offset: number, length: number) => Buffer, list: Buffer): string[] {
    const names: string[] = [];
    const count = list.readUInt32LE(0);
    for (let i = 0; i < count && 4 + (i + 1) * 108 <= list.length; i++) {
        const rva = list.readUInt32LE(4 + i * 108 + 20);
        const length = read(rva, 4).readUInt32LE(0);
        names.push(read(rva + 4, length).toString('utf16le'));
    }
    return names;
}

/** `dumpArchitecture` of a file. */
export function readDumpArchitecture(filePath: string): 'x86' | 'x64' | undefined {
    const fd = fs.openSync(filePath, 'r');
    try {
        return dumpArchitecture((offset, length) => {
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, offset);
            return buffer.subarray(0, read);
        });
    } catch {
        return undefined;
    } finally {
        fs.closeSync(fd);
    }
}