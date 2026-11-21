import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, Bakbak, BakbakError } from '../../src/index';

const SECRET = 'sk_live_SECRET123';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Everything reachable from an error, as a person or a logger would see it. */
function everything(err: unknown): string {
  return [
    String(err),
    (err as Error).message,
    (err as Error).stack,
    inspect(err, { depth: Number.POSITIVE_INFINITY, showHidden: true }),
    JSON.stringify(err),
  ].join('\n');
}

describe('API key validation (BEHAVIOR.md §8)', () => {
  for (const key of [
    `${SECRET}\n`,
    `${SECRET}\nX-Other: 1`,
    `${SECRET}\0`,
    `${SECRET}\r\n\r\nGET`,
    `sk live`,
    `${SECRET}’`,
    ' ',
  ]) {
    it(`refuses ${JSON.stringify(key)} without echoing it`, () => {
      let err: unknown;
      try {
        new Bakbak({ apiKey: key });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BakbakError);
      expect((err as Error).message).toMatch(/whitespace, control or non-ASCII/);
      expect(everything(err)).not.toContain('SECRET');
    });
  }

  it('accepts a key read from the environment with a trailing newline (it is trimmed)', () => {
    vi.stubEnv('BAKBAK_API_KEY', `${SECRET}\n`);
    expect(() => new Bakbak()).not.toThrow();
    vi.unstubAllEnvs();
  });
});

describe('the key never reaches an error', () => {
  it('scrubs it from wrapped fetch errors and keeps only sanitised causes', async () => {
    const client = new Bakbak({
      apiKey: SECRET,
      baseURL: 'http://api.invalid',
      maxRetries: 0,
      fetch: async () => {
        const inner = Object.assign(new Error(`invalid header value: x-api-key: ${SECRET}`), {
          code: 'UND_ERR_INVALID_ARG',
          headers: { 'x-api-key': SECRET },
          request: { headers: [['x-api-key', SECRET]] },
        });
        throw new TypeError('fetch failed', { cause: inner });
      },
    });
    const err = await client.voices.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(everything(err)).not.toContain('SECRET');
    // The useful parts survive: names, codes and the scrubbed messages.
    const cause = (err as { cause?: { cause?: { code?: string; message?: string } } }).cause;
    expect(cause?.cause?.code).toBe('UND_ERR_INVALID_ARG');
    expect(cause?.cause?.message).toBe('invalid header value: x-api-key: ***');
  });

  it('scrubs it from WebSocket transport failures', async () => {
    class ThrowingWebSocket {
      constructor() {
        throw new Error(`cannot open wss://h/ws?X-API-Key=${SECRET}`);
      }
    }
    vi.stubGlobal('WebSocket', ThrowingWebSocket);
    const ws = new Bakbak({
      apiKey: SECRET,
      baseURL: 'http://api.invalid',
      webSocket: 'global',
      maxRetries: 0,
    }).tts.websocket();
    const err = await ws.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(everything(err)).not.toContain('SECRET');
    await ws.close();
  });

  it('keeps it out of inspect() and String() of the client and its objects', () => {
    const client = new Bakbak({ apiKey: SECRET });
    const ws = client.tts.websocket({ voice_id: 'v', language: 'hi' });
    const ctx = ws.context();
    for (const value of [client, client.tts, client.voices, ws, ctx]) {
      expect(inspect(value, { depth: Number.POSITIVE_INFINITY, showHidden: true })).not.toContain('SECRET');
      expect(String(value)).not.toContain('SECRET');
      expect(JSON.stringify(value) ?? '').not.toContain('SECRET');
    }
  });
});
