// Reads what an assembly's Portable PDB records (source file paths, the Source Link map), embedded, next to it or in
// a symbol cache, and the assembly's identity (MVID, PDB id) for symbol servers. Kept free of the vscode module.

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
export function readPdbDocuments(assemblyPath: string, symbolDirs: string[] = []): string[] {
    return readPdbInfo(assemblyPath, symbolDirs).documents;
}

/**
 * The documents and the Source Link map (JSON) of the assembly's PDB: from `<symbolDir>/<MVID>/symbols.pdb` first
 * (symbols downloaded or generated for it, as netcoredbg patch 0009 looks there too), then embedded or next to it.
 */
export function readPdbInfo(assemblyPath: string, symbolDirs: string[] = []): { documents: string[]; sourceLink?: string } {
    try {
        const pdb = loadFromSymbolDirs(assemblyPath, symbolDirs) ?? loadPortablePdb(assemblyPath);
        return pdb ? { documents: readDocumentNames(pdb), sourceLink: findSourceLinkJson(pdb) } : { documents: [] };
    } catch {
        return { documents: [] };
    }
}

function loadFromSymbolDirs(assemblyPath: string, symbolDirs: string[]): Buffer | undefined {
    if (symbolDirs.length === 0) {
        return undefined;
    }
    const mvid = readAssemblyIdentity(assemblyPath)?.mvid;
    for (const dir of mvid ? symbolDirs : []) {
        try {
            const buf = fs.readFileSync(path.join(dir, mvid!, 'symbols.pdb'));
            if (buf.length >= 4 && buf.readUInt32LE(0) === METADATA_SIGNATURE) {
                return buf;
            }
        } catch {
            // not in this folder
        }
    }
    return undefined;
}

/**
 * The Source Link map stored in the PDB (custom debug information, UTF-8 JSON in the blob heap). Found by its
 * opening `{"documents"` rather than through the custom debug information table, which would need the row sizes of
 * every Portable PDB table; the JSON is read up to its matching closing brace.
 */
export function findSourceLinkJson(pdb: Buffer): string | undefined {
    const start = pdb.indexOf('{"documents"', 0, 'utf8');
    if (start < 0) {
        return undefined;
    }
    let depth = 0;
    let inString = false;
    for (let i = start; i < pdb.length; i++) {
        const c = pdb[i];
        if (inString) {
            if (c === 0x5c) {
                i++; // escaped character
            } else if (c === 0x22) {
                inString = false;
            }
        } else if (c === 0x22) {
            inString = true;
        } else if (c === 0x7b) {
            depth++;
        } else if (c === 0x7d && --depth === 0) {
            return pdb.toString('utf8', start, i + 1);
        }
    }
    return undefined;
}

export interface AssemblyIdentity {
    /** Module version id ("d"-formatted GUID), which identifies this exact build. */
    mvid?: string;
    /** What the compiler recorded about the PDB: its file name and id (for symbol servers). */
    codeView?: { pdbName: string; guid: string; age: number; portable: boolean };
}

/** The MVID and the CodeView record of an assembly, or undefined when it is not a managed PE image. */
export function readAssemblyIdentity(assemblyPath: string): AssemblyIdentity | undefined {
    let image: Buffer;
    try {
        image = fs.readFileSync(assemblyPath);
    } catch {
        return undefined;
    }
    const pe = parsePeHeader(image);
    if (!pe || !pe.managed || !pe.clrDirectory) {
        return undefined;
    }
    const identity: AssemblyIdentity = {};
    const clr = rvaToOffset(image, pe.sectionTable, pe.sectionCount, pe.clrDirectory.rva);
    const metadata = clr === undefined ? undefined : rvaToOffset(image, pe.sectionTable, pe.sectionCount, image.readUInt32LE(clr + 8));
    if (metadata !== undefined) {
        identity.mvid = readMvid(image, metadata);
    }
    const dir = pe.debugDirectory && rvaToOffset(image, pe.sectionTable, pe.sectionCount, pe.debugDirectory.rva);
    for (let entry = dir ?? 0; dir !== undefined && entry + 28 <= dir + pe.debugDirectory!.size; entry += 28) {
        const pointer = image.readUInt32LE(entry + 24);
        if (image.readUInt32LE(entry + 12) !== IMAGE_DEBUG_TYPE_CODEVIEW || pointer + 24 > image.length || image.toString('latin1', pointer, pointer + 4) !== 'RSDS') {
            continue;
        }
        const end = image.indexOf(0, pointer + 24);
        const pdbPath = image.toString('utf8', pointer + 24, end < 0 ? pointer + image.readUInt32LE(entry + 16) : end);
        const codeView = {
            pdbName: path.win32.basename(pdbPath),
            guid: formatGuid(image.subarray(pointer + 4, pointer + 20)),
            age: image.readUInt32LE(pointer + 20),
            // Portable PDBs mark their CodeView entry with minor version 0x504d ("PM").
            portable: image.readUInt16LE(entry + 10) === 0x504d,
        };
        // A ReadyToRun image has a second entry for its native code (a Windows "*.ni.pdb"): the IL's portable one wins.
        if (!identity.codeView || (codeView.portable && !identity.codeView.portable)) {
            identity.codeView = codeView;
        }
    }
    return identity;
}

/** The Mvid of the Module table's only row (#~ stream, table 0), from the #GUID heap. */
function readMvid(image: Buffer, root: number): string | undefined {
    if (image.readUInt32LE(root) !== METADATA_SIGNATURE) {
        return undefined;
    }
    const streams = readStreamHeaders(image, root);
    const tables = streams.get('#~') ?? streams.get('#-');
    const guids = streams.get('#GUID');
    if (!tables || !guids) {
        return undefined;
    }
    const at = root + tables.offset;
    const heapSizes = image.readUInt8(at + 6);
    const valid = image.readBigUInt64LE(at + 8);
    let present = 0;
    for (let t = 0; t < 64; t++) {
        if ((valid >> BigInt(t)) & 1n) {
            present++;
        }
    }
    // Module row: Generation (2), Name (#Strings index), Mvid (#GUID index), ...
    const row = at + 24 + present * 4;
    const stringIndexSize = heapSizes & 0x01 ? 4 : 2;
    const guidIndex = heapSizes & 0x02 ? image.readUInt32LE(row + 2 + stringIndexSize) : image.readUInt16LE(row + 2 + stringIndexSize);
    if (guidIndex === 0) {
        return undefined;
    }
    return formatGuid(image.subarray(root + guids.offset + (guidIndex - 1) * 16, root + guids.offset + guidIndex * 16));
}

/** .NET's "d" format of a GUID stored as bytes (the first three fields little-endian). */
function formatGuid(bytes: Buffer): string {
    const hex = (from: number, to: number, reverse: boolean) => {
        const part = [...bytes.subarray(from, to)];
        return (reverse ? part.reverse() : part).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    return `${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10, false)}-${hex(10, 16, false)}`;
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
    clrDirectory?: { rva: number; size: number };
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
        clrDirectory: directory(CLR_DIRECTORY_INDEX),
        sectionTable: opt + sizeOfOptionalHeader,
        sectionCount,
        debugDirectory: directory(DEBUG_DIRECTORY_INDEX),
    };
}

/** The stream headers of an ECMA-335 metadata root at `root` (offsets are relative to the root). */
function readStreamHeaders(buf: Buffer, root: number): Map<string, { offset: number; size: number }> {
    const versionLength = buf.readUInt32LE(root + 12);
    let at = root + 16 + versionLength + 2; // + flags
    const streamCount = buf.readUInt16LE(at);
    at += 2;
    const streams = new Map<string, { offset: number; size: number }>();
    for (let i = 0; i < streamCount; i++) {
        const offset = buf.readUInt32LE(at);
        const size = buf.readUInt32LE(at + 4);
        const nameEnd = buf.indexOf(0, at + 8);
        streams.set(buf.toString('latin1', at + 8, nameEnd), { offset, size });
        at = root + ((nameEnd - root + 1 + 3) & ~3); // names are padded to 4 bytes (from the root)
    }
    return streams;
}

/** Document table names of a Portable PDB (ECMA-335 metadata with the Portable PDB tables). */
function readDocumentNames(pdb: Buffer): string[] {
    if (pdb.readUInt32LE(0) !== METADATA_SIGNATURE) {
        return [];
    }
    const streams = readStreamHeaders(pdb, 0);
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
