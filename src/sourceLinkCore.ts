// Source Link and symbol servers: where to download the source of a PDB document (the PDB's Source Link map) and the
// PDB of an assembly (SSQP key). Kept free of the vscode module.

import * as path from 'path';

export interface SourceLinkEntry {
    /** PDB document path, or a prefix ending with "*". */
    key: string;
    /** URL, with "*" where the rest of the path goes when the key has one. */
    url: string;
}

/** The "documents" map of a Source Link JSON; empty when the JSON is not one. */
export function parseSourceLink(json: string): SourceLinkEntry[] {
    try {
        const documents = JSON.parse(json)?.documents;
        if (!documents || typeof documents !== 'object') {
            return [];
        }
        return Object.entries(documents)
            .filter((e): e is [string, string] => typeof e[1] === 'string')
            .map(([key, url]) => ({ key, url }));
    } catch {
        return [];
    }
}

/** The URL of a PDB document: the longest matching key wins, case and slash direction do not matter. */
export function resolveSourceLink(entries: SourceLinkEntry[], documentPath: string): string | undefined {
    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const target = normalize(documentPath);
    let best: { entry: SourceLinkEntry; prefix: string } | undefined;
    for (const entry of entries) {
        const key = normalize(entry.key);
        if (key.endsWith('*')) {
            const prefix = key.slice(0, -1);
            if (target.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
                best = { entry, prefix };
            }
        } else if (key === target) {
            return entry.url;
        }
    }
    if (!best) {
        return undefined;
    }
    const rest = documentPath.replace(/\\/g, '/').slice(best.prefix.length).split('/').map(encodeURIComponent).join('/');
    return best.entry.url.replace('*', rest);
}

/** Where a downloaded source file is kept: <cache>/<host>/<URL path>, never outside the cache folder. */
export function sourceCachePath(cacheRoot: string, url: string): string {
    const u = new URL(url);
    const segments = u.pathname
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s).replace(/[<>:"|?*\\/]/g, '_'))
        .map((s) => (s === '.' || s === '..' ? '_' : s));
    return path.join(cacheRoot, u.host.replace(/[<>:"|?*]/g, '_'), ...segments);
}

/** SSQP URL of a Portable PDB: <server>/<name>/<GUID without dashes>FFFFFFFF/<name>, lower case. */
export function symbolServerUrl(server: string, pdbName: string, guid: string): string {
    const name = pdbName.toLowerCase();
    return `${server.replace(/\/+$/, '')}/${name}/${guid.replace(/-/g, '').toLowerCase()}ffffffff/${name}`;
}
