// Snapshot of the program state when an exception is thrown (the exception log records it without stopping):
// the call stack, and the locals of the first frames of the user's code. Bounded so that programs that throw a lot
// stay usable. Kept free of the vscode module.

export const SNAPSHOT_LIMITS = {
    /** Frames of the call stack kept. */
    frames: 30,
    /** Frames of the user's code (with source) whose locals are read. */
    framesWithLocals: 3,
    /** Locals kept per frame (objects are not expanded). */
    locals: 30,
    /** Characters of a value kept. */
    valueLength: 200,
    /** Snapshots taken per session; later exceptions are still logged, without one. */
    perSession: 200,
};

export interface SnapshotFrame {
    frameId: number;
    name: string;
    source?: { path?: string; name?: string };
    line?: number;
    readLocals: boolean;
    locals?: SnapshotLocal[];
}

export interface SnapshotLocal {
    name: string;
    value: string;
    type?: string;
}

/** The stack as DAP gives it, marking the first frames with source (the user's code) for their locals. */
export function snapshotFrames(frames: { id: number; name: string; source?: { path?: string; name?: string }; line?: number }[]): SnapshotFrame[] {
    let withLocals = 0;
    return frames.slice(0, SNAPSHOT_LIMITS.frames).map((f) => {
        const readLocals = Boolean(f.source?.path) && withLocals < SNAPSHOT_LIMITS.framesWithLocals;
        if (readLocals) {
            withLocals++;
        }
        return { frameId: f.id, name: f.name, source: f.source, line: f.line, readLocals };
    });
}

export function snapshotLocals(variables: { name: string; value: string; type?: string }[]): SnapshotLocal[] {
    return variables
        .filter((v) => v.name !== 'Static members')
        .slice(0, SNAPSHOT_LIMITS.locals)
        .map((v) => {
            const value = v.value.length > SNAPSHOT_LIMITS.valueLength ? `${v.value.slice(0, SNAPSHOT_LIMITS.valueLength)}…` : v.value;
            return v.type === undefined ? { name: v.name, value } : { name: v.name, value, type: v.type };
        });
}
