import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  APITimeoutError,
  Bakbak,
  BakbakError,
  type ClientOptions,
  type ContextEvent,
  InternalServerError,
  type TTSWebSocket,
  WebSocketClosedError,
} from '../../src/index';
import { recordingSleep, waitFor } from '../helpers';

interface Peer {
  ws: WsSocket;
  headers: http.IncomingHttpHeaders;
  received: Array<Record<string, unknown>>;
}

interface Mock {
  url: string;
  peers: Peer[];
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A ws server; `onMessage` answers each request (or does nothing). */
async function mock(onMessage: (peer: Peer, msg: Record<string, unknown>) => void = () => {}): Promise<Mock> {
  const peers: Peer[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const peer: Peer = { ws, headers: req.headers, received: [] };
    peers.push(peer);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      peer.received.push(msg);
      onMessage(peer, msg);
    });
  });
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  const m: Mock = {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    peers,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  cleanups.push(m.close);
  return m;
}

function socketFor(m: Mock, options: ClientOptions = {}): TTSWebSocket {
  const client = new Bakbak({ apiKey: 'test-key', baseURL: m.url, sleep: async () => {}, ...options });
  const ws = client.tts.websocket({ voice_id: 'v1', language: 'hi', model: 'm1' });
  cleanups.unshift(() => ws.close());
  return ws;
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

function answer(
  peer: Peer,
  msg: Record<string, unknown>,
  bytes: number[] = [1, 2, 3, 4],
  id = 'req_x',
): void {
  const base = { context_id: msg.context_id, request_id: id };
  peer.ws.send(JSON.stringify({ type: 'chunk', status_code: 206, done: false, data: b64(bytes), ...base }));
  peer.ws.send(JSON.stringify({ type: 'done', status_code: 200, done: true, ...base }));
}

function drainRefusal(msg: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'error',
    status_code: 503,
    done: true,
    error_code: 'service_unavailable',
    message: 'The service is restarting. Reconnect and send the request again.',
    retryable: true,
    context_id: msg.context_id,
    request_id: 'req_refused',
  };
}

async function drain(events: AsyncIterable<ContextEvent>): Promise<ContextEvent[]> {
  const out: ContextEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('WebSocket: connection', () => {
  it('sends the key and identity headers, and offers no compression (ws transport)', async () => {
    const m = await mock();
    const ws = socketFor(m);
    await ws.connect();
    expect(ws.connected).toBe(true);
    const headers = m.peers[0]?.headers ?? {};
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['user-agent']).toMatch(/^bakbak-js\/\S+ node\//);
    expect(headers['x-bakbak-client']).toMatch(/^bakbak-js\//);
    expect(headers['sec-websocket-extensions']).toBeUndefined();
  });

  it('opens lazily on the first send, and only once for concurrent sends', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const a = ws.context();
    const b = ws.context();
    await Promise.all([a.send({ text: 'one' }), b.send({ text: 'two' })]);
    a.endInput();
    b.endInput();
    await Promise.all([drain(a.events()), drain(b.events())]);
    expect(m.peers.length).toBe(1);
  });

  it('fails every unfinished request when closed by the client', async () => {
    const m = await mock(); // never answers
    const ws = socketFor(m);
    const ctx = ws.context();
    const req = await ctx.send({ text: 'x' });
    const events = drain(ctx.events());
    await ws.close();
    await expect(req.result()).rejects.toBeInstanceOf(WebSocketClosedError);
    const got = await events;
    expect(got.map((e) => e.type)).toEqual(['failed']);
    await expect(ctx.send({ text: 'y' })).rejects.toThrow(BakbakError);
  });
});

describe('WebSocket: contexts', () => {
  it('generates ids and validates given ones before sending anything', async () => {
    const m = await mock();
    const ws = socketFor(m);
    expect(ws.context().contextId).toMatch(/^ctx_[0-9a-f]{32}$/);
    expect(() => ws.context({ contextId: 'bad id' })).toThrow(BakbakError);
    expect(() => ws.context({ contextId: 'x'.repeat(129) })).toThrow(BakbakError);
    expect(m.peers.length).toBe(0);
  });

  it('merges defaults: handle, then context, then the call; undefined never overrides', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context({ contextId: 'c', model: 'standard', speed: 1.2 });
    await ctx.send({ text: 'hi', speed: 0.9, language: undefined }, { extraBody: { future: true } });
    ctx.endInput();
    await drain(ctx.events());
    expect(m.peers[0]?.received[0]).toEqual({
      voice_id: 'v1',
      language: 'hi',
      model: 'standard',
      speed: 0.9,
      text: 'hi',
      future: true,
      context_id: 'c',
    });
  });

  it('cancels at once, sending nothing, when nothing is unfinished', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context();
    await ctx.send({ text: 'a' });
    await waitFor(() => (m.peers[0]?.received.length ?? 0) === 1, 'request');
    const events = ctx.events();
    const first = await events.next();
    const second = await events.next();
    expect([first.value?.type, second.value?.type]).toEqual(['chunk', 'done']);
    await ctx.cancel();
    expect(m.peers[0]?.received.length).toBe(1);
  });

  it('delivers each chunk once: to the request iterator or to events()', async () => {
    const m = await mock((peer, msg) => answer(peer, msg, [9, 9], String(msg.text)));
    const ws = socketFor(m);
    const ctx = ws.context();
    const one = await ctx.send({ text: 'one' });
    const two = await ctx.send({ text: 'two' });
    const audio: number[] = [];
    for await (const a of one.audio()) audio.push(...a);
    expect(audio).toEqual([9, 9]);
    expect(await one.result()).toEqual({ requestId: 'one', audioBytes: 2, cancelled: false });
    ctx.endInput();
    const rest = await drain(ctx.events());
    // one's events, its done included, went to its own iterator; each event is read once.
    expect(rest.map((e) => [e.type, e.request === two])).toEqual([
      ['chunk', true],
      ['done', true],
    ]);
  });

  it('keeps samples whole across WebSocket chunks', async () => {
    const m = await mock((peer, msg) => {
      const base = { context_id: msg.context_id, request_id: 'r' };
      for (const part of [
        [1, 2, 3],
        [4, 5],
        [6, 7, 8],
      ])
        peer.ws.send(JSON.stringify({ type: 'chunk', data: b64(part), ...base }));
      peer.ws.send(JSON.stringify({ type: 'done', done: true, ...base }));
    });
    const ws = socketFor(m);
    const ctx = ws.context();
    await ctx.send({ text: 'f32' }); // no output_format: 32-bit float
    ctx.endInput();
    const sizes: number[] = [];
    for await (const a of ctx.audio()) sizes.push(a.length);
    expect(sizes).toEqual([4, 4]);
  });
});

describe('WebSocket: resource lifetime (BEHAVIOR.md §6.6)', () => {
  it('refuses a second context with the id of a busy one', async () => {
    const m = await mock(); // never answers
    const ws = socketFor(m);
    await ws.context({ contextId: 'same' }).send({ text: 'x' });
    expect(() => ws.context({ contextId: 'same' })).toThrow(/already open/);
  });

  const CHUNK = Buffer.alloc(16_384, 7).toString('base64');
  const fourChunks = (peer: Peer, msg: Record<string, unknown>) => {
    for (let i = 0; i < 4; i++)
      peer.ws.send(
        JSON.stringify({ type: 'chunk', data: CHUNK, context_id: msg.context_id, request_id: 'r' }),
      );
    peer.ws.send(JSON.stringify({ type: 'done', done: true, context_id: msg.context_id, request_id: 'r' }));
  };
  // Retained heap and buffers, in MB, after a full collection (needs --expose-gc; else skipped).
  const gc = (globalThis as { gc?: () => void }).gc;
  const retained = () => {
    gc?.();
    gc?.();
    return (process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers) / 1e6;
  };

  for (const reader of ['req.audio()', 'ctx.events()'] as const) {
    it(`keeps memory flat over 400 turns on one context read with ${reader}`, async () => {
      const m = await mock(fourChunks);
      const ws = socketFor(m);
      const ctx = ws.context({ contextId: 'agent' });
      const events = ctx.events();
      const turn = async () => {
        const req = await ctx.send({ text: 'turn' });
        if (reader === 'req.audio()') {
          for await (const _ of req.audio()) {
            // consume
          }
        } else {
          for (;;) {
            const { value } = await events.next();
            if (value?.type !== 'chunk') break;
          }
        }
      };
      for (let i = 0; i < 50; i++) await turn();
      const base = retained();
      for (let i = 0; i < 400; i++) await turn(); // 400 × 64 KiB = 26 MB of audio read
      if (gc) expect(retained() - base).toBeLessThan(8);
    });
  }

  it('releases contexts that are idle, even without endInput()', async () => {
    const m = await mock(fourChunks);
    const ws = socketFor(m);
    const run = async () => {
      const ctx = ws.context();
      await ctx.send({ text: 'x' });
      for await (const e of ctx.events()) if (e.type !== 'chunk') break;
    };
    for (let i = 0; i < 50; i++) await run();
    const base = retained();
    for (let i = 0; i < 400; i++) await run();
    if (gc) expect(retained() - base).toBeLessThan(8);
  });

  it('lets an idle context send again after it was released', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context({ contextId: 'reuse' });
    for (let i = 0; i < 3; i++) {
      const req = await ctx.send({ text: `t${i}` });
      expect(await req.result()).toMatchObject({ audioBytes: 4 });
    }
  });
});

describe('WebSocket: sendStream', () => {
  it('sends one request per sentence as soon as each is complete, then ends input', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context();
    const sentAt: number[] = [];
    async function* tokens() {
      for (const t of ['नमस्ते', '! आपका ', 'ऑर्डर आज ', 'पहुँच जाएगा। ', 'धन्यवाद', '।']) {
        yield t;
        sentAt.push(m.peers[0]?.received.length ?? 0);
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    await ctx.sendStream(tokens());
    await drain(ctx.events());
    const texts = m.peers[0]?.received.map((r) => r.text);
    expect(texts).toEqual(['नमस्ते!', 'आपका ऑर्डर आज पहुँच जाएगा।', 'धन्यवाद।']);
    // "नमस्ते!" went out when the next token showed the sentence had ended, not at the end.
    expect(sentAt[1]).toBe(0);
    await waitFor(() => (m.peers[0]?.received.length ?? 0) >= 1, 'first sentence');
  });

  it('accepts LLM stream events and request params', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context();
    const openai = ['Hello there. ', 'How are you?'].map((content) => ({
      choices: [{ delta: { content } }],
    }));
    const anthropic = [{ type: 'message_start' }, { type: 'content_block_delta', delta: { text: ' Fine.' } }];
    await ctx.sendStream([...openai, ...anthropic], { params: { speed: 1.1 } });
    await drain(ctx.events());
    expect(m.peers[0]?.received.map((r) => [r.text, r.speed])).toEqual([
      ['Hello there.', 1.1],
      ['How are you? Fine.', 1.1],
    ]);
  });

  it('surfaces a failing token source through sendStream and events()', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context();
    async function* broken() {
      yield 'One sentence here. And';
      throw new Error('LLM failed');
    }
    await expect(ctx.sendStream(broken())).rejects.toThrow('LLM failed');
    await expect(drain(ctx.events())).rejects.toThrow('LLM failed');
  });
});

describe('WebSocket: cancel means silence now', () => {
  function cancellingServer(onRequest: (peer: Peer, msg: Record<string, unknown>) => void) {
    return mock((peer, msg) => {
      if (msg.cancel)
        peer.ws.send(JSON.stringify({ type: 'cancelled', done: true, context_id: msg.context_id }));
      else onRequest(peer, msg);
    });
  }

  for (const running of [true, false]) {
    it(`drops unread audio of finished requests too (${running ? 'one still running' : 'nothing unfinished'})`, async () => {
      const m = await cancellingServer((peer, msg) => {
        if (msg.text === 'r1') {
          for (let i = 0; i < 5; i++)
            peer.ws.send(
              JSON.stringify({
                type: 'chunk',
                data: b64([1, 1]),
                context_id: msg.context_id,
                request_id: 'req_r1',
              }),
            );
          peer.ws.send(
            JSON.stringify({ type: 'done', done: true, context_id: msg.context_id, request_id: 'req_r1' }),
          );
        } else {
          peer.ws.send(
            JSON.stringify({
              type: 'chunk',
              data: b64([2, 2]),
              context_id: msg.context_id,
              request_id: 'req_r2',
            }),
          );
        }
      });
      const ws = socketFor(m);
      const ctx = ws.context();
      const r1 = await ctx.send({ text: 'r1' });
      if (running) await ctx.send({ text: 'r2' });
      await r1.result(); // r1 has finished; its audio waits unread
      await new Promise((r) => setTimeout(r, 30));
      await ctx.cancel();
      ctx.endInput();
      const after = (await drain(ctx.events())).map((e) => e.type);
      expect(after).toEqual(running ? ['done', 'cancelled'] : ['done']);
      expect(m.peers[0]?.received.some((r) => r.cancel)).toBe(running);
    });
  }

  it('stops a sendStream feeding the context: nothing more is sent, and it returns promptly', async () => {
    const m = await cancellingServer((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context();
    // A token source whose third token never comes (a slow model); it records return().
    const tokens = ['पहला वाक्य है। ', 'दूसरा वाक्य है। '];
    let returned = false;
    const llm = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const value = tokens.shift();
            if (value === undefined) return new Promise<IteratorResult<string>>(() => {});
            await new Promise((r) => setTimeout(r, 50));
            return { done: false, value };
          },
          return: async () => {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const sending = ctx.sendStream(llm);
    await waitFor(() => (m.peers[0]?.received.length ?? 0) === 1, 'the first sentence');
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await ctx.cancel();
    await sending;
    expect(Date.now() - started).toBeLessThan(1_000);
    const chunksAfter = (await drain(ctx.events())).filter((e) => e.type === 'chunk');
    expect(chunksAfter).toEqual([]);
    expect(m.peers[0]?.received.filter((r) => r.text).map((r) => r.text)).toEqual(['पहला वाक्य है।']);
    await waitFor(() => returned, 'return() on the token source');
  });

  it('accepts a plain string in sendStream', async () => {
    const m = await mock((peer, msg) => answer(peer, msg));
    const ws = socketFor(m);
    const ctx = ws.context();
    await ctx.sendStream('Hello there. How are you?');
    await drain(ctx.events());
    expect(m.peers[0]?.received.map((r) => r.text)).toEqual(['Hello there.', 'How are you?']);
  });
});

describe('WebSocket: limits, timeouts and closes', () => {
  it('waits instead of starting a 17th context while 16 have unfinished requests', async () => {
    const m = await mock(); // answers only when told
    const ws = socketFor(m);
    const contexts = Array.from({ length: 17 }, () => ws.context());
    for (const ctx of contexts.slice(0, 16)) await ctx.send({ text: 'x' });
    let seventeenth = false;
    const pending = (contexts[16] as (typeof contexts)[number]).send({ text: 'x' }).then(() => {
      seventeenth = true;
    });
    await waitFor(() => (m.peers[0]?.received.length ?? 0) === 16, '16 requests');
    await new Promise((r) => setTimeout(r, 50));
    expect(seventeenth).toBe(false);
    const peer = m.peers[0] as Peer;
    answer(peer, peer.received[0] as Record<string, unknown>);
    await pending;
    await waitFor(() => peer.received.length === 17, 'the 17th request');
  });

  it('never has more than 64 unfinished requests on a connection', async () => {
    const m = await mock();
    const ws = socketFor(m);
    const ctx = ws.context();
    for (let i = 0; i < 64; i++) await ctx.send({ text: `s${i}` });
    let sent65 = false;
    const pending = ctx.send({ text: 's64' }).then(() => {
      sent65 = true;
    });
    await waitFor(() => (m.peers[0]?.received.length ?? 0) === 64, '64 requests');
    await new Promise((r) => setTimeout(r, 50));
    expect(sent65).toBe(false);
    const peer = m.peers[0] as Peer;
    answer(peer, peer.received[0] as Record<string, unknown>);
    await pending;
    await waitFor(() => peer.received.length === 65, 'the 65th request');
  });

  it('times out a context that hears nothing, and cancels it on the server', async () => {
    const m = await mock();
    const ws = socketFor(m, { timeout: 120 });
    const ctx = ws.context({ contextId: 'slow' });
    const req = await ctx.send({ text: 'x' });
    await expect(req.result()).rejects.toBeInstanceOf(APITimeoutError);
    await waitFor(() => (m.peers[0]?.received.length ?? 0) === 2, 'the cancel');
    expect(m.peers[0]?.received[1]).toEqual({ context_id: 'slow', cancel: true });
    // After the acknowledgement the context works again.
    const peer = m.peers[0] as Peer;
    peer.ws.send(JSON.stringify({ type: 'cancelled', done: true, context_id: 'slow' }));
    const next = await ctx.send({ text: 'y' });
    answer(peer, { context_id: 'slow' }, [1, 2, 3, 4], 'req_y');
    expect(await next.result()).toMatchObject({ requestId: 'req_y', audioBytes: 4 });
  });

  it('fails requests without retrying when the server closes with 1009', async () => {
    const m = await mock((peer) => peer.ws.close(1009, 'message too big'));
    const ws = socketFor(m);
    const ctx = ws.context();
    const req = await ctx.send({ text: 'x' });
    const err = await req.result().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebSocketClosedError);
    expect(err).toMatchObject({ closeCode: 1009, retryable: false });
    expect(m.peers.length).toBe(1);
  });

  it('backs off between repeated abnormal closes and gives up after maxRetries', async () => {
    const m = await mock((peer) => peer.ws.terminate());
    const sleeps: number[] = [];
    const ws = socketFor(m, { maxRetries: 2, sleep: recordingSleep(sleeps) });
    const ctx = ws.context();
    const req = await ctx.send({ text: 'x' });
    const err = await req.result().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebSocketClosedError);
    expect((err as WebSocketClosedError).retryable).toBe(true);
    // The first reconnect is immediate and free; the next two back off and count; then it gives up.
    expect(m.peers.length).toBe(4);
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0.375);
    expect(sleeps[1]).toBeGreaterThanOrEqual(0.75);
  });

  it('moves to a new connection on a drain refusal and resends held requests before the 1001', async () => {
    const events: string[] = [];
    const running = new Set<unknown>();
    const queued = new Map<unknown, Array<Record<string, unknown>>>();
    const refuse = (peer: Peer, msg: Record<string, unknown>) =>
      peer.ws.send(
        JSON.stringify({
          type: 'error',
          status_code: 503,
          done: true,
          error_code: 'service_unavailable',
          message: 'The service is restarting. Reconnect and send the request again.',
          context_id: msg.context_id,
          request_id: `req_refused_${String(msg.text)}`,
        }),
      );
    const m = await mock((peer, msg) => {
      const text = String(msg.text);
      if (m.peers.indexOf(peer) > 0) {
        events.push(`new:${text}`);
        answer(peer, msg, [2], `req_${text}`);
        return;
      }
      if (text === 'first') {
        // Accepted before the drain: finishes at 250 ms. The 1001 comes at 500 ms.
        running.add(msg.context_id);
        setTimeout(() => {
          events.push('old:first done');
          answer(peer, msg, [1], 'req_first');
          running.delete(msg.context_id);
          // Like the Router, a refusal queued behind a running request comes after its done.
          for (const later of queued.get(msg.context_id) ?? []) refuse(peer, later);
        }, 250);
        setTimeout(() => {
          events.push('old:1001');
          peer.ws.close(1001, 'going away');
        }, 500);
      } else if (running.has(msg.context_id)) {
        queued.set(msg.context_id, [...(queued.get(msg.context_id) ?? []), msg]);
      } else {
        refuse(peer, msg);
      }
    });
    const sleeps: number[] = [];
    const ws = socketFor(m, { maxRetries: 0, sleep: recordingSleep(sleeps) });
    const busy = ws.context();
    const idle = ws.context();
    const first = await busy.send({ text: 'first' });
    const second = await busy.send({ text: 'second' });
    const refused = await idle.send({ text: 'refused' });
    // The refusal opens a new connection at once, and a new context goes there straight away,
    // while the old connection still runs "first".
    await waitFor(() => m.peers.length === 2, 'a new connection');
    const other = await ws.context().send({ text: 'other' });
    expect(await refused.result()).toMatchObject({ requestId: 'req_refused' });
    expect(await other.result()).toMatchObject({ requestId: 'req_other' });
    expect(await first.result()).toMatchObject({ requestId: 'req_first' });
    expect(await second.result()).toMatchObject({ requestId: 'req_second' });
    await waitFor(() => events.includes('old:1001'), 'the 1001');
    // "second" was resent as soon as its context had nothing left on the draining
    // connection, not when that connection closed.
    expect(events).toEqual(['new:refused', 'new:other', 'old:first done', 'new:second', 'old:1001']);
    expect(m.peers.length).toBe(2);
    expect(sleeps).toEqual([]); // none of this counts as a retry
  });

  it('treats 503 service_unavailable without the reconnect phrase as an ordinary retryable error', async () => {
    // A billing outage: refused every time, the connection stays open. No reconnect storm.
    const m = await mock((peer, msg) =>
      peer.ws.send(
        JSON.stringify({
          type: 'error',
          status_code: 503,
          done: true,
          error_code: 'service_unavailable',
          message: 'Balances cannot be checked right now. Retry shortly.',
          retryable: true,
          context_id: msg.context_id,
        }),
      ),
    );
    const sleeps: number[] = [];
    const ws = socketFor(m, { maxRetries: 2, sleep: recordingSleep(sleeps) });
    const req = await ws.context().send({ text: 'x' });
    await expect(req.result()).rejects.toBeInstanceOf(InternalServerError);
    expect(m.peers.length).toBe(1);
    expect(m.peers[0]?.received.length).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  it('bounds a storm of draining refusals: the first is free, later ones back off and count', async () => {
    const m = await mock((peer, msg) => peer.ws.send(JSON.stringify(drainRefusal(msg))));
    const sleeps: number[] = [];
    const ws = socketFor(m, { maxRetries: 2, sleep: recordingSleep(sleeps) });
    const req = await ws.context().send({ text: 'x' });
    const err = await req.result().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerError);
    expect((err as InternalServerError).status).toBe(503);
    // 1 original + 1 free move + 2 counted retries, each on a new connection.
    expect(m.peers.length).toBe(4);
    expect(sleeps.length).toBe(2);
    // The client closes each drained connection itself once nothing is bound to it.
    await waitFor(
      () => m.peers.filter((p) => p.ws.readyState === 1).length <= 1,
      'drained connections to close',
    );
  });

  for (const how of ['1001', 'drop'] as const) {
    it(`resends a request left on a draining connection when it closes (${how})`, async () => {
      const m = await mock((peer, msg) => {
        if (m.peers.indexOf(peer) === 0) {
          if (msg.text === 'b1') peer.ws.send(JSON.stringify(drainRefusal(msg)));
          return; // a1: accepted, never answered on the draining connection
        }
        answer(peer, msg, [1, 2, 3, 4], `req_${String(msg.text)}`);
        if (msg.text === 'b1') {
          setTimeout(() => {
            const old = (m.peers[0] as Peer).ws;
            if (how === '1001') old.close(1001, 'going away');
            else old.terminate();
          }, 30);
        }
      });
      const sleeps: number[] = [];
      const ws = socketFor(m, { sleep: recordingSleep(sleeps) });
      const a1 = await ws.context({ contextId: 'A' }).send({ text: 'a1' });
      await waitFor(() => (m.peers[0]?.received.length ?? 0) === 1, 'a1 on the first connection');
      const b1 = await ws.context({ contextId: 'B' }).send({ text: 'b1' });
      expect(await b1.result()).toMatchObject({ requestId: 'req_b1' });
      expect(await a1.result()).toMatchObject({ requestId: 'req_a1', audioBytes: 4 });
      expect(m.peers.length).toBe(2);
      expect(m.peers[1]?.received.map((r) => r.text)).toEqual(['b1', 'a1']);
      expect(sleeps).toEqual([]);
    });
  }

  it('closes a draining connection with 1000 once no context is bound to it', async () => {
    const closes: number[] = [];
    const m = await mock((peer, msg) => {
      if (m.peers.indexOf(peer) === 0) {
        peer.ws.on('close', (code) => closes.push(code));
        peer.ws.send(JSON.stringify(drainRefusal(msg))); // and never closes on its own
      } else answer(peer, msg);
    });
    const ws = socketFor(m);
    const req = await ws.context().send({ text: 'x' });
    await req.result();
    await waitFor(() => closes.length === 1, 'the client to close the drained connection');
    expect(closes).toEqual([1000]);
  });

  it('treats a 1000 close with requests unfinished as a 1001: resend at once, no backoff', async () => {
    const m = await mock((peer, msg) => {
      if (m.peers.indexOf(peer) === 0) peer.ws.close(1000, 'bye');
      else answer(peer, msg, [5, 5], 'req_again');
    });
    const sleeps: number[] = [];
    const ws = socketFor(m, { sleep: recordingSleep(sleeps) });
    const req = await ws.context().send({ text: 'x' });
    expect(await req.result()).toMatchObject({ requestId: 'req_again' });
    expect(sleeps).toEqual([]);
  });

  it('does not cut a steadily streaming request on a draining connection', async () => {
    const m = await mock((peer, msg) => {
      if (msg.text === 'b') {
        if (m.peers.indexOf(peer) === 0) peer.ws.send(JSON.stringify(drainRefusal(msg)));
        else answer(peer, msg);
        return;
      }
      let i = 0;
      const timer = setInterval(() => {
        if (peer.ws.readyState !== 1) return clearInterval(timer);
        if (i++ < 20)
          peer.ws.send(JSON.stringify({ type: 'chunk', data: b64([1, 2]), context_id: msg.context_id }));
        else {
          clearInterval(timer);
          peer.ws.send(JSON.stringify({ type: 'done', done: true, context_id: msg.context_id }));
        }
      }, 30); // 600 ms of audio, never 300 ms of silence
    });
    const ws = socketFor(m, { timeout: 300 });
    const long = await ws
      .context()
      .send({ text: 'long', output_format: { container: 'raw', encoding: 'pcm_s16le' } });
    await new Promise((r) => setTimeout(r, 60));
    await ws.context().send({ text: 'b' });
    expect(await long.result()).toMatchObject({ audioBytes: 40 });
  });

  it('routes messages about no request to onNotice and keeps going', async () => {
    const m = await mock((peer, msg) => {
      peer.ws.send(JSON.stringify({ type: 'error', status_code: 400, done: true, message: 'binary frame' }));
      answer(peer, msg);
    });
    const ws = socketFor(m);
    const notices: unknown[] = [];
    ws.onNotice = (e) => notices.push(e);
    const ctx = ws.context();
    const req = await ctx.send({ text: 'x' });
    expect(await req.result()).toMatchObject({ audioBytes: 4 });
    expect(notices).toHaveLength(1);
    expect((notices[0] as Error).message).toBe('binary frame');
  });

  it('delivers a refusal it must not resend when later requests of the context were sent', async () => {
    let n = 0;
    const m = await mock((peer, msg) => {
      if (n++ === 0) {
        peer.ws.send(
          JSON.stringify({
            type: 'error',
            status_code: 503,
            done: true,
            message: 'busy',
            context_id: msg.context_id,
          }),
        );
      } else answer(peer, msg);
    });
    const ws = socketFor(m);
    const ctx = ws.context();
    const a = await ctx.send({ text: 'a' });
    const b = await ctx.send({ text: 'b' });
    await expect(a.result()).rejects.toBeInstanceOf(InternalServerError);
    await expect(b.result()).resolves.toMatchObject({ audioBytes: 4 });
  });
});
