import * as assert from 'assert/strict';
import { describe, it } from 'node:test';
import { breaksOnThrow, exceptionFiltersForDebugger, ExceptionSettings } from '../../exceptionFilterCore';

const none: ExceptionSettings = { filters: [], filterOptions: [] };
const all: ExceptionSettings = { filters: ['all'], filterOptions: [] };
const only = (condition: string): ExceptionSettings => ({ filters: [], filterOptions: [{ filterId: 'all', condition }] });

describe('breaksOnThrow', () => {
    it('follows the user\'s "All Exceptions" setting and its condition', () => {
        assert.equal(breaksOnThrow(all, [], 'System.IO.IOException'), true);
        assert.equal(breaksOnThrow(only('System.FormatException, System.IO.IOException'), [], 'System.IO.IOException'), true);
        assert.equal(breaksOnThrow(only('System.FormatException'), [], 'System.IO.IOException'), false);
        assert.equal(breaksOnThrow(only('!System.FormatException'), [], 'System.IO.IOException'), true);
        assert.equal(breaksOnThrow(only('!System.FormatException'), [], 'System.FormatException'), false);
        assert.equal(breaksOnThrow(none, [], 'System.FormatException'), false);
    });

    it('also stops on the types checked in the Exception Settings view', () => {
        assert.equal(breaksOnThrow(none, ['System.FormatException'], 'System.FormatException'), true);
        assert.equal(breaksOnThrow(only('!System.FormatException'), ['System.FormatException'], 'System.FormatException'), true);
        assert.equal(breaksOnThrow(none, ['System.FormatException'], 'System.IO.IOException'), false);
    });
});

describe('exceptionFiltersForDebugger', () => {
    it('with the exception log on, always asks for every exception (the relay decides whether to stop)', () => {
        assert.deepEqual(exceptionFiltersForDebugger(only('System.FormatException'), ['System.IO.IOException'], true), {
            filters: ['all'],
            filterOptions: [],
        });
    });

    it('passes the user\'s settings through when no type is checked', () => {
        const user = { filters: ['user-unhandled'], filterOptions: [{ filterId: 'all', condition: 'System.FormatException' }] };
        assert.deepEqual(exceptionFiltersForDebugger(user, [], false), user);
    });

    it('adds the checked types as an "All Exceptions" condition', () => {
        assert.deepEqual(exceptionFiltersForDebugger({ filters: ['user-unhandled'], filterOptions: [] }, ['A', 'B'], false), {
            filters: ['user-unhandled'],
            filterOptions: [{ filterId: 'all', condition: 'A, B' }],
        });
    });

    it('joins the checked types with the user\'s own type list', () => {
        assert.deepEqual(exceptionFiltersForDebugger(only('A, B'), ['B', 'C'], false), only('A, B, C'));
    });

    it('takes checked types out of the user\'s "all except" list', () => {
        assert.deepEqual(exceptionFiltersForDebugger(only('!A, B'), ['B'], false), only('!A'));
    });

    it('keeps "all exceptions" as it is: it already covers every checked type', () => {
        assert.deepEqual(exceptionFiltersForDebugger(all, ['A'], false), all);
        assert.deepEqual(exceptionFiltersForDebugger(only(''), ['A'], false), only(''));
    });
});
