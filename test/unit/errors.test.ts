import { describe, expect, it } from 'vitest';
import { isRetryable, makeStatusError, renderMessage } from '../../src/core/errors';
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  BakbakError,
  InsufficientCreditsError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  RequestTooLargeError,
  StreamInterruptedError,
  UnprocessableEntityError,
  WebSocketClosedError,
} from '../../src/index';

describe('error message rendering (BEHAVIOR.md §3.2)', () => {
  it('prefers the body message', () => {
    expect(renderMessage({ message: 'M', detail: 'D', error: 'E' }, 400, 'Bad Request')).toBe('M');
  });

  it('falls back to a string detail', () => {
    expect(renderMessage({ detail: 'Empty text provided' }, 400)).toBe('Empty text provided');
  });

  it('renders a validation list as "loc: msg" joined by "; ", without the leading body', () => {
    const body = {
      detail: [
        { type: 'missing', loc: ['body', 'voice_id'], msg: 'Field required' },
        { type: 'value_error', loc: ['body', 'output_format', 'encoding'], msg: 'Value error, bad' },
      ],
    };
    expect(renderMessage(body, 422)).toBe(
      'voice_id: Field required; output_format.encoding: Value error, bad',
    );
  });

  it('adds a validation list to a message that does not mention it', () => {
    const body = {
      message: 'The request is malformed or invalid.',
      detail: [{ loc: ['body', 'voice_id'], msg: 'Field required' }],
    };
    expect(renderMessage(body, 422)).toBe('The request is malformed or invalid. voice_id: Field required');
    const mentioned = {
      message: 'Invalid request: voice_id: Field required.',
      detail: [{ loc: ['body', 'voice_id'], msg: 'Field required' }],
    };
    expect(renderMessage(mentioned, 422)).toBe('Invalid request: voice_id: Field required.');
  });

  it('skips detail entries without a msg, and ignores trailing whitespace before the stop', () => {
    const detail = [{ loc: ['body', 'speed'] }, { loc: ['body', 'voice_id'], msg: 'Field required' }, 7];
    expect(renderMessage({ detail }, 422)).toBe('voice_id: Field required');
    expect(renderMessage({ message: 'Invalid request.  ', detail }, 422)).toBe(
      'Invalid request. voice_id: Field required',
    );
    expect(renderMessage({ message: 'Invalid request ', detail }, 422)).toBe(
      'Invalid request: voice_id: Field required',
    );
  });

  it('falls back to error, then the reason phrase, then HTTP <status>', () => {
    expect(renderMessage({ error: 'Too many' }, 429, 'Too Many Requests')).toBe('Too many');
    expect(renderMessage({}, 418, "I'm a teapot")).toBe("I'm a teapot");
    expect(renderMessage(undefined, 599, '')).toBe('HTTP 599');
    expect(renderMessage('not json', 404, '')).toBe('Not Found');
    expect(renderMessage({ message: '' }, 599)).toBe('HTTP 599');
  });
});

describe('retryable (BEHAVIOR.md §3.3)', () => {
  it('uses the body flag when it is a boolean', () => {
    expect(isRetryable({ retryable: false }, 503)).toBe(false);
    expect(isRetryable({ retryable: true }, 400)).toBe(true);
    expect(isRetryable({ retryable: 'yes' }, 400)).toBe(false);
  });

  it('otherwise goes by status', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryable({}, s)).toBe(true);
    for (const s of [400, 401, 402, 403, 404, 413, 422, 501]) expect(isRetryable({}, s)).toBe(false);
  });

  it('treats connection errors and timeouts as retryable', () => {
    expect(new APIConnectionError('x').retryable).toBe(true);
    expect(new APITimeoutError('x').retryable).toBe(true);
    expect(new WebSocketClosedError('x', { retryable: false }).retryable).toBe(false);
  });
});

describe('status classes', () => {
  const cases: Array<[number, new (...a: never[]) => APIStatusError]> = [
    [400, BadRequestError],
    [401, AuthenticationError],
    [402, InsufficientCreditsError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [413, RequestTooLargeError],
    [422, UnprocessableEntityError],
    [429, RateLimitError],
    [500, InternalServerError],
    [503, InternalServerError],
    [599, InternalServerError],
  ];
  for (const [status, Cls] of cases) {
    it(`${status} → ${Cls.name}`, () => {
      const err = makeStatusError(status, { message: 'm' });
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(APIStatusError);
      expect(err).toBeInstanceOf(APIError);
      expect(err).toBeInstanceOf(BakbakError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(Cls.name);
      expect(err.status).toBe(status);
    });
  }

  it('maps any other status to APIStatusError itself', () => {
    const err = makeStatusError(409, {});
    expect(err.constructor).toBe(APIStatusError);
    expect(err.name).toBe('APIStatusError');
  });

  it('keeps the hierarchy apart', () => {
    const interrupted = new StreamInterruptedError('x', { audioBytes: 3 });
    expect(interrupted).toBeInstanceOf(APIError);
    expect(interrupted).not.toBeInstanceOf(APIStatusError);
    expect(interrupted.audioBytes).toBe(3);
    const timeout = new APITimeoutError('t');
    expect(timeout).toBeInstanceOf(APIConnectionError);
    expect(timeout).not.toBeInstanceOf(APIError);
    expect(new WebSocketClosedError('c', { closeCode: 1009 }).closeCode).toBe(1009);
  });

  it('takes the request id from X-Request-Id, else the body', () => {
    expect(makeStatusError(500, { request_id: 'body' }, 'header').requestId).toBe('header');
    expect(makeStatusError(500, { request_id: 'body' }, null).requestId).toBe('body');
    expect(makeStatusError(500, {}, null).requestId).toBeUndefined();
  });

  it('never invents an error code and keeps the body as received', () => {
    const body = { error_code: 'insufficient_credits', required_inr: 1.5, retryable: false };
    const err = makeStatusError(402, body, 'r');
    expect(err.errorCode).toBe('insufficient_credits');
    expect(err.body).toBe(body);
    expect(makeStatusError(402, {}).errorCode).toBeUndefined();
  });
});

describe('instanceof across copies of the SDK', () => {
  it('recognises an error created by another copy of the classes', () => {
    // A second copy (as when ESM and CJS builds are both loaded) has distinct classes but the
    // same brand symbol. Simulate it with an object carrying the brand.
    const foreign = Object.create(Error.prototype) as Record<symbol, unknown>;
    Object.defineProperty(foreign, Symbol.for('bakbak.error.classes'), {
      value: ['RateLimitError', 'APIStatusError', 'APIError', 'BakbakError'],
    });
    expect(foreign).toBeInstanceOf(RateLimitError);
    expect(foreign).toBeInstanceOf(APIStatusError);
    expect(foreign).toBeInstanceOf(BakbakError);
    expect(foreign).not.toBeInstanceOf(NotFoundError);
    expect(foreign).not.toBeInstanceOf(APIConnectionError);
    expect({}).not.toBeInstanceOf(BakbakError);
    expect(null).not.toBeInstanceOf(BakbakError);
  });
});

describe('secrets', () => {
  it('keeps the API key and headers out of errors', async () => {
    const key = 'sk-very-secret-key';
    const err = makeStatusError(401, { message: 'Unauthorized', request_id: 'x' });
    const text = `${err.message} ${String(err)} ${JSON.stringify(err)} ${err.stack}`;
    expect(text).not.toContain(key);
    expect(Object.keys(err)).not.toContain('headers');
  });
});
