import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTypeNameOnlyEvaluateError, shouldQuietTypeNameEvaluateError } from '../../evaluateErrorCore';

describe('evaluateErrorCore', () => {
    it('recognizes the engine type-name evaluate error', () => {
        assert.equal(
            isTypeNameOnlyEvaluateError('System.Decimal は型の名前です。値を見るには、メンバーを指定してください。'),
            true,
        );
        assert.equal(isTypeNameOnlyEvaluateError('System.Decimal is a type name. To see the value, specify a member.'), true);
        assert.equal(isTypeNameOnlyEvaluateError('The name "x" does not exist'), false);
    });

    it('keeps the debug console loud', () => {
        assert.equal(shouldQuietTypeNameEvaluateError('hover'), true);
        assert.equal(shouldQuietTypeNameEvaluateError('repl'), false);
    });
});