// Maps the source paths recorded in PDBs to files on this machine and back. netcoredbg has no sourceFileMap,
// so the DAP relay rewrites paths with this. Kept free of the vscode module.

import * as fs from 'fs';
import * as path from 'path';

export interface SourceMapOptions {
    /** PDB path prefix -> local path prefix (e.g. "/_/" -> "D:\\work\\Lib\\"). */
    sourceFileMap?: Record<string, string>;
    /** Folders searched (recursively) for files whose PDB path does not exist here. */
    sourceSearchPaths?: string[];
    /** Upper bound of files indexed under the search paths. */
    maxIndexedFiles?: number;
    fileExists?: (p: string) => boolean;
}

/** Why a PDB path could not be mapped: nothing matched, or several files matched equally well. */
export interface UnresolvedSource {
    pdbPath: string;
    candidates: string[];
}

/** A local file that now maps to `pdbPath`; until now the debugger was given `previous` for it. */
export interface RemappedSource {
    local: string;
    previous: string;
    pdbPath: string;
}

const DEFAULT_MAX_INDEXED_FILES = 50_000;
const SKIPPED_DIRS = new Set(['bin', 'obj', '.git', '.vs', 'node_modules']);

/** Case-insensitive, separator-insensitive comparison key (Windows paths; "/_/" PDB paths become "\_\"). */
export function pathKey(p: string): string {
    return p.replace(/\//g, '\\').toLowerCase();
}

/** True when `prefixKey` covers `key` up to a segment boundary ("c:\src" covers "c:\src\a.cs", not "c:\srcx\a.cs"). */
function coversKey(prefixKey: string, key: string): boolean {
    if (!key.startsWith(prefixKey)) {
        return false;
    }
    return prefixKey.endsWith('\\') || key.length === prefixKey.length || key[prefixKey.length] === '\\';
}

/** Joins a prefix and the rest of a path, using the separator style the prefix already uses. */
function joinPrefix(prefix: string, rest: string): string {
    const sep = prefix.includes('/') && !prefix.includes('\\') ? '/' : '\\';
    const tail = rest.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
    if (!tail) {
        return prefix;
    }
    return /[\\/]$/.test(prefix) ? prefix + tail : prefix + sep + tail;
}

interface PrefixRule {
    pdbPrefix: string;
    pdbKey: string;
    localPrefix: string;
    localKey: string;
}

export class SourcePathMapper {
    private readonly rules: PrefixRule[];
    private readonly searchPaths: string[];
    private readonly maxIndexedFiles: number;
    private readonly fileExists: (p: string) => boolean;
    /** Exact per-file pairs learned from PDB documents and searches. */
    private readonly pdbToLocal = new Map<string, string>();
    private readonly localToPdb = new Map<string, string>();
    private readonly unresolvedByKey = new Map<string, UnresolvedSource>();
    /** File name (lower case) -> full paths under the search paths; built on first use. */
    private index: Map<string, string[]> | undefined;
    private indexTruncated = false;

    constructor(options: SourceMapOptions = {}) {
        this.rules = Object.entries(options.sourceFileMap ?? {})
            .filter(([from, to]) => from.trim() && to.trim())
            .map(([from, to]) => ({ pdbPrefix: from, pdbKey: pathKey(from), localPrefix: to, localKey: pathKey(to) }));
        this.searchPaths = (options.sourceSearchPaths ?? []).filter((p) => p.trim());
        this.maxIndexedFiles = options.maxIndexedFiles ?? DEFAULT_MAX_INDEXED_FILES;
        this.fileExists = options.fileExists ?? ((p) => fs.existsSync(p));
    }

    /** False when nothing is configured: paths then pass through unchanged. */
    get enabled(): boolean {
        return this.rules.length > 0 || this.searchPaths.length > 0;
    }

    /** True when the search-path index hit its size limit (some files may be missed). */
    get truncated(): boolean {
        return this.indexTruncated;
    }

    /**
     * Learns the local file of each PDB document. Returns the local files whose debugger-side path changed
     * (with the path used until now), so breakpoints already sent for them can be sent again.
     */
    addDocuments(pdbPaths: string[]): RemappedSource[] {
        const changed: RemappedSource[] = [];
        for (const pdbPath of pdbPaths) {
            const key = pathKey(pdbPath);
            if (this.pdbToLocal.has(key)) {
                continue;
            }
            const local = this.resolve(pdbPath);
            if (local === undefined) {
                continue;
            }
            this.pdbToLocal.set(key, local);
            if (pathKey(local) === key) {
                continue; // The PDB path exists as is.
            }
            const localKey = pathKey(local);
            const before = this.toDebugger(local);
            this.localToPdb.set(localKey, pdbPath);
            if (pathKey(before) !== key) {
                changed.push({ local, previous: before, pdbPath });
            }
        }
        return changed;
    }

    /** PDB path (as netcoredbg reports it) -> path on this machine. Unmappable paths come back unchanged. */
    toLocal(pdbPath: string): string {
        const key = pathKey(pdbPath);
        const known = this.pdbToLocal.get(key);
        if (known !== undefined) {
            return known;
        }
        if (!this.enabled || this.unresolvedByKey.has(key)) {
            return pdbPath;
        }
        const local = this.resolve(pdbPath);
        if (local === undefined) {
            return pdbPath;
        }
        this.pdbToLocal.set(key, local);
        if (pathKey(local) !== key) {
            this.localToPdb.set(pathKey(local), pdbPath);
        }
        return local;
    }

    /** Path on this machine (as VS Code sends it) -> the path recorded in the PDB. */
    toDebugger(localPath: string): string {
        const key = pathKey(localPath);
        const known = this.localToPdb.get(key);
        if (known !== undefined) {
            return known;
        }
        const rule = this.longestRule(key, (r) => r.localKey);
        return rule ? joinPrefix(rule.pdbPrefix, localPath.slice(rule.localPrefix.length)) : localPath;
    }

    /** Replaces PDB paths inside free text (e.g. an exception's stack trace) with local ones. */
    rewriteText(text: string): string {
        let result = text;
        for (const [pdbKey, local] of this.pdbToLocal) {
            if (pathKey(local) === pdbKey) {
                continue;
            }
            result = replaceAllInsensitive(result, pdbKey, local);
        }
        return result;
    }

    /** Why this PDB path has no local file, or undefined when it has one (or it was never looked up). */
    unresolved(pdbPath: string): UnresolvedSource | undefined {
        return this.unresolvedByKey.get(pathKey(pdbPath));
    }

    unresolvedAll(): UnresolvedSource[] {
        return [...this.unresolvedByKey.values()];
    }

    /** sourceFileMap first (the user said so), then the path itself, then a search under the search paths. */
    private resolve(pdbPath: string): string | undefined {
        const key = pathKey(pdbPath);
        const rule = this.longestRule(key, (r) => r.pdbKey);
        if (rule) {
            return joinPrefix(rule.localPrefix, pdbPath.slice(rule.pdbPrefix.length));
        }
        if (this.fileExists(pdbPath)) {
            return pdbPath;
        }
        const candidates = this.search(pdbPath);
        if (candidates.length === 1) {
            this.unresolvedByKey.delete(key);
            return candidates[0];
        }
        this.unresolvedByKey.set(key, { pdbPath, candidates });
        return undefined;
    }

    private longestRule(key: string, ruleKey: (r: PrefixRule) => string): PrefixRule | undefined {
        let best: PrefixRule | undefined;
        for (const rule of this.rules) {
            if (coversKey(ruleKey(rule), key) && (!best || ruleKey(rule).length > ruleKey(best).length)) {
                best = rule;
            }
        }
        return best;
    }

    /**
     * Files under the search paths with the same name, ranked by how many trailing path segments match.
     * Returns the single best one, or every file tied for best (ambiguous), or nothing.
     */
    private search(pdbPath: string): string[] {
        if (this.searchPaths.length === 0) {
            return [];
        }
        const segments = pathKey(pdbPath).split('\\').filter(Boolean);
        const fileName = segments[segments.length - 1];
        if (!fileName) {
            return [];
        }
        const files = this.getIndex().get(fileName) ?? [];
        let bestScore = 0;
        let best: string[] = [];
        for (const file of files) {
            const score = trailingMatch(segments, pathKey(file).split('\\').filter(Boolean));
            if (score > bestScore) {
                bestScore = score;
                best = [file];
            } else if (score === bestScore) {
                best.push(file);
            }
        }
        return best;
    }

    private getIndex(): Map<string, string[]> {
        if (this.index) {
            return this.index;
        }
        const index = new Map<string, string[]>();
        let count = 0;
        const seen = new Set<string>();
        const walk = (dir: string): void => {
            if (count >= this.maxIndexedFiles) {
                this.indexTruncated = true;
                return;
            }
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return; // Missing or unreadable folder: nothing to index there.
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIPPED_DIRS.has(entry.name.toLowerCase())) {
                        walk(full);
                    }
                } else if (entry.isFile()) {
                    if (count >= this.maxIndexedFiles) {
                        this.indexTruncated = true;
                        return;
                    }
                    const fileKey = pathKey(full);
                    if (seen.has(fileKey)) {
                        continue; // Overlapping search paths.
                    }
                    seen.add(fileKey);
                    count++;
                    const name = entry.name.toLowerCase();
                    const list = index.get(name);
                    if (list) {
                        list.push(full);
                    } else {
                        index.set(name, [full]);
                    }
                }
            }
        };
        for (const root of this.searchPaths) {
            walk(path.resolve(root));
        }
        this.index = index;
        return index;
    }
}

/** Number of equal trailing segments (the file name counts as one). */
function trailingMatch(a: string[], b: string[]): number {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
        n++;
    }
    return n;
}

/** Replaces `needleKey` (a pathKey) in `text` regardless of case and slash direction. */
function replaceAllInsensitive(text: string, needleKey: string, replacement: string): string {
    const textKey = pathKey(text);
    let result = '';
    let from = 0;
    for (;;) {
        const at = textKey.indexOf(needleKey, from);
        if (at < 0) {
            return result + text.slice(from);
        }
        result += text.slice(from, at) + replacement;
        from = at + needleKey.length;
    }
}
