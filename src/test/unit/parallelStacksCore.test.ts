import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { buildStackGraph, StackNode } from '../../parallelStacksCore';

const f = (name: string) => ({ name });
/** Compact text of the graph: "[frames] ×threads" with children indented. */
const show = (nodes: StackNode[], indent = ''): string[] =>
    nodes.flatMap((n) => [`${indent}[${n.frames.map((x) => x.name).join(' > ')}] ×${n.threadIds.length}`, ...show(n.children, indent + '  ')]);

describe('buildStackGraph', () => {
    it('merges the common outer frames and splits where the threads go different ways', () => {
        // Stacks are given innermost frame first, as DAP gives them.
        const graph = buildStackGraph([
            { id: 1, name: 'Main', frames: [f('Wait'), f('Run'), f('Main')] },
            { id: 2, name: 'Worker 1', frames: [f('Sleep'), f('Work'), f('ThreadStart')] },
            { id: 3, name: 'Worker 2', frames: [f('Sleep'), f('Work'), f('ThreadStart')] },
            { id: 4, name: 'Worker 3', frames: [f('Lock'), f('Save'), f('Work'), f('ThreadStart')] },
        ]);
        assert.deepEqual(show(graph), [
            '[Main > Run > Wait] ×1',
            '[ThreadStart > Work] ×3',
            '  [Sleep] ×2',
            '  [Save > Lock] ×1',
        ]);
    });

    it('keeps the thread ids of each box and the frames as given', () => {
        const [root] = buildStackGraph([
            { id: 7, name: 'A', frames: [{ name: 'X', line: 3 }, { name: 'Root' }] },
            { id: 8, name: 'B', frames: [{ name: 'X', line: 3 }, { name: 'Root' }] },
        ]);
        assert.deepEqual(root.threadIds, [7, 8]);
        assert.deepEqual(root.frames, [{ name: 'Root' }, { name: 'X', line: 3 }]);
        assert.equal(root.children.length, 0);
    });

    it('tells apart frames of the same method at different lines', () => {
        const graph = buildStackGraph([
            { id: 1, name: 'A', frames: [{ name: 'M', line: 1 }, { name: 'Root' }] },
            { id: 2, name: 'B', frames: [{ name: 'M', line: 2 }, { name: 'Root' }] },
        ]);
        assert.deepEqual(show(graph), ['[Root] ×2', '  [M] ×1', '  [M] ×1']);
    });

    it('ignores threads without frames', () => {
        assert.deepEqual(buildStackGraph([{ id: 1, name: 'native', frames: [] }]), []);
    });
});
