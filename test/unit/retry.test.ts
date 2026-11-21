import { describe, expect, it } from 'vitest';
import { backoffMs, MAX_RETRY_AFTER_MS, parseRetryAfter } from '../../src/core/util';

describe('Retry-After', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');

  it('parses delay seconds', () => {
    expect(parseRetryAfter('1', now)).toBe(1000);
    expect(parseRetryAfter(' 2 ', now)).toBe(2000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('1.5', now)).toBe(1500);
  });

  it('parses an HTTP date', () => {
    expect(parseRetryAfter('Sat, 21 Nov 2026 10:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Sat, 21 Nov 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('caps the wait at 60 s', () => {
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
    expect(parseRetryAfter('3600', now)).toBe(60_000);
    expect(parseRetryAfter('Sun, 22 Nov 2026 10:00:00 GMT', now)).toBe(60_000);
  });

  it('ignores absent or unparsable values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-1', now)).toBeUndefined();
  });
});

describe('backoff (BEHAVIOR.md §4.3)', () => {
  it('waits min(0.5 × 2^(n−1), 8) × (1 − 0.25 r) seconds', () => {
    expect(backoffMs(1, 0)).toBe(500);
    expect(backoffMs(1, 0.999999)).toBeCloseTo(375, 0);
    expect(backoffMs(2, 0)).toBe(1000);
    expect(backoffMs(3, 0)).toBe(2000);
    expect(backoffMs(5, 0)).toBe(8000);
    expect(backoffMs(9, 0)).toBe(8000);
    expect(backoffMs(9, 0.5)).toBe(7000);
  });

  it('stays within the documented ranges', () => {
    const ranges: Array<[number, number, number]> = [
      [1, 375, 500],
      [2, 750, 1000],
      [3, 1500, 2000],
    ];
    for (const [n, min, max] of ranges) {
      for (let i = 0; i < 200; i++) {
        const ms = backoffMs(n);
        expect(ms).toBeGreaterThan(min - 1e-9);
        expect(ms).toBeLessThanOrEqual(max);
      }
    }
  });
});
