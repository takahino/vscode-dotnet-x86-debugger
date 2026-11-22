import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
    JournalRecord,
    applySqlCompleted,
    mergeJournal,
    openTransactionHeading,
    recordHeading,
    recordsKindOf,
    sqlDurationLabel,
} from '../../journalCore';

const record = (seq: number, kind: string, extra: Record<string, unknown> = {}): JournalRecord => ({
    seq,
    time: 1_700_000_000_000 + seq,
    kind,
    ...extra,
});

describe('mergeJournal', () => {
    it('appends records after the cursor and advances last', () => {
        const first = mergeJournal([], { after: 0, dropped: 0 }, {
            records: [record(1, 'dialog', { text: 'a' }), record(2, 'binding', { control: 'x', property: 'Text', direction: 'parse' })],
            last: 2,
            dropped: 0,
        });
        assert.equal(first.records.length, 2);
        assert.equal(first.cursor.after, 2);
        assert.equal(first.droppedGrew, false);

        const second = mergeJournal(first.records, first.cursor, {
            records: [record(3, 'transaction', { event: 'begin', transactionId: 1 })],
            last: 3,
            dropped: 0,
        });
        assert.deepEqual(second.records.map((r) => r.seq), [1, 2, 3]);
        assert.equal(second.cursor.after, 3);
    });

    it('replaces a record with the same seq', () => {
        const merged = mergeJournal([record(1, 'dialog', { text: 'old' })], { after: 1, dropped: 0 }, {
            records: [record(1, 'dialog', { text: 'new' })],
            last: 1,
            dropped: 0,
        });
        assert.equal(merged.records.length, 1);
        assert.equal(merged.records[0].text, 'new');
    });

    it('flags when dropped grew', () => {
        const merged = mergeJournal([], { after: 0, dropped: 0 }, { records: [], last: 0, dropped: 3 });
        assert.equal(merged.droppedGrew, true);
        assert.equal(merged.cursor.dropped, 3);
    });
});

describe('recordsKindOf and recordHeading', () => {
    it('treats messageBox as a dialog (body kind overwrites the journal kind)', () => {
        const r = record(1, 'messageBox', { caption: 'Confirm', text: 'Save?', method: 'System.Windows.Forms.MessageBox.Show', caller: { name: 'App.Form1.OnSave()', source: { path: 'C:\\a\\Form1.cs' }, line: 40 } });
        assert.equal(recordsKindOf(r), 'dialog');
        const h = recordHeading(r);
        assert.equal(h.label, 'Confirm: Save?');
        assert.equal(h.source?.path, 'C:\\a\\Form1.cs');
        assert.equal(h.source?.line, 40);
    });

    it('shows a binding failure with the parse arrow', () => {
        const h = recordHeading(record(1, 'binding', {
            control: 'amountBox',
            property: 'Text',
            member: 'Amount',
            direction: 'parse',
            exceptionType: 'System.FormatException',
            message: 'bad',
        }));
        assert.equal(recordsKindOf(record(1, 'binding', { control: 'a', property: 'Text', direction: 'parse' })), 'binding');
        assert.equal(h.label, 'amountBox.Text → Amount');
        assert.match(h.description, /FormatException/);
    });

    it('shows a transaction begin and a commit with duration', () => {
        const begin = recordHeading(record(1, 'transaction', { event: 'begin', transactionId: 2, caller: { name: 'Orders.Save()' } }));
        assert.equal(begin.label, 'begin #2');
        const commit = recordHeading(record(2, 'transaction', { event: 'commit', transactionId: 2, durationMs: 12.5, statements: [10, 11] }));
        assert.equal(commit.label, 'commit #2');
        assert.match(commit.description, /12\.5 ms/);
        assert.match(commit.description, /2 SQL/);
    });

    it('treats a child process whose kind was overwritten as process', () => {
        const r = record(1, '.NET', { fileName: 'C:\\tools\\child.exe', processId: 4242, bitness: 'x86', followed: true });
        assert.equal(recordsKindOf(r), 'process');
        const h = recordHeading(r);
        assert.equal(h.label, 'C:\\tools\\child.exe');
        assert.match(h.description, /pid 4242/);
        assert.match(h.description, /x86/);
        assert.match(h.description, /\.NET/);
        assert.match(h.description, /attaching/);
    });

    it('shows the environment runtime and program name', () => {
        const h = recordHeading(record(1, 'environment', {
            runtime: '.NET 8.0.11',
            bitness: 'x86',
            program: 'C:\\app\\MyApp.exe',
            connectionStrings: [{ name: 'db' }],
        }));
        assert.equal(h.label, '.NET 8.0.11');
        assert.match(h.description, /MyApp\.exe/);
        assert.match(h.description, /1 connection string/);
    });
});

describe('openTransactionHeading', () => {
    it('labels an open transaction with elapsed time', () => {
        const h = openTransactionHeading({ transactionId: 3, threadId: 1, elapsedMs: 1500, statements: [1, 2, 3], caller: { name: 'Db.Begin()' } });
        assert.equal(h.label, 'open #3');
        assert.match(h.description, /1500 ms/);
        assert.match(h.description, /3 SQL/);
    });
});

describe('applySqlCompleted and sqlDurationLabel', () => {
    it('updates the matching SQL entry by seq', () => {
        const entries = [
            { seq: 5, commandText: 'SELECT 1', durationMs: undefined as number | undefined, failed: undefined as boolean | undefined },
            { seq: 6, commandText: 'SELECT 2', durationMs: undefined as number | undefined, failed: undefined as boolean | undefined },
        ];
        const updated = applySqlCompleted(entries, { seq: 5, durationMs: 8.2, failed: true });
        assert.equal(updated?.durationMs, 8.2);
        assert.equal(updated?.failed, true);
        assert.equal(entries[1].durationMs, undefined);
        assert.equal(applySqlCompleted(entries, { seq: 99, durationMs: 1 }), undefined);
    });

    it('formats duration, failure and transaction id', () => {
        assert.equal(sqlDurationLabel({ durationMs: 4.5, transactionId: 2 }), '4.5 ms · tx #2');
        assert.equal(sqlDurationLabel({ durationMs: 1, failed: true }), '1 ms · failed');
        assert.equal(sqlDurationLabel({}), '');
    });
});
