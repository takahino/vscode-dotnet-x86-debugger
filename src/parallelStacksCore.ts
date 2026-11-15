// Parallel Stacks: the call stacks of all threads merged into a tree, as in Visual Studio. Threads that share their
// outer frames share a box; a box splits where they go different ways. Kept free of the vscode module.

export interface StackFrameInfo {
    name: string;
    line?: number;
    source?: { path?: string };
}

export interface ThreadStack {
    id: number;
    name: string;
    /** Innermost frame first, as DAP's stackTrace gives them. */
    frames: StackFrameInfo[];
}

/** A box: frames shared by `threadIds`, outermost first; `children` continue towards the inner frames. */
export interface StackNode {
    frames: StackFrameInfo[];
    threadIds: number[];
    children: StackNode[];
}

/** Same method at the same line: the same frame. */
const frameKey = (f: StackFrameInfo) => `${f.name}@${f.line ?? ''}@${f.source?.path ?? ''}`;

export function buildStackGraph(threads: ThreadStack[]): StackNode[] {
    // A trie of the stacks from the outermost frame, one frame per node...
    interface Trie { frame?: StackFrameInfo; threadIds: number[]; children: Map<string, Trie> }
    const root: Trie = { threadIds: [], children: new Map() };
    for (const thread of threads) {
        let node = root;
        for (const frame of [...thread.frames].reverse()) {
            const key = frameKey(frame);
            let child = node.children.get(key);
            if (!child) {
                child = { frame, threadIds: [], children: new Map() };
                node.children.set(key, child);
            }
            child.threadIds.push(thread.id);
            node = child;
        }
    }
    // ...then chains that the same threads follow without splitting become one box.
    const collapse = (node: Trie): StackNode => {
        const frames = [node.frame!];
        let current = node;
        while (current.children.size === 1) {
            const [only] = current.children.values();
            if (only.threadIds.length !== current.threadIds.length) {
                break; // some threads end here
            }
            frames.push(only.frame!);
            current = only;
        }
        return { frames, threadIds: node.threadIds, children: [...current.children.values()].map(collapse) };
    };
    return [...root.children.values()].map(collapse);
}
