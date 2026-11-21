import type { BakbakError } from './errors';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const noop = (): void => {};

/** Marks a promise as handled so an unobserved rejection never crashes the process. */
export function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(noop);
  return promise;
}

/** A sleep function: waits `ms` milliseconds, or rejects with the signal's reason when aborted. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The longest delay setTimeout accepts; larger values fire after 1 ms instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * setTimeout that never fires early: no timer at all for an infinite (or NaN) delay, a
 * clamped one for a delay beyond setTimeout's range. Unref'd by default, so an SDK timer never
 * keeps a Node process alive on its own (BEHAVIOR.md §6.6).
 */
export function startTimer(
  fn: () => void,
  ms: number,
  unref = true,
): ReturnType<typeof setTimeout> | undefined {
  if (Number.isNaN(ms) || ms === Number.POSITIVE_INFINITY) return undefined;
  const timer = setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS));
  if (unref) (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** True for a finite timeout setTimeout can honour as given. */
export function finiteTimeout(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_TIMER_MS;
}

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    // A retry wait keeps the process alive: someone is waiting for its outcome.
    const timer = startTimer(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      ms,
      false,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** The longest wait the SDK honours from `Retry-After`. */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Backoff before retry `n` (1-based), BEHAVIOR.md §4.3:
 * `min(0.5 × 2^(n−1), 8) × (1 − 0.25 × r)` seconds, returned in milliseconds.
 */
export function backoffMs(retry: number, random: number = Math.random()): number {
  return Math.min(0.5 * 2 ** (retry - 1), 8) * (1 - 0.25 * random) * 1000;
}

/**
 * Parses `Retry-After` (delay seconds or an HTTP date) into milliseconds, capped at 60 s.
 * Returns undefined when the header is absent or unparsable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.min(Number.parseFloat(text) * 1000, MAX_RETRY_AFTER_MS);
  // HTTP dates always name the day or month; this keeps Date.parse from accepting "-1".
  if (!/[a-z]/i.test(text)) return undefined;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

const retryAfter = new WeakMap<object, number>();

/** Remembers the `Retry-After` of the response an error came from. */
export function setRetryAfter(error: BakbakError, ms: number | undefined): BakbakError {
  if (ms !== undefined) retryAfter.set(error, ms);
  return error;
}

/** How long to wait before retry `n` (1-based) after `error`. */
export function retryDelayMs(error: unknown, retry: number): number {
  const fromHeader = typeof error === 'object' && error !== null ? retryAfter.get(error) : undefined;
  return fromHeader ?? backoffMs(retry);
}

/** A cheap "wake me up" primitive for single-threaded producer/consumer queues. */
export class Signal {
  #waiters: Array<() => void> = [];

  wait(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  notify(): void {
    if (this.#waiters.length === 0) return;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}

/** A monotonic clock in milliseconds. */
export const now = (): number => performance.now();
