import { afterEach, describe, expect, it, vi } from 'vitest';

// Simulate a browser: the client sees a browser runtime, as it would with window and document.
vi.mock('../../src/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/runtime')>();
  return {
    ...actual,
    detectRuntime: () =>
      actual.detectRuntime({ window: {}, document: {}, navigator: { userAgent: 'Mozilla/5.0' } }),
  };
});

const { Bakbak, BakbakError } = await import('../../src/index');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dangerouslyAllowBrowser (BEHAVIOR.md §8)', () => {
  it('refuses to run in a browser with an API key, and says why', () => {
    expect(() => new Bakbak({ apiKey: 'k' })).toThrow(BakbakError);
    expect(() => new Bakbak({ apiKey: 'k' })).toThrow(/visible to anyone using the page/);
    expect(() => new Bakbak({ apiKey: 'k' })).toThrow(/dangerouslyAllowBrowser/);
  });

  it('runs when allowed, sending only CORS-allowed headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new Bakbak({
      apiKey: 'k',
      baseURL: 'https://api.example',
      dangerouslyAllowBrowser: true,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response('{"voices":[],"count":0}', { status: 200 });
      },
    });
    await client.voices.list();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'X-API-Key']);
  });

  it('puts the key in the WebSocket URL, and logs it only redacted', async () => {
    const urls: string[] = [];
    class FakeWebSocket {
      binaryType = 'blob';
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor(url: string, options?: unknown) {
        urls.push(url);
        expect(options).toBeUndefined(); // browsers cannot send headers
        setTimeout(() => this.onerror?.(), 0);
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const logs: string[] = [];
    const probes: Array<{ url: string; init: RequestInit }> = [];
    const client = new Bakbak({
      apiKey: 'sk_secret/+=',
      baseURL: 'https://api.example',
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
      logger: { debug: (m, f) => logs.push(`${m} ${JSON.stringify(f)}`) },
      // The browser hides why the handshake failed; the GET sent to find out gets no answer.
      fetch: async (url, init) => {
        probes.push({ url, init });
        throw new TypeError('Failed to fetch');
      },
    });
    const ws = client.tts.websocket();
    await expect(ws.connect()).rejects.toThrow(/handshake failed/);
    const query = `?X-API-Key=${encodeURIComponent('sk_secret/+=')}`;
    expect(urls).toEqual([`wss://api.example/v1/text-to-speech/ws${query}`]);
    // The same URL over https, the key in the same place: no headers, so no CORS preflight.
    expect(probes.map((p) => [p.url, p.init.headers])).toEqual([
      [`https://api.example/v1/text-to-speech/ws${query}`, {}],
    ]);
    expect(logs.join('\n')).toContain('X-API-Key=***');
    expect(logs.join('\n')).not.toContain('sk_secret');
    await ws.close();
  });
});
