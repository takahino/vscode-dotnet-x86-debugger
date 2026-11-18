// The engine API document (docs/engine-api.*) is generated from src/engineProtocol.ts: it must be up to date, and the
// custom request and event names the extension uses must all be in it.
import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';
import { buildEngineApi, renderHtml, renderJson } from '../../tools/engineApiDoc';
import * as proxy from '../../dapProxy';
import { HEAP_STATS_REQUEST } from '../../heapSnapshotCore';
import { MAKE_OBJECT_ID_REQUEST } from '../../objectIds';
import { HANDLE_STATS_REQUEST } from '../../resourceLeakCore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const REPO = path.resolve(__dirname, '..', '..', '..');
const api = buildEngineApi(REPO);
const read = (name: string) => fs.readFileSync(path.join(REPO, 'docs', name), 'utf8').replace(/\r\n/g, '\n');

describe('engine API document', () => {
    it('is up to date with src/engineProtocol.ts (npm run docs:api)', () => {
        assert.equal(read('engine-api.json'), renderJson(api), 'docs/engine-api.json is stale: run npm run docs:api');
        assert.equal(read('engine-api.html'), renderHtml(api), 'docs/engine-api.html is stale: run npm run docs:api');
    });

    it('lists every custom request the extension sends, with the side that handles it', () => {
        const requests = new Map(api.messages.filter((m) => m.kind === 'request').map((m) => [m.name, m.side]));
        for (const name of [HEAP_STATS_REQUEST, HANDLE_STATS_REQUEST, MAKE_OBJECT_ID_REQUEST, proxy.FREEZE_THREAD_REQUEST]) {
            assert.equal(requests.get(name), 'engine', name);
        }
        for (const name of [proxy.EXCEPTION_TYPES_REQUEST, proxy.FREEZE_PAUSE_REQUEST, proxy.EVENT_TRACE_REQUEST]) {
            assert.equal(requests.get(name), 'proxy', name);
        }
        assert.equal(requests.size, 7, [...requests.keys()].join(', '));
    });

    it('lists every custom event the relay sends', () => {
        const events = api.messages.filter((m) => m.kind === 'event' && m.side === 'proxy').map((m) => m.name).sort();
        assert.deepEqual(events, [proxy.EVENT_TRACE_EVENT, proxy.EXCEPTION_EVENT, proxy.REMOVE_BREAKPOINT_EVENT, proxy.SQL_EVENT, proxy.TRACK_EVENT].sort());
    });

    it('describes every field of every message', () => {
        const undocumented: string[] = [];
        const visit = (where: string, schema: any) => {
            for (const [name, field] of Object.entries<any>(schema?.properties ?? {})) {
                if (!field.description && !(field.type === 'object' || field.type === 'array' || field.$ref)) {
                    undocumented.push(`${where}.${name}`);
                }
            }
        };
        visit('launch', api.launch);
        visit('attach', api.attach);
        assert.deepEqual(undocumented, []);
    });
});