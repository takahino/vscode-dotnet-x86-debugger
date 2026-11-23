import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBenignEvaluateError, shouldQuietAutomaticEvaluateError } from '../../evaluateErrorCore';

describe('evaluateErrorCore', () => {
    it('recognizes type-name and not-in-scope evaluate errors from the engine', () => {
        assert.equal(
            isBenignEvaluateError('System.Decimal は型の名前です。値を見るには、メンバーを指定してください。'),
            true,
        );
        assert.equal(isBenignEvaluateError('System.Decimal is a type name. To see the value, specify a member.'), true);
        assert.equal(isBenignEvaluateError("'i' という名前の変数、メンバー、型が見つかりません。"), true);
        assert.equal(isBenignEvaluateError("The name 'i' does not exist in the current context"), true);
        assert.equal(isBenignEvaluateError('syntax error in expression'), false);
    });

    it('keeps the debug console loud', () => {
        assert.equal(shouldQuietAutomaticEvaluateError('hover'), true);
        assert.equal(shouldQuietAutomaticEvaluateError('repl'), false);
    });
});