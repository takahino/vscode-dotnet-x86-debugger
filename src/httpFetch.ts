// Downloads for Source Link and symbol servers. Kept free of the vscode module.

/** How long one download may take before it is given up. */
const TIMEOUT_MS = 20_000;

/** GETs `url`; rejects with the HTTP status (e.g. "HTTP 404") or the network error. */
export async function fetchBytes(url: string): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}
