const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const AuthorizationError = require('../dist/errors/authorizationError.js');
const ForbiddenError = require('../dist/errors/forbiddenError.js');
const NotFoundError = require('../dist/errors/notFoundError.js');
const globalErrorHandler = require('../dist/errors/globalErrorHandler.js');

const genericMessage = 'На сервере произошла ошибка';

// Only the focused handler contract is stubbed here. Real Express/Celebrate,
// parsers and authentication remain covered by the unchanged app smoke tests.
const handle = (error) => {
  const statuses = [];
  const bodies = [];
  const res = {
    headersSent: false,
    status(value) { statuses.push(value); return this; },
    send(body) { bodies.push(body); return this; },
  };
  const result = globalErrorHandler(error, {}, res, () => assert.fail('Unexpected next()'));
  assert.equal(result, undefined);
  assert.equal(statuses.length, 1);
  assert.equal(bodies.length, 1);
  return { status: statuses[0], body: bodies[0] };
};

describe('compiled CommonJS error contracts', () => {
  for (const [ErrorClass, status] of [
    [AuthorizationError, 401], [ForbiddenError, 403], [NotFoundError, 404],
  ]) {
    it(`exports a directly constructible ${ErrorClass.name} with unchanged message/status`, () => {
      assert.equal(typeof ErrorClass, 'function');
      assert.equal(ErrorClass.default, undefined);
      const error = new ErrorClass('Синтетическая ошибка');
      assert.ok(error instanceof Error);
      assert.ok(error instanceof ErrorClass);
      assert.equal(error.statusCode, status);
      assert.equal(error.message, 'Синтетическая ошибка');
    });

    it(`preserves the ${status} response body and message`, () => {
      const message = `Синтетическая ошибка ${status}`;
      assert.deepEqual(handle(new ErrorClass(message)), { status, body: { message } });
    });
  }

  it('exports a four-argument CommonJS middleware function', () => {
    assert.equal(typeof globalErrorHandler, 'function');
    assert.equal(globalErrorHandler.default, undefined);
    assert.equal(globalErrorHandler.length, 4);
  });

  it('hides the internal message of an ordinary unhandled error', () => {
    assert.deepEqual(handle(new Error('Synthetic internal detail')), {
      status: 500, body: { message: genericMessage },
    });
  });

  it('hides the internal message of an explicit 500 error', () => {
    assert.deepEqual(handle(Object.assign(new Error('Synthetic internal detail'), { statusCode: 500 })), {
      status: 500, body: { message: genericMessage },
    });
  });

  it('accepts legacy metadata without requiring an Error instance', () => {
    assert.deepEqual(handle({ statusCode: 409, message: 'Synthetic conflict' }), {
      status: 409, body: { message: 'Synthetic conflict' },
    });
  });

  for (const statusCode of [undefined, null, 0, false, '', NaN]) {
    it(`preserves the || 500 fallback for ${String(statusCode) || 'empty string'}`, () => {
      assert.deepEqual(handle({ statusCode, message: 'Synthetic internal detail' }), {
        status: 500, body: { message: genericMessage },
      });
    });
  }

  it('passes through truthy status metadata without new coercion or validation', () => {
    // Direct boundary test: Express itself decides whether a status is valid.
    assert.deepEqual(handle({ statusCode: '500', message: 'Synthetic legacy message' }), {
      status: '500', body: { message: 'Synthetic legacy message' },
    });
  });

  it('does not introduce a default non-500 message', () => {
    assert.deepEqual(handle({ statusCode: 404 }), { status: 404, body: { message: undefined } });
  });

  it('keeps the existing fallback for a primitive thrown value', () => {
    assert.deepEqual(handle('Synthetic thrown string'), { status: 500, body: { message: genericMessage } });
  });

  it('preserves property-access failure for null/undefined rather than adding normalization', () => {
    assert.throws(() => handle(null), TypeError);
    assert.throws(() => handle(undefined), TypeError);
  });

  it('delegates the original value when headers were sent without accessing metadata', () => {
    for (const error of [new AuthorizationError('Synthetic delegated error'), { message: 'Synthetic' }, null, undefined]) {
      const delegated = [];
      const res = {
        headersSent: true,
        status() { assert.fail('Response status must not be written'); },
        send() { assert.fail('Response body must not be written'); },
      };
      globalErrorHandler(error, {}, res, (value) => { delegated.push(value); });
      assert.equal(delegated.length, 1);
      assert.equal(delegated[0], error);
    }
  });
});
