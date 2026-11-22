/**
 * The error hierarchy of BEHAVIOR.md §3. Every error the SDK raises is a `BakbakError`.
 *
 * `instanceof` works even when an application loads both the ESM and the CommonJS build
 * of this package (each has its own classes): every instance carries the names of its
 * class chain under a global symbol, and `Symbol.hasInstance` checks them.
 */

const BRAND = Symbol.for('bakbak.error.classes');

/** Fields every Bakbak error carries. */
export interface ErrorInit {
  /** HTTP status, or the stream event's `status_code`. */
  status?: number | undefined;
  /** The body's `error_code`, never invented by the SDK. */
  errorCode?: string | undefined;
  /** Whether sending the same request again can succeed. */
  retryable?: boolean | undefined;
  /** `X-Request-Id`, else the body's or event's `request_id`. */
  requestId?: string | undefined;
  /** The parsed JSON body or event, as received. */
  body?: unknown;
  cause?: unknown;
}

/** Anything the SDK raises. */
export class BakbakError extends Error {
  /** HTTP status, or the event's `status_code`; undefined when there was none. */
  readonly status: number | undefined;
  /** The body's `error_code` if it had one. */
  readonly errorCode: string | undefined;
  /** Whether sending the same request again can succeed (BEHAVIOR.md §3.3). */
  readonly retryable: boolean;
  /** The request id to quote to support. */
  readonly requestId: string | undefined;
  /** The parsed JSON body (or stream event) as received, so extra fields stay readable. */
  readonly body: unknown;

  constructor(message: string, init: ErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId;
    this.body = init.body;
    const names: string[] = [];
    for (let p = Object.getPrototypeOf(this); p && p !== Error.prototype; p = Object.getPrototypeOf(p)) {
      if (Object.hasOwn(p, 'name')) names.push(p.name);
    }
    Object.defineProperty(this, BRAND, { value: names, enumerable: false });
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    // `this` is the class on the right of `instanceof`; every subclass inherits this method.
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    if (typeof value !== 'object' || value === null) return false;
    const names = (value as Record<symbol, unknown>)[BRAND];
    return Array.isArray(names) && names.includes(this.prototype.name);
  }

  // `this`, not the class's own name: a class that names itself is renamed by esbuild
  // (`class _BakbakError`), and console.log and err.constructor.name then show the wrong name.
  static {
    this.prototype.name = 'BakbakError';
  }
}

/** The service answered with an error, or a stream broke. */
export class APIError extends BakbakError {
  static {
    this.prototype.name = 'APIError';
  }
}

/** An HTTP error status, or an in-band error event before any audio. */
export class APIStatusError extends APIError {
  static {
    this.prototype.name = 'APIStatusError';
  }
}

/** 400 */
export class BadRequestError extends APIStatusError {
  static {
    this.prototype.name = 'BadRequestError';
  }
}

/** 401: the API key is missing or wrong. */
export class AuthenticationError extends APIStatusError {
  static {
    this.prototype.name = 'AuthenticationError';
  }
}

/** 402: the account's balance is too low; `body.required_inr` and `body.available_inr` say by how much. */
export class InsufficientCreditsError extends APIStatusError {
  static {
    this.prototype.name = 'InsufficientCreditsError';
  }
}

/** 403 */
export class PermissionDeniedError extends APIStatusError {
  static {
    this.prototype.name = 'PermissionDeniedError';
  }
}

/** 404: an unknown voice, or an unknown path. */
export class NotFoundError extends APIStatusError {
  static {
    this.prototype.name = 'NotFoundError';
  }
}

/** 413: the text or the body is too long. */
export class RequestTooLargeError extends APIStatusError {
  static {
    this.prototype.name = 'RequestTooLargeError';
  }
}

/** 422: the request failed validation; the message lists each field. */
export class UnprocessableEntityError extends APIStatusError {
  static {
    this.prototype.name = 'UnprocessableEntityError';
  }
}

/** 429: the account's concurrency limit (`body.concurrency_limit`) is reached. */
export class RateLimitError extends APIStatusError {
  static {
    this.prototype.name = 'RateLimitError';
  }
}

/** Any status of 500 or more. */
export class InternalServerError extends APIStatusError {
  static {
    this.prototype.name = 'InternalServerError';
  }
}

/** Fields of a stream that failed after delivering audio. */
export interface StreamInterruptedInit extends ErrorInit {
  /** How many bytes of audio were delivered before the failure. */
  audioBytes: number;
}

/**
 * The request failed after audio was delivered. The SDK never retries it: the request is
 * billed, and a retry would play the start twice.
 */
export class StreamInterruptedError extends APIError {
  /** How many bytes of audio were delivered before the failure. */
  readonly audioBytes: number;

  constructor(message: string, init: StreamInterruptedInit) {
    super(message, init);
    this.audioBytes = init.audioBytes;
  }

  static {
    this.prototype.name = 'StreamInterruptedError';
  }
}

/** No usable answer: network, TLS or DNS failure. Retryable unless stated. */
export class APIConnectionError extends BakbakError {
  constructor(message: string, init: ErrorInit = {}) {
    super(message, { retryable: true, ...init });
  }

  static {
    this.prototype.name = 'APIConnectionError';
  }
}

/** Nothing arrived within the timeout. */
export class APITimeoutError extends APIConnectionError {
  static {
    this.prototype.name = 'APITimeoutError';
  }
}

/** Fields of a WebSocket close that ended a request. */
export interface WebSocketClosedInit extends ErrorInit {
  /** The WebSocket close code, when the socket was closed with one. */
  closeCode?: number | undefined;
}

/** The WebSocket closed and a request could not continue. */
export class WebSocketClosedError extends APIConnectionError {
  /** The WebSocket close code, when there was one. */
  readonly closeCode: number | undefined;

  constructor(message: string, init: WebSocketClosedInit = {}) {
    super(message, init);
    this.closeCode = init.closeCode;
  }

  static {
    this.prototype.name = 'WebSocketClosedError';
  }
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * pydantic wraps a validator's error as `Value error, <text>`. The server's own `message`
 * quotes the text without it, so it is dropped before the message is checked for the list.
 */
const PYDANTIC_VALUE_ERROR = 'Value error, ';

function renderDetail(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (!isObject(entry)) return '';
  let msg = typeof entry.msg === 'string' ? entry.msg : '';
  if (msg.startsWith(PYDANTIC_VALUE_ERROR)) msg = msg.slice(PYDANTIC_VALUE_ERROR.length);
  if (!msg) return ''; // an entry with no msg is skipped (BEHAVIOR.md §3.2)
  const loc = Array.isArray(entry.loc)
    ? entry.loc
        .filter((part, i) => !(i === 0 && part === 'body'))
        .map(String)
        .join('.')
    : '';
  return loc ? `${loc}: ${msg}` : msg;
}

/**
 * The sentence to show a person (BEHAVIOR.md §3.2): the body's `message`, its `detail` (a
 * string, or a validation list rendered as `loc: msg; …`), its `error`, the HTTP reason
 * phrase, or `HTTP <status>`. A `message` next to a validation list it does not mention is
 * followed by the list.
 */
export function renderMessage(body: unknown, status?: number, reason?: string): string {
  if (isObject(body)) {
    const { message, detail, error } = body;
    const fields = Array.isArray(detail) ? detail.map(renderDetail).filter(Boolean).join('; ') : '';
    if (typeof message === 'string' && message) {
      // A generic message (the WebSocket's "The request is malformed or invalid.") would hide
      // which field is wrong: add the validation list unless the message already has it.
      if (!fields || message.includes(fields)) return message;
      const base = message.trimEnd(); // trailing whitespace does not hide a final stop
      return `${base}${/[.!?]$/.test(base) ? '' : ':'} ${fields}`;
    }
    if (typeof detail === 'string' && detail) return detail;
    if (fields) return fields;
    if (typeof error === 'string' && error) return error;
  }
  if (reason) return reason;
  if (status === undefined) return 'Unknown error';
  return REASONS[status] ?? `HTTP ${status}`;
}

/** BEHAVIOR.md §3.3: the body's `retryable` when boolean, else by status. */
export function isRetryable(body: unknown, status: number | undefined): boolean {
  if (isObject(body) && typeof body.retryable === 'boolean') return body.retryable;
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

type StatusErrorClass = new (message: string, init: ErrorInit) => APIStatusError;

function classForStatus(status: number): StatusErrorClass {
  switch (status) {
    case 400:
      return BadRequestError;
    case 401:
      return AuthenticationError;
    case 402:
      return InsufficientCreditsError;
    case 403:
      return PermissionDeniedError;
    case 404:
      return NotFoundError;
    case 413:
      return RequestTooLargeError;
    case 422:
      return UnprocessableEntityError;
    case 429:
      return RateLimitError;
    default:
      return status >= 500 ? InternalServerError : APIStatusError;
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (!isObject(body)) return undefined;
  const value = body[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Builds the error for an HTTP status, or for an in-band error event (whose `status_code`
 * is passed as `status` and which is passed as `body`).
 */
export function makeStatusError(
  status: number,
  body: unknown,
  headerRequestId?: string | null,
  reason?: string,
): APIStatusError {
  const Cls = classForStatus(status);
  return new Cls(renderMessage(body, status, reason), {
    status,
    errorCode: stringField(body, 'error_code'),
    retryable: isRetryable(body, status),
    requestId: headerRequestId || stringField(body, 'request_id'),
    body,
  });
}

/** The error for an in-band `error` event that arrives after audio. */
export function makeInterruptedFromEvent(
  event: Record<string, unknown>,
  headerRequestId: string | undefined,
  audioBytes: number,
): StreamInterruptedError {
  const status = typeof event.status_code === 'number' ? event.status_code : undefined;
  return new StreamInterruptedError(renderMessage(event, status), {
    status,
    errorCode: stringField(event, 'error_code'),
    // An interruption without a status (malformed event) is treated like a truncated stream.
    retryable:
      status === undefined && typeof event.retryable !== 'boolean' ? true : isRetryable(event, status),
    requestId: headerRequestId || stringField(event, 'request_id'),
    body: event,
    audioBytes,
  });
}

/** Wraps a connection failure or timeout that happened after audio was delivered. */
export function interruptedBy(
  cause: unknown,
  audioBytes: number,
  requestId: string | undefined,
): StreamInterruptedError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new StreamInterruptedError(`The audio stream was interrupted after ${audioBytes} bytes: ${reason}`, {
    retryable: true,
    requestId,
    audioBytes,
    cause,
  });
}

/** Replaces every occurrence of the API key (raw or URL-encoded) in a text with `***`. */
export function scrub(text: string, key: string | undefined): string {
  if (!key) return text;
  let out = text.split(key).join('***');
  const encoded = encodeURIComponent(key);
  if (encoded !== key) out = out.split(encoded).join('***');
  return out;
}

/**
 * A copy of a third-party error that is safe to attach as `cause` (BEHAVIOR.md §8): only its
 * name, `code` and message (and, recursively, its own cause), with the API key scrubbed. Raw
 * fetch, undici or ws errors can reference request headers, which would carry the key.
 */
export function safeCause(err: unknown, key: string | undefined, depth = 0): unknown {
  if (err === undefined || err === null || err instanceof BakbakError) return err;
  const source = err instanceof Error ? err : undefined;
  const copy = new Error(scrub(source ? source.message : String(err), key));
  copy.name = source?.name ?? 'Error';
  copy.stack = scrub(source?.stack ?? `${copy.name}: ${copy.message}`, key);
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') Object.assign(copy, { code });
  const inner = (source as { cause?: unknown } | undefined)?.cause;
  if (inner !== undefined && depth < 3) {
    Object.defineProperty(copy, 'cause', {
      value: safeCause(inner, key, depth + 1),
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

/**
 * A redirect the SDK did not follow (BEHAVIOR.md §8): following one would send the API key,
 * a custom header that fetch and some WebSocket libraries keep on cross-origin hops, to
 * another origin. `status` is undefined for a browser's opaque redirect, which hides it.
 */
export function redirectError(
  status: number | undefined,
  location: string | null | undefined,
  requestId: string | null | undefined,
): APIStatusError {
  const where = location ? ` to ${location}` : '';
  return new APIStatusError(
    `The API answered with a redirect${status ? ` (${status})` : ''}${where}, which the SDK never follows: it ` +
      'would send your API key to another address. Check baseURL.',
    { status, retryable: false, requestId: requestId || undefined },
  );
}
