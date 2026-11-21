import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import * as sdk from '../src/index';

export const CONFORMANCE = new URL('../conformance/', import.meta.url);

export function loadScenarios<T>(kind: 'http' | 'ws'): T[] {
  const dir = new URL(`${kind}/`, CONFORMANCE);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as T);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** README "Subset match": every expected key is present in actual with an equal value. */
export function subsetMismatch(expected: Record<string, unknown>, actual: unknown): string | undefined {
  if (typeof actual !== 'object' || actual === null)
    return `expected an object, got ${JSON.stringify(actual)}`;
  for (const [key, value] of Object.entries(expected)) {
    const got = (actual as Record<string, unknown>)[key];
    if (!deepEqual(got, value))
      return `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`;
  }
  return undefined;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export interface ExpectedError {
  class: string;
  status?: number | null;
  error_code?: string | null;
  retryable?: boolean;
  request_id?: string | null;
  message?: string;
  message_contains?: string;
  audio_bytes?: number;
  body_fields?: Record<string, unknown>;
}

/** README "An error object is matched on class, then each other key present". */
export function expectError(err: unknown, exp: ExpectedError): void {
  expect(err, 'an error was expected').toBeInstanceOf(Error);
  const e = err as sdk.BakbakError & { audioBytes?: number };
  const Cls = (sdk as unknown as Record<string, new (...args: never[]) => unknown>)[exp.class];
  expect(Cls, `unknown error class ${exp.class}`).toBeTypeOf('function');
  expect(e.name, `class (message: ${e.message})`).toBe(exp.class);
  expect(e).toBeInstanceOf(Cls as new (...args: never[]) => unknown);
  const absent = (v: unknown) => (v === null ? undefined : v);
  if ('status' in exp) expect(e.status, 'status').toBe(absent(exp.status));
  if ('error_code' in exp) expect(e.errorCode, 'error_code').toBe(absent(exp.error_code));
  if ('retryable' in exp) expect(e.retryable, 'retryable').toBe(exp.retryable);
  if ('request_id' in exp) expect(e.requestId, 'request_id').toBe(absent(exp.request_id));
  if (exp.message !== undefined) expect(e.message, 'message').toBe(exp.message);
  if (exp.message_contains !== undefined) expect(e.message, 'message').toContain(exp.message_contains);
  if (exp.audio_bytes !== undefined) expect(e.audioBytes, 'audio_bytes').toBe(exp.audio_bytes);
  if (exp.body_fields) expect(subsetMismatch(exp.body_fields, e.body), 'body_fields').toBeUndefined();
}

/** README "sleeps": the waits asked for, in order, each within [min, max] seconds. */
export function expectSleeps(actual: number[], expected: Array<[number, number]>): void {
  expect(actual.length, `sleeps ${JSON.stringify(actual)}`).toBe(expected.length);
  expected.forEach(([min, max], i) => {
    const s = actual[i] as number;
    expect(s, `sleep ${i}`).toBeGreaterThanOrEqual(min - 1e-9);
    expect(s, `sleep ${i}`).toBeLessThanOrEqual(max + 1e-9);
  });
}

/** A sleep that records its argument in seconds and returns at once. */
export function recordingSleep(into: number[]): sdk.SleepFn {
  return async (ms) => {
    into.push(ms / 1000);
  };
}

export async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
