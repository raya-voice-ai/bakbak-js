import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APIConnectionError,
  APITimeoutError,
  Bakbak,
  BakbakError,
  StreamInterruptedError,
  type TTSParams,
  VERSION,
} from '../../src/index';
import { recordingSleep } from '../helpers';

const PARAMS: TTSParams = { text: 'नमस्ते', voice_id: 'v1', language: 'hi', model: 'm1' };

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

interface Server {
  url: string;
  requests: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }>;
  sockets: number;
  close(): Promise<void>;
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  vi.unstubAllEnvs();
});

async function serve(handler: Handler): Promise<Server> {
  const requests: Server['requests'] = [];
  let sockets = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  server.on('connection', () => sockets++);
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  const s: Server = {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    requests,
    get sockets() {
      return sockets;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  servers.push(s);
  return s;
}

const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const chunk = (bytes: number[]) => ({
  type: 'chunk',
  status_code: 206,
  done: false,
  data: Buffer.from(bytes).toString('base64'),
  step_time: 0.01,
});
const DONE = { type: 'done', status_code: 200, done: true };

describe('configuration', () => {
  it('requires a key, naming the option and the variable', () => {
    vi.stubEnv('BAKBAK_API_KEY', '');
    expect(() => new Bakbak()).toThrow(BakbakError);
    expect(() => new Bakbak()).toThrow(/apiKey.*BAKBAK_API_KEY/);
  });

  it('reads BAKBAK_API_KEY and BAKBAK_BASE_URL at construction', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"voices":[],"count":0}');
    });
    vi.stubEnv('BAKBAK_API_KEY', 'env-key');
    vi.stubEnv('BAKBAK_BASE_URL', `${server.url}/`);
    const client = new Bakbak();
    expect(client.baseURL).toBe(server.url);
    await client.voices.list();
    expect(server.requests[0]?.headers['x-api-key']).toBe('env-key');
  });

  it('defaults to the production URL', () => {
    vi.stubEnv('BAKBAK_BASE_URL', '');
    expect(new Bakbak({ apiKey: 'k' }).baseURL).toBe('https://hub.getraya.app');
  });

  it('validates numeric options', () => {
    expect(() => new Bakbak({ apiKey: 'k', timeout: 0 })).toThrow(/timeout/);
    expect(() => new Bakbak({ apiKey: 'k', maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => new Bakbak({ apiKey: 'k', timeout: Number.POSITIVE_INFINITY })).not.toThrow();
  });

  it('does not expose the key when the client is inspected', () => {
    const client = new Bakbak({ apiKey: 'sk-secret-123' });
    expect(JSON.stringify(client)).not.toContain('sk-secret-123');
    expect(String(Object.values(client))).not.toContain('sk-secret-123');
  });
});

describe('requests', () => {
  it('sends identity headers, default and per-call headers, and extraBody', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav', 'x-request-id': 'req_1' }).end(Buffer.from('RIFF'));
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url, defaultHeaders: { 'X-Team': 'a' } });
    await client.tts.generate(PARAMS, { headers: { 'X-Trace': 't' }, extraBody: { new_field: 1 } });
    const req = server.requests[0];
    expect(req?.url).toBe('/v1/text-to-speech');
    expect(req?.headers['user-agent']).toBe(
      `bakbak-js/${VERSION} node/${process.versions.node} ${process.platform}/${process.arch}`,
    );
    expect(req?.headers['x-bakbak-client']).toBe(`bakbak-js/${VERSION}`);
    expect(req?.headers['x-team']).toBe('a');
    expect(req?.headers['x-trace']).toBe('t');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req?.body ?? '')).toEqual({ ...PARAMS, new_field: 1 });
  });

  it('returns whole-file audio with its metadata and an aligned buffer', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(200, {
        'content-type': 'audio/pcm',
        'x-request-id': 'req_2',
        'x-audio-format': 'pcm_s16le',
        'x-audio-sample-rate': '16000',
      });
      res.write(Buffer.from([1, 0]));
      res.end(Buffer.from([2, 0, 3, 0]));
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    const audio = await client.tts.generate(PARAMS);
    expect([...audio.data]).toEqual([1, 0, 2, 0, 3, 0]);
    expect(audio.data.byteOffset).toBe(0);
    expect(audio).toMatchObject({ requestId: 'req_2', encoding: 'pcm_s16le', sampleRate: 16000 });
    expect(audio.toWav().length).toBe(44 + 6);
  });

  it('reuses one connection across calls', async () => {
    const server = await serve((req, _body, res) => {
      if (req.url === '/v1/voices') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"voices":[],"count":0}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'r' });
      res.end(sse([chunk([1, 2, 3, 4]), DONE]));
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    // undici returns a socket to its pool a moment after the body ends; give it that moment,
    // as any real gap between calls does.
    const settle = () => new Promise((r) => setTimeout(r, 5));
    await client.warmup();
    await settle();
    for (let i = 0; i < 3; i++) {
      await client.tts.stream(PARAMS).bytes();
      await settle();
    }
    expect(server.requests.length).toBe(4);
    expect(server.sockets).toBe(1);
  });

  it('honours an HTTP-date Retry-After', async () => {
    let n = 0;
    const server = await serve((_req, _body, res) => {
      if (n++ === 0) {
        const at = new Date(Date.now() + 3_000).toUTCString();
        res
          .writeHead(503, { 'content-type': 'application/json', 'retry-after': at })
          .end('{"detail":"busy"}');
      } else {
        res.writeHead(200, { 'content-type': 'audio/wav' }).end('RIFF');
      }
    });
    const sleeps: number[] = [];
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url, sleep: recordingSleep(sleeps) });
    await client.tts.generate(PARAMS);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1);
    expect(sleeps[0]).toBeLessThanOrEqual(3);
  });

  it('rejects with the abort reason and does not retry', async () => {
    const server = await serve(() => {
      // never answers
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    const controller = new AbortController();
    const pending = client.tts.generate(PARAMS, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 50);
    await expect(pending).rejects.toThrow('stop');
    expect(server.requests.length).toBe(1);
  });

  it('maps a refused connection to a retryable APIConnectionError', async () => {
    const server = await serve(() => {});
    const url = server.url;
    await server.close();
    servers = [];
    const sleeps: number[] = [];
    const client = new Bakbak({ apiKey: 'k', baseURL: url, sleep: recordingSleep(sleeps) });
    const err = await client.tts.generate(PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect((err as APIConnectionError).retryable).toBe(true);
    expect(sleeps).toHaveLength(2);
  });
});

describe('read timeout: an inactivity timer between chunks', () => {
  it('times out a stream that stalls before audio, and retries it', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\n\n'); // bytes, but no audio, then silence
    });
    const sleeps: number[] = [];
    const client = new Bakbak({
      apiKey: 'k',
      baseURL: server.url,
      timeout: 150,
      sleep: recordingSleep(sleeps),
    });
    const err = await client.tts
      .stream(PARAMS)
      .bytes()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(server.requests.length).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('raises StreamInterruptedError when a stream stalls after audio, without retrying', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_s' });
      res.write(sse([chunk([1, 2, 3, 4])]));
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url, timeout: 150 });
    const started = Date.now();
    const got: Uint8Array[] = [];
    const err = await (async () => {
      for await (const c of client.tts.stream({
        ...PARAMS,
        output_format: { container: 'raw', encoding: 'pcm_s16le' },
      }))
        got.push(c.audio);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamInterruptedError);
    expect((err as StreamInterruptedError).audioBytes).toBe(4);
    expect((err as StreamInterruptedError).requestId).toBe('req_s');
    expect(got).toHaveLength(1);
    expect(server.requests.length).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('keeps a slow but steady stream alive past the timeout', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        if (i++ < 6) res.write(sse([chunk([i, 0])]));
        else {
          clearInterval(timer);
          res.end(sse([DONE]));
        }
      }, 60);
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url, timeout: 150 });
    const bytes = await client.tts
      .stream({ ...PARAMS, output_format: { container: 'raw', encoding: 'pcm_s16le' } })
      .bytes();
    expect(bytes.length).toBe(12); // 6 × 2 bytes over ~420 ms, never 150 ms of silence
  });

  it('raises StreamInterruptedError when a whole-file body stalls after its first bytes', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav', 'x-request-id': 'req_g' });
      res.write(Buffer.from('RIFF1234'));
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url, timeout: 150 });
    const err = await client.tts.generate(PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamInterruptedError);
    expect(err).toMatchObject({ audioBytes: 8, requestId: 'req_g', retryable: true });
    expect(server.requests.length).toBe(1);
  });

  it('accepts a per-call timeout', async () => {
    const server = await serve(() => {});
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url, maxRetries: 0 });
    const started = Date.now();
    await expect(client.tts.generate(PARAMS, { timeout: 100 })).rejects.toBeInstanceOf(APITimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('AudioStream', () => {
  const f32 = new Float32Array([0.5, -0.5, 0.25, 1]);
  const bytes = [...new Uint8Array(f32.buffer)];

  async function f32Server(): Promise<Server> {
    // 16 bytes of float32 split mid-sample: 3 + 6 + 7.
    return serve((_req, _body, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-request-id': 'req_f',
        'x-audio-format': 'pcm_f32le',
        'x-audio-sample-rate': '24000',
      });
      res.end(sse([chunk(bytes.slice(0, 3)), chunk(bytes.slice(3, 9)), chunk(bytes.slice(9)), DONE]));
    });
  }

  it('never hands out a partial sample', async () => {
    const server = await f32Server();
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    const sizes: number[] = [];
    const out: number[] = [];
    for await (const c of client.tts.stream(PARAMS)) {
      sizes.push(c.audio.length);
      out.push(...new Float32Array(c.audio.buffer, c.audio.byteOffset, c.audio.length / 4));
    }
    expect(sizes.every((n) => n % 4 === 0)).toBe(true);
    expect(out).toEqual([...f32]);
  });

  it('collects into bytes, an ArrayBuffer, an Audio or a ReadableStream', async () => {
    const server = await f32Server();
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    expect([...(await client.tts.stream(PARAMS).bytes())]).toEqual(bytes);
    expect((await client.tts.stream(PARAMS).arrayBuffer()).byteLength).toBe(16);
    const audio = await client.tts.stream(PARAMS).toAudio();
    expect(audio).toMatchObject({ requestId: 'req_f', encoding: 'pcm_f32le', sampleRate: 24000 });
    expect(audio.contentType).toBe('audio/pcm');
    expect(audio.toWav().length).toBe(58 + 16);
    const reader = client.tts.stream(PARAMS).toReadableStream().getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
    }
    expect(total).toBe(16);
  });

  it('exposes the request id and metadata, and can be read only once', async () => {
    const server = await f32Server();
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    const stream = client.tts.stream(PARAMS);
    expect(await stream.requestId).toBe('req_f');
    expect(stream.encoding).toBe('pcm_f32le');
    expect(stream.sampleRate).toBe(24000);
    await stream.bytes();
    expect(() => stream[Symbol.asyncIterator]()).toThrow(BakbakError);
  });

  it('starts the request before it is iterated', async () => {
    const server = await f32Server();
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    const stream = client.tts.stream(PARAMS);
    await vi.waitFor(() => expect(server.requests.length).toBe(1));
    await stream.bytes();
  });

  it('rejects requestId when the stream fails before audio, without an unhandled rejection', async () => {
    const server = await serve((_req, _body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Unauthorized"}');
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    const stream = client.tts.stream(PARAMS);
    await expect(stream.requestId).rejects.toThrow('Unauthorized');
  });

  it('stops the request when the consumer breaks out', async () => {
    let closed = false;
    const server = await serve((req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse([chunk([1, 2, 3, 4])]));
      req.socket.on('close', () => {
        closed = true;
      });
    });
    const client = new Bakbak({ apiKey: 'k', baseURL: server.url });
    for await (const _ of client.tts.stream(PARAMS)) break;
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});
