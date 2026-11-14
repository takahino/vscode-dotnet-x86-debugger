// Decompiled symbols: runs the bundled decompiler helper (debugger/decompiler, tools/Decompiler) and reads what it left
// in the cache, <cacheRoot>/<MVID>/{symbols.pdb, src/..., manifest.json}. netcoredbg (patch 0009) loads symbols.pdb by
// MVID from the folders in NETCOREDBG_SYMBOL_DIRS. Kept free of the vscode module.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Environment variable netcoredbg (patch 0009) reads the generated-symbol folders from. */
export const SYMBOL_DIRS_ENV = 'NETCOREDBG_SYMBOL_DIRS';

export interface DecompiledAssembly {
    assembly: string;
    mvid: string;
    /** PDB document name ("Namespace\Type.cs") -> extracted source file. */
    documents: { name: string; file: string }[];
}

/** Every assembly decompiled into the cache so far (unreadable manifests are skipped). */
export function readDecompiledAssemblies(cacheRoot: string): DecompiledAssembly[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(cacheRoot);
    } catch {
        return [];
    }
    const result: DecompiledAssembly[] = [];
    for (const entry of entries) {
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(cacheRoot, entry, 'manifest.json'), 'utf8'));
            result.push({
                assembly: String(manifest.Assembly ?? ''),
                mvid: String(manifest.Mvid ?? entry),
                documents: (manifest.Documents ?? []).map((d: { Name: string; File: string }) => ({ name: String(d.Name), file: String(d.File) })),
            });
        } catch {
            // A folder left by an interrupted run: it has no manifest and is not used.
        }
    }
    return result;
}

/**
 * Decompiles `assembly` into the cache with `dotnet <helper.dll>`. Resolves with the manifest path; rejects with the
 * helper's own message (e.g. not a .NET assembly) or with why it could not be started.
 */
export function decompileAssembly(dotnet: string, helperDll: string, assembly: string, cacheRoot: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(dotnet, [helperDll, assembly, cacheRoot], { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr.trim() || `the decompiler exited with code ${code}`));
            }
        });
    });
}
