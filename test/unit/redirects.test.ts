/** BEHAVIOR.md §8: never follow redirects; following one would hand X-API-Key to another origin. */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { APIConnectionError, APIStatusError, Bakbak, InternalServerError } from '../../src/index';

const KEY = 'sk_live_redirect_test';
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

/** Another origin that records anything that reaches it. */
async function elsewhere(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} key=${String(req.headers['x-api-key'])}`);
    res.end('{}');
  });
  server.on('upgrade', (req, socket: Socket) => {
    seen.push(`upgrade ${req.url} key=${String(req.headers['x-api-key'])}`);
    socket.destroy();
  });
  return { url: await listen(server), seen };
}

/** The API origin, answering every request and upgrade with a 302 to `target`. */
async function redirecting(target: string): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(302, { location: `${target}${req.url}`, 'x-request-id': 'req_302' }).end();
  });
  server.on('upgrade', (req, socket: Socket) => {
    hits++;
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: ${target.replace('http', 'ws')}${req.url}\r\nX-Request-Id: req_302\r\nContent-Length: 0\r\n\r\n`,
    );
  });
  return { url: await listen(server), hits: () => hits };
}

const PARAMS = { text: 'x', voice_id: 'v', language: 'hi' };

describe('redirects are never followed', () => {
  const calls: Array<[string, (c: Bakbak) => Promise<unknown>]> = [
    ['generate', (c) => c.tts.generate(PARAMS)],
    ['stream', (c) => c.tts.stream(PARAMS).bytes()],
    ['voices.list', (c) => c.voices.list()],
  ];
  for (const [name, call] of calls) {
    it(`${name}: a 302 to another origin is an APIStatusError and the key stays home`, async () => {
      const other = await elsewhere();
      const api = await redirecting(other.url);
      const client = new Bakbak({ apiKey: KEY, baseURL: api.url });
      const err = await call(client).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(APIStatusError);
      expect((err as APIStatusError).constructor).toBe(APIStatusError);
      expect(err).toMatchObject({ status: 302, retryable: false, requestId: 'req_302' });
      expect((err as Error).message).toMatch(/never follows/);
      expect(api.hits()).toBe(1); // not retried
      expect(other.seen).toEqual([]);
    });
  }

  it('asks fetch not to follow, and maps a browser opaque redirect too', async () => {
    const inits: RequestInit[] = [];
    const client = new Bakbak({
      apiKey: KEY,
      baseURL: 'https://api.example',
      fetch: async (_url, init) => {
        inits.push(init);
        return {
          type: 'opaqueredirect',
          status: 0,
          ok: false,
          headers: new Headers(),
          body: null,
        } as unknown as Response;
      },
    });
    const err = await client.voices.list().catch((e: unknown) => e);
    expect(inits[0]?.redirect).toBe('manual');
    expect(err).toBeInstanceOf(APIStatusError);
    expect((err as APIStatusError).status).toBeUndefined();
    expect(err).not.toBeInstanceOf(InternalServerError);
  });

  it('WebSocket (ws): a 302 on the upgrade is an APIStatusError and the key stays home', async () => {
    const other = await elsewhere();
    const api = await redirecting(other.url);
    const ws = new Bakbak({ apiKey: KEY, baseURL: api.url, webSocket: 'ws' }).tts.websocket();
    const err = await ws.connect().catch((e: unknown) => e);
    await ws.close();
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toMatchObject({ status: 302, retryable: false });
    expect(api.hits()).toBe(1);
    expect(other.seen).toEqual([]);
  });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  it.skipIf(nodeMajor < 22)(
    'WebSocket (global): a redirected upgrade fails and the key stays home',
    async () => {
      const other = await elsewhere();
      const api = await redirecting(other.url);
      const ws = new Bakbak({
        apiKey: KEY,
        baseURL: api.url,
        webSocket: 'global',
        maxRetries: 0,
      }).tts.websocket();
      const err = await ws.connect().catch((e: unknown) => e);
      await ws.close();
      expect(err).toBeInstanceOf(APIConnectionError);
      expect(other.seen).toEqual([]);
    },
  );
});
