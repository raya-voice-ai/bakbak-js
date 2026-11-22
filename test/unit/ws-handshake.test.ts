/**
 * BEHAVIOR.md §6.1: the WHATWG WebSocket hides why a handshake failed, so the client asks
 * with one plain GET to the same URL, the key placed the same way. A fake global WebSocket
 * fails every handshake; a fake fetch plays the API's answer to the GET.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Node 22+ (the key in a header) or Bun (the key in the query string), as each test sets.
const runtime = vi.hoisted(() => ({ keyInHeader: true }));
vi.mock('../../src/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/runtime')>();
  return {
    ...actual,
    detectRuntime: () =>
      runtime.keyInHeader
        ? actual.detectRuntime({
            process: { versions: { node: '24.0.0', undici: '7.0.0' }, platform: 'linux', arch: 'x64' },
          })
        : actual.detectRuntime({ Bun: { version: '1.2.0' }, process: { versions: { node: '24' } } }),
  };
});

const { APIConnectionError, APIStatusError, AuthenticationError, Bakbak, InternalServerError } = await import(
  '../../src/index'
);
type ClientOptions = import('../../src/index').ClientOptions;

const KEY = 'sk_handshake_secret/+=';
const BASE = 'https://api.example';
const WS_URL = 'wss://api.example/v1/text-to-speech/ws';
const PROBE_URL = 'https://api.example/v1/text-to-speech/ws';

interface Attempt {
  url: string;
  options: unknown;
}

/** A global WebSocket whose every handshake fails, reporting it as browsers do: error, then close. */
function failingWebSocket(attempts: Attempt[]) {
  return class FakeWebSocket {
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onmessage: (() => void) | null = null;
    constructor(url: string, options?: unknown) {
      attempts.push({ url, options });
      setTimeout(() => {
        this.onerror?.();
        this.onclose?.({ code: 1006, reason: '' });
      }, 0);
    }
    send(): void {}
    close(): void {}
  };
}

interface Probe {
  url: string;
  init: RequestInit;
}

function setup(answer: (probe: Probe) => Promise<Response>, options: ClientOptions = {}) {
  const attempts: Attempt[] = [];
  const probes: Probe[] = [];
  const logs: string[] = [];
  vi.stubGlobal('WebSocket', failingWebSocket(attempts));
  const client = new Bakbak({
    apiKey: KEY,
    baseURL: BASE,
    webSocket: 'global',
    maxRetries: 2,
    sleep: async () => {},
    logger: { debug: (m, f) => logs.push(`${m} ${JSON.stringify(f)}`) },
    fetch: (url, init) => {
      const probe = { url, init };
      probes.push(probe);
      return answer(probe);
    },
    ...options,
  });
  const ws = client.tts.websocket({ voice_id: 'v', language: 'hi' });
  return { ws, attempts, probes, logs };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  runtime.keyInHeader = true;
});

describe('a failed handshake of the global WebSocket (BEHAVIOR.md §6.1)', () => {
  it('turns a 401 into an AuthenticationError at once: not retried, no further connection attempts', async () => {
    const { ws, attempts, probes, logs } = setup(async () =>
      json(
        401,
        { message: 'Invalid API key.', error_code: 'invalid_api_key' },
        { 'x-request-id': 'req_401' },
      ),
    );
    const err = await ws.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toMatchObject({
      status: 401,
      retryable: false,
      errorCode: 'invalid_api_key',
      requestId: 'req_401',
      message: 'Invalid API key.',
    });
    expect(attempts.length).toBe(1);
    expect(probes.length).toBe(1); // error and close both fired: asked once
    // A send waiting for the connection fails the same way, after one more attempt of its own.
    const ctx = ws.context();
    await expect(ctx.send({ text: 'x' }).then((r) => r.result())).rejects.toBeInstanceOf(AuthenticationError);
    expect(attempts.length).toBe(2);
    expect(logs.join('\n')).not.toContain('sk_handshake');
    await ws.close();
  });

  it('sends a plain GET to the same URL over https, with the key in the headers, never following redirects', async () => {
    const { ws, attempts, probes } = setup(async () => json(401, { message: 'Unauthorized' }));
    await ws.connect().catch(() => {});
    expect(attempts[0]?.url).toBe(WS_URL);
    expect(attempts[0]?.options).toMatchObject({ headers: { 'X-API-Key': KEY } });
    const probe = probes[0] as Probe;
    expect(probe.url).toBe(PROBE_URL);
    expect(probe.init.method).toBe('GET');
    expect(probe.init.redirect).toBe('manual');
    expect(probe.init.signal).toBeInstanceOf(AbortSignal);
    expect(probe.init.headers).toMatchObject({ 'X-API-Key': KEY });
    expect(probe.init.headers).toEqual((attempts[0]?.options as { headers?: unknown } | undefined)?.headers);
    await ws.close();
  });

  it('puts the key in the query string of the GET where the WebSocket had it there', async () => {
    runtime.keyInHeader = false;
    const { ws, attempts, probes, logs } = setup(async () => json(401, { message: 'Unauthorized' }));
    const err = await ws.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    const query = `?X-API-Key=${encodeURIComponent(KEY)}`;
    expect(attempts[0]).toEqual({ url: `${WS_URL}${query}`, options: undefined });
    expect(probes[0]?.url).toBe(`${PROBE_URL}${query}`);
    expect(probes[0]?.init.headers).toEqual({});
    expect(logs.join('\n')).toContain('X-API-Key=***');
    expect(logs.join('\n')).not.toContain('sk_handshake');
    await ws.close();
  });

  it('keeps a retryable APIConnectionError when the GET gets a 426: the key and URL are good', async () => {
    const { ws, attempts, probes } = setup(async () => json(426, { message: 'Upgrade Required' }));
    const err = await ws.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err).toMatchObject({ retryable: true });
    expect((err as Error).message).toMatch(
      /accepted the key and URL over HTTP: the network or a proxy refused/,
    );
    expect(attempts.length).toBe(3); // retried as usual
    expect(probes.length).toBe(3);
    await ws.close();
  });

  for (const [name, answer] of [
    ['the GET fails', async () => Promise.reject(new TypeError(`fetch failed for ${KEY}`))],
    ['the GET succeeds', async () => new Response('ok', { status: 200 })],
  ] as const) {
    it(`keeps a retryable APIConnectionError when ${name}`, async () => {
      const { ws, attempts, logs } = setup(answer);
      const err = await ws.connect().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(APIConnectionError);
      expect(err).toMatchObject({ retryable: true });
      expect((err as Error).message).toMatch(/handshake failed/);
      expect(attempts.length).toBe(3);
      expect(logs.join('\n')).not.toContain('sk_handshake');
      await ws.close();
    });
  }

  it('gives up on the GET after the connect timeout', async () => {
    const { ws, probes } = setup(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { connectTimeout: 50, maxRetries: 0 },
    );
    const started = Date.now();
    const err = await ws.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(probes[0]?.init.signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    await ws.close();
  });

  it('turns a redirect into the error the ws transport raises, without following it', async () => {
    const { ws, attempts } = setup(
      async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
    );
    const err = await ws.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toMatchObject({ status: 302, retryable: false });
    expect((err as Error).message).toMatch(/never follows/);
    expect(attempts.length).toBe(1);
    await ws.close();
  });

  it('retries a status the body or status calls retryable, as the ws transport does', async () => {
    const { ws, attempts } = setup(async () => json(503, { message: 'Busy.', retryable: true }));
    const err = await ws.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerError);
    expect(err).toMatchObject({ status: 503, retryable: true });
    expect(attempts.length).toBe(3);
    await ws.close();
  });
});
