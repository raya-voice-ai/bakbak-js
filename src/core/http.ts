import type { Config, RequestOptions } from './config';
import {
  APIConnectionError,
  APITimeoutError,
  BakbakError,
  makeStatusError,
  safeCause,
  scrub,
} from './errors';
import { now, parseRetryAfter, retryDelayMs, setRetryAfter, startTimer } from './util';

/**
 * One HTTP attempt's abort controller and read-inactivity timer. The timer runs from the
 * request until the next byte arrives, and again between bytes (BEHAVIOR.md §4.4). It is
 * re-armed lazily, so touching it on every network read costs one clock read.
 */
export class Attempt {
  readonly controller = new AbortController();
  timedOut = false;
  readonly timeoutMs: number;
  #last = now();
  #limit: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #user: AbortSignal | undefined;
  #onUserAbort = () => this.controller.abort(this.#user?.reason);

  constructor(timeoutMs: number, signal: AbortSignal | undefined) {
    this.timeoutMs = timeoutMs;
    this.#limit = timeoutMs;
    this.#user = signal;
    if (signal) {
      if (signal.aborted) this.controller.abort(signal.reason);
      else signal.addEventListener('abort', this.#onUserAbort, { once: true });
    }
    this.#arm(timeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Records activity: the inactivity timer restarts from now. */
  touch(): void {
    this.#last = now();
  }

  /** Shortens the remaining allowance, e.g. while draining a finished stream. */
  shorten(ms: number): void {
    this.#limit = Math.min(this.#limit, ms);
    this.touch();
    clearTimeout(this.#timer);
    this.#arm(this.#limit);
  }

  #arm(ms: number): void {
    // Unref'd: an abandoned, unread stream must not keep the process alive.
    this.#timer = startTimer(this.#check, ms);
  }

  #check = (): void => {
    const idle = now() - this.#last;
    if (idle >= this.#limit - 1) {
      this.timedOut = true;
      this.controller.abort(new APITimeoutError(`No data from the API for ${Math.round(idle)} ms.`));
    } else {
      this.#arm(this.#limit - idle);
    }
  };

  dispose(): void {
    clearTimeout(this.#timer);
    this.#user?.removeEventListener('abort', this.#onUserAbort);
  }
}

function describe(err: unknown): string {
  const cause = (err as { cause?: { message?: string; code?: string } } | undefined)?.cause;
  const parts = [cause?.code, cause?.message].filter(Boolean);
  if (parts.length) return parts.join(': ');
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turns whatever an attempt threw into what the caller should see: the caller's abort
 * reason, an `APITimeoutError`, an SDK error unchanged, or an `APIConnectionError`. Wrapped
 * errors carry a sanitised copy of the original, never the original (it can hold headers).
 */
export function toSDKError(
  err: unknown,
  attempt: Attempt,
  signal: AbortSignal | undefined,
  key: string,
): unknown {
  if (signal?.aborted) return signal.reason ?? err;
  if (attempt.timedOut) {
    return new APITimeoutError(`No data from the API for ${attempt.timeoutMs} ms.`, {
      cause: safeCause(err, key),
    });
  }
  if (err instanceof BakbakError) return err;
  return new APIConnectionError(scrub(`Connection error: ${describe(err)}`, key), {
    cause: safeCause(err, key),
  });
}

/** Reads an error response into the matching `APIStatusError`, remembering `Retry-After`. */
export async function errorFromResponse(res: Response): Promise<BakbakError> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    // A body that cannot be read leaves the status to speak for itself.
  }
  let body: unknown = text || undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: keep the text.
    }
  }
  const err = makeStatusError(res.status, body, res.headers.get('x-request-id'), res.statusText);
  return setRetryAfter(err, parseRetryAfter(res.headers.get('retry-after')));
}

export interface Endpoint {
  method: 'GET' | 'POST';
  path: string;
  body?: string | undefined;
  accept: string;
}

/** Sends one attempt and returns the response if it is a success, else throws its error. */
export async function fetchOk(
  cfg: Config,
  endpoint: Endpoint,
  options: RequestOptions | undefined,
  attempt: Attempt,
): Promise<Response> {
  const headers: Record<string, string> = { ...cfg.headers, Accept: endpoint.accept };
  if (endpoint.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options?.headers) Object.assign(headers, options.headers);
  const res = await cfg.fetch(cfg.baseURL + endpoint.path, {
    method: endpoint.method,
    headers,
    body: endpoint.body,
    signal: attempt.signal,
  });
  attempt.touch();
  if (!res.ok) throw await errorFromResponse(res);
  return res;
}

/** Serializes the request body: the caller's fields, then `extraBody` over them. */
export function jsonBody(params: object, options: RequestOptions | undefined): string {
  return JSON.stringify(options?.extraBody ? { ...params, ...options.extraBody } : params);
}

/**
 * After a failed attempt with no audio delivered: waits and returns true if the error is
 * retryable and retries remain, else returns false.
 */
export async function waitToRetry(
  cfg: Config,
  err: unknown,
  retry: number,
  maxRetries: number,
  signal: AbortSignal | undefined,
  what: string,
): Promise<boolean> {
  if (!(err instanceof BakbakError) || !err.retryable || retry >= maxRetries) return false;
  const delay = retryDelayMs(err, retry + 1);
  cfg.logger?.debug?.(`${what}: retrying`, {
    retry: retry + 1,
    delayMs: Math.round(delay),
    error: err.name,
    status: err.status,
    requestId: err.requestId,
  });
  await cfg.sleep(delay, signal);
  return true;
}

export function timeoutOf(cfg: Config, options: RequestOptions | undefined): number {
  return options?.timeout ?? cfg.timeout;
}

export function retriesOf(cfg: Config, options: RequestOptions | undefined): number {
  return options?.maxRetries ?? cfg.maxRetries;
}
