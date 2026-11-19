// Edit and Continue without VS Code: which saves apply, and how a result is shown.

import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { describeProblems, isCSharpSource, parseResult, presentation } from '../../editAndContinueCore';

describe('isCSharpSource', () => {
    it('applies the edits of C# sources only', () => {
        assert.equal(isCSharpSource('csharp', 'C:\\app\\Program.cs'), true);
        assert.equal(isCSharpSource('plaintext', 'C:\\app\\Form1.CS'), true);
        assert.equal(isCSharpSource('json', 'C:\\app\\appsettings.json'), false);
        assert.equal(isCSharpSource('xml', 'C:\\app\\App.xaml'), false);
    });
});

describe('describeProblems', () => {
    it('writes the file name, line and column like a compiler', () => {
        assert.deepEqual(describeProblems([{ file: 'C:\\app\\src\\Program.cs', line: 12, column: 5, message: 'CS1525: invalid term' }]), ['Program.cs(12,5): CS1525: invalid term']);
    });
});

describe('parseResult', () => {
    it('reads the engine\'s answer', () => {
        const result = parseResult({ status: 'applied', message: 'done', applied: [{ module: 'App.dll', methods: 2 }], problems: [], details: [] });
        assert.equal(result.status, 'applied');
        assert.deepEqual(result.applied, [{ module: 'App.dll', methods: 2 }]);
    });

    it('treats an answer it does not know as a failure', () => {
        assert.equal(parseResult(undefined).status, 'failed');
        assert.equal(parseResult({ status: 'something' }).status, 'failed');
        assert.deepEqual(parseResult({ status: 'rude', problems: [null, { message: 'x', file: 'a.cs', line: 1, column: 1 }] }).problems.length, 1);
    });
});

describe('presentation', () => {
    const problem = { file: 'C:\\a\\Program.cs', line: 3, column: 9, message: 'removed' };

    it('shows an applied change in the status bar', () => {
        assert.deepEqual(presentation(parseResult({ status: 'applied', message: 'Applied.' }), false), { kind: 'status', text: 'Applied.' });
    });

    it('stays quiet when a save changed nothing, but answers a command', () => {
        assert.equal(presentation(parseResult({ status: 'noChanges', message: 'Nothing.' }), false).kind, 'none');
        assert.equal(presentation(parseResult({ status: 'noChanges', message: 'Nothing.' }), true).kind, 'info');
        assert.equal(presentation(parseResult({ status: 'noChanges', message: 'Nothing.', details: ['Not a Debug build.'] }), true).text, 'Nothing. Not a Debug build.');
    });

    it('warns with the first problem when the change cannot be applied', () => {
        const shown = presentation(parseResult({ status: 'rude', message: 'Restart.', problems: [problem] }), false);
        assert.equal(shown.kind, 'warning');
        assert.equal(shown.text, 'Restart. Program.cs(3,9): removed');
        assert.equal(presentation(parseResult({ status: 'failed', message: 'Failed.', details: ['no SDK'] }), false).text, 'Failed. no SDK');
    });
});
