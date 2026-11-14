import * as fs from 'fs';

/** How the image will run when started on 64-bit Windows. */
export type Bitness = 'x86' | 'x64' | 'anycpu' | 'unknown';

export interface PeInfo {
    bitness: Bitness;
    /** True when the image has a CLR header (a managed assembly, not an apphost). */
    managed: boolean;
}

const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_DLL = 0x2000;
const PE32_MAGIC = 0x10b;
const CLR_DIRECTORY_INDEX = 14;
const COMIMAGE_FLAGS_32BITREQUIRED = 0x2;
const COMIMAGE_FLAGS_32BITPREFERRED = 0x20000;

/**
 * Reads the PE header to decide whether the image runs as a 32-bit process.
 * AnyCPU managed images report 'anycpu' (exe without "Prefer 32-bit" runs as 64-bit;
 * a dll takes the bitness of its host).
 */
export function inspectPe(filePath: string): PeInfo {
    const unknown: PeInfo = { bitness: 'unknown', managed: false };
    let buf: Buffer;
    try {
        buf = fs.readFileSync(filePath);
    } catch {
        return unknown;
    }
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
        return unknown;
    }
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
        return unknown;
    }

    const coff = peOffset + 4;
    const machine = buf.readUInt16LE(coff);
    if (machine !== IMAGE_FILE_MACHINE_I386) {
        return { bitness: 'x64', managed: false };
    }
    const numberOfSections = buf.readUInt16LE(coff + 2);
    const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
    const isDll = (buf.readUInt16LE(coff + 18) & IMAGE_FILE_DLL) !== 0;

    const opt = coff + 20;
    // PE32+ with an i386 machine type does not exist in practice; treat it as unknown.
    if (buf.readUInt16LE(opt) !== PE32_MAGIC) {
        return unknown;
    }
    const dataDirectories = opt + 96;
    const clrDir = dataDirectories + CLR_DIRECTORY_INDEX * 8;
    if (clrDir + 8 > opt + sizeOfOptionalHeader) {
        return { bitness: 'x86', managed: false };
    }
    const clrRva = buf.readUInt32LE(clrDir);
    if (clrRva === 0) {
        // Native image (e.g. the x86 apphost of a .NET app).
        return { bitness: 'x86', managed: false };
    }

    const clrOffset = rvaToOffset(buf, opt + sizeOfOptionalHeader, numberOfSections, clrRva);
    if (clrOffset === undefined || clrOffset + 20 > buf.length) {
        return unknown;
    }
    const flags = buf.readUInt32LE(clrOffset + 16);
    const is32Bit = (flags & COMIMAGE_FLAGS_32BITREQUIRED) !== 0 || (!isDll && (flags & COMIMAGE_FLAGS_32BITPREFERRED) !== 0);
    return { bitness: is32Bit ? 'x86' : 'anycpu', managed: true };
}

/** File offset of an RVA, from the section table at `sectionTable` (`count` entries); undefined outside every section. */
export function rvaToOffset(buf: Buffer, sectionTable: number, count: number, rva: number): number | undefined {
    for (let i = 0; i < count; i++) {
        const s = sectionTable + i * 40;
        if (s + 40 > buf.length) {
            return undefined;
        }
        const virtualSize = buf.readUInt32LE(s + 8);
        const virtualAddress = buf.readUInt32LE(s + 12);
        const rawSize = buf.readUInt32LE(s + 16);
        const rawPointer = buf.readUInt32LE(s + 20);
        if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
            return rva - virtualAddress + rawPointer;
        }
    }
    return undefined;
}
