// Reads the source file paths ("documents") recorded in an assembly's Portable PDB, embedded or next to it.
// Used to map those paths to local files before netcoredbg reports them. Kept free of the vscode module.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { rvaToOffset } from './peInfo';

const DEBUG_DIRECTORY_INDEX = 6;
const CLR_DIRECTORY_INDEX = 14;
const IMAGE_DEBUG_TYPE_CODEVIEW = 2;
const IMAGE_DEBUG_TYPE_EMBEDDED_PORTABLE_PDB = 17;
const HEADER_READ_SIZE = 4096;
const METADATA_SIGNATURE = 0x424a5342; // "BSJB"
const DOCUMENT_TABLE = 0x30;

/**
 * Paths of the source files in the assembly's PDB. Empty when the file is not a managed PE image, has no
 * Portable PDB (none at all, or a Windows PDB), or cannot be read: the caller then simply learns nothing.
 */
export function readPdbDocuments(assemblyPath: string): string[] {
    try {
        const pdb = loadPortablePdb(assemblyPath);
        return pdb ? readDocumentNames(pdb) : [];
    } catch {
        return [];
    }
}

function loadPortablePdb(assemblyPath: string): Buffer | undefined {
    const fd = fs.openSync(assemblyPath, 'r');
    try {
        const header = readAt(fd, 0, HEADER_READ_SIZE);
        const pe = parsePeHeader(header);
        if (!pe || !pe.managed || !pe.debugDirectory) {
            return undefined;
        }
        const dirOffset = rvaToOffset(header, pe.sectionTable, pe.sectionCount, pe.debugDirectory.rva);
        if (dirOffset === undefined) {
            return undefined;
        }
        const dir = readAt(fd, dirOffset, pe.debugDirectory.size);
        let codeViewPath: string | undefined;
        for (let entry = 0; entry + 28 <= dir.length; entry += 28) {
            const type = dir.readUInt32LE(entry + 12);
            const size = dir.readUInt32LE(entry + 16);
            const pointer = dir.readUInt32LE(entry + 24);
            if (size === 0 || pointer === 0) {
                continue;
            }
            const data = readAt(fd, pointer, size);
            // Embedded: "MPDB", uncompressed size, then the PDB deflated.
            if (type === IMAGE_DEBUG_TYPE_EMBEDDED_PORTABLE_PDB && data.length > 8 && data.toString('latin1', 0, 4) === 'MPDB') {
                return zlib.inflateRawSync(data.subarray(8));
            }
            // CodeView: "RSDS", GUID, age, then the PDB path the compiler wrote.
            if (type === IMAGE_DEBUG_TYPE_CODEVIEW && data.length > 24 && data.toString('latin1', 0, 4) === 'RSDS') {
                const end = data.indexOf(0, 24);
                codeViewPath = data.toString('utf8', 24, end < 0 ? data.length : end);
            }
        }
        return readSidePdb(assemblyPath, codeViewPath);
    } finally {
        fs.closeSync(fd);
    }
}

/** The PDB next to the assembly first (that is where netcoredbg looks too), then the path recorded at build time. */
function readSidePdb(assemblyPath: string, codeViewPath: string | undefined): Buffer | undefined {
    const dir = path.dirname(assemblyPath);
    const candidates = [path.join(dir, `${path.parse(assemblyPath).name}.pdb`)];
    if (codeViewPath) {
        candidates.push(path.join(dir, path.win32.basename(codeViewPath)), codeViewPath);
    }
    for (const candidate of candidates) {
        let buf: Buffer;
        try {
            buf = fs.readFileSync(candidate);
        } catch {
            continue;
        }
        // A Windows PDB ("Microsoft C/C++ MSF") has no metadata root; netcoredbg cannot read it either.
        if (buf.length >= 4 && buf.readUInt32LE(0) === METADATA_SIGNATURE) {
            return buf;
        }
    }
    return undefined;
}

interface PeHeader {
    managed: boolean;
    sectionTable: number;
    sectionCount: number;
    debugDirectory?: { rva: number; size: number };
}

function parsePeHeader(buf: Buffer): PeHeader | undefined {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
        return undefined;
    }
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
        return undefined;
    }
    const coff = peOffset + 4;
    const sectionCount = buf.readUInt16LE(coff + 2);
    const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
    const opt = coff + 20;
    // AnyCPU / x86 assemblies are PE32; x64-only ones PE32+, whose data directories start 16 bytes later.
    const magic = buf.readUInt16LE(opt);
    const dataDirectories = opt + (magic === 0x20b ? 112 : 96);
    const directory = (index: number) => {
        const at = dataDirectories + index * 8;
        if (at + 8 > opt + sizeOfOptionalHeader || at + 8 > buf.length) {
            return undefined;
        }
        const rva = buf.readUInt32LE(at);
        const size = buf.readUInt32LE(at + 4);
        return rva && size ? { rva, size } : undefined;
    };
    return {
        managed: directory(CLR_DIRECTORY_INDEX) !== undefined,
        sectionTable: opt + sizeOfOptionalHeader,
        sectionCount,
        debugDirectory: directory(DEBUG_DIRECTORY_INDEX),
    };
}

/** Document table names of a Portable PDB (ECMA-335 metadata with the Portable PDB tables). */
function readDocumentNames(pdb: Buffer): string[] {
    if (pdb.readUInt32LE(0) !== METADATA_SIGNATURE) {
        return [];
    }
    const versionLength = pdb.readUInt32LE(12);
    let at = 16 + versionLength + 2; // + flags
    const streamCount = pdb.readUInt16LE(at);
    at += 2;
    const streams = new Map<string, { offset: number; size: number }>();
    for (let i = 0; i < streamCount; i++) {
        const offset = pdb.readUInt32LE(at);
        const size = pdb.readUInt32LE(at + 4);
        const nameEnd = pdb.indexOf(0, at + 8);
        const name = pdb.toString('latin1', at + 8, nameEnd);
        streams.set(name, { offset, size });
        at = (nameEnd + 1 + 3) & ~3; // names are padded to 4 bytes
    }
    const tables = streams.get('#~');
    const blob = streams.get('#Blob');
    if (!tables || !blob) {
        return [];
    }

    const heapSizes = pdb.readUInt8(tables.offset + 6);
    const valid = pdb.readBigUInt64LE(tables.offset + 8);
    if (((valid >> BigInt(DOCUMENT_TABLE)) & 1n) === 0n) {
        return [];
    }
    // Row counts follow for every present table; a standalone PDB has no tables before Document (0x30),
    // so Document's rows start right after the counts.
    let rowCountsAt = tables.offset + 24;
    let presentBefore = 0;
    for (let t = 0; t < DOCUMENT_TABLE; t++) {
        if ((valid >> BigInt(t)) & 1n) {
            presentBefore++;
        }
    }
    if (presentBefore > 0) {
        return []; // Not a standalone PDB layout.
    }
    let present = 0;
    for (let t = 0; t < 64; t++) {
        if ((valid >> BigInt(t)) & 1n) {
            present++;
        }
    }
    const documentRows = pdb.readUInt32LE(rowCountsAt);
    rowCountsAt += present * 4;

    const blobIndexSize = heapSizes & 0x04 ? 4 : 2;
    const guidIndexSize = heapSizes & 0x02 ? 4 : 2;
    const rowSize = blobIndexSize * 2 + guidIndexSize * 2; // Name, HashAlgorithm, Hash, Language
    const readIndex = (offset: number, size: number) => (size === 4 ? pdb.readUInt32LE(offset) : pdb.readUInt16LE(offset));

    const names: string[] = [];
    for (let row = 0; row < documentRows; row++) {
        const nameBlob = readIndex(rowCountsAt + row * rowSize, blobIndexSize);
        const name = readDocumentName(pdb, blob.offset, nameBlob);
        if (name) {
            names.push(name);
        }
    }
    return names;
}

/** A document name blob: a separator character, then blob indexes of the UTF-8 parts between separators. */
function readDocumentName(pdb: Buffer, blobHeap: number, index: number): string {
    const { value: length, next } = readCompressed(pdb, blobHeap + index);
    const end = next + length;
    if (length === 0) {
        return '';
    }
    const separator = pdb.readUInt8(next);
    const parts: string[] = [];
    let at = next + 1;
    while (at < end) {
        const part = readCompressed(pdb, at);
        at = part.next;
        if (part.value === 0) {
            parts.push('');
            continue;
        }
        const partBlob = readCompressed(pdb, blobHeap + part.value);
        parts.push(pdb.toString('utf8', partBlob.next, partBlob.next + partBlob.value));
    }
    return parts.join(separator ? String.fromCharCode(separator) : '');
}

/** ECMA-335 compressed unsigned integer (1, 2 or 4 bytes). */
function readCompressed(buf: Buffer, at: number): { value: number; next: number } {
    const b = buf.readUInt8(at);
    if ((b & 0x80) === 0) {
        return { value: b, next: at + 1 };
    }
    if ((b & 0xc0) === 0x80) {
        return { value: ((b & 0x3f) << 8) | buf.readUInt8(at + 1), next: at + 2 };
    }
    return { value: ((b & 0x1f) << 24) | (buf.readUInt8(at + 1) << 16) | (buf.readUInt8(at + 2) << 8) | buf.readUInt8(at + 3), next: at + 4 };
}

function readAt(fd: number, position: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, position);
    return buf.subarray(0, read);
}
