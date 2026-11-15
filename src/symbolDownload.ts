// Downloads the Portable PDB of an assembly from symbol servers (SSQP) into <cache>/<MVID>/symbols.pdb, where
// netcoredbg (patch 0009) finds it. The assembly's own folder is never written to. Kept free of the vscode module.

import * as fs from 'fs';
import * as path from 'path';
import { fetchBytes } from './httpFetch';
import { readAssemblyIdentity } from './pdbDocuments';
import { symbolServerUrl } from './sourceLinkCore';

export const DEFAULT_SYMBOL_SERVERS = ['https://symbols.nuget.org/download/symbols', 'https://msdl.microsoft.com/download/symbols'];

export type SymbolDownloadResult =
    | { ok: true; file: string; server: string }
    /** not-managed: not a .NET assembly; no-pdb-info: built without a PDB; windows-pdb: only a Windows PDB exists. */
    | { ok: false; reason: 'not-managed' | 'no-pdb-info' | 'windows-pdb' | 'not-found'; tried: string[] };

const PORTABLE_PDB = 0x424a5342; // "BSJB"

export async function downloadSymbols(
    assemblyPath: string,
    servers: string[],
    cacheRoot: string,
    fetch: (url: string) => Promise<Buffer> = fetchBytes,
): Promise<SymbolDownloadResult> {
    const identity = readAssemblyIdentity(assemblyPath);
    if (!identity?.mvid) {
        return { ok: false, reason: 'not-managed', tried: [] };
    }
    const codeView = identity.codeView;
    if (!codeView) {
        return { ok: false, reason: 'no-pdb-info', tried: [] };
    }
    if (!codeView.portable) {
        return { ok: false, reason: 'windows-pdb', tried: [] };
    }
    const tried: string[] = [];
    for (const server of servers) {
        const url = symbolServerUrl(server, codeView.pdbName, codeView.guid);
        tried.push(url);
        let bytes: Buffer;
        try {
            bytes = await fetch(url);
        } catch {
            continue; // not on this server (404), or the server cannot be reached
        }
        if (bytes.length < 4 || bytes.readUInt32LE(0) !== PORTABLE_PDB) {
            continue;
        }
        const file = path.join(cacheRoot, identity.mvid, 'symbols.pdb');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        return { ok: true, file, server };
    }
    return { ok: false, reason: 'not-found', tried };
}
