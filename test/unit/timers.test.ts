import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { startTimer } from '../../src/core/util';
import { Bakbak, WebSocketClosedError } from '../../src/index';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function wsServer(onMessage: (ws: import('ws').WebSocket, msg: Record<string, unknown>) => void) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const sockets: import('ws').WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (d) => onMessage(ws, JSON.parse(String(d))));
  });
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  cleanups.push(async () => {
    for (const c of wss.clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { url: `http://localhost:${(server.address() as AddressInfo).port}`, sockets };
}

function captureWarnings(): string[] {
  const warnings: string[] = [];
  const on = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
  process.on('warning', on);
  cleanups.push(() => {
    process.off('warning', on);
  });
  return warnings;
}

describe('timers', () => {
  it('startTimer: no timer for Infinity or NaN, a clamped one beyond 2^31-1, unref by default', async () => {
    expect(startTimer(() => {}, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(startTimer(() => {}, Number.NaN)).toBeUndefined();
    const warnings = captureWarnings();
    let fired = false;
    const t = startTimer(() => {
      fired = true;
    }, 2 ** 40);
    await new Promise((r) => setTimeout(r, 20));
    clearTimeout(t);
    expect(fired).toBe(false);
    expect(warnings).toEqual([]);
    const ref = startTimer(() => {}, 1000);
    expect((ref as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
    clearTimeout(ref);
  });

  it('accepts timeout and connectTimeout of Infinity on HTTP and WebSocket', async () => {
    const warnings = captureWarnings();
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => res.end('data: {"type":"chunk","data":"AAAAAA=="}\n\ndata: {"type":"done"}\n\n'), 30);
    });
    await new Promise<void>((r) => httpServer.listen(0, 'localhost', r));
    cleanups.push(() => new Promise<void>((r) => httpServer.close(() => r())));
    const client = new Bakbak({
      apiKey: 'k',
      baseURL: `http://localhost:${(httpServer.address() as AddressInfo).port}`,
      timeout: Number.POSITIVE_INFINITY,
      connectTimeout: Number.POSITIVE_INFINITY,
    });
    expect((await client.tts.stream({ text: 'x', voice_id: 'v', language: 'hi' }).bytes()).length).toBe(4);

    const m = await wsServer((ws, msg) => {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'chunk', data: 'AAAAAA==', context_id: msg.context_id }));
        ws.send(JSON.stringify({ type: 'done', done: true, context_id: msg.context_id }));
      }, 30);
    });
    const ws = new Bakbak({
      apiKey: 'k',
      baseURL: m.url,
      timeout: Number.POSITIVE_INFINITY,
      connectTimeout: Number.POSITIVE_INFINITY,
    }).tts.websocket({ voice_id: 'v', language: 'hi' });
    cleanups.push(() => ws.close());
    const req = await ws.context().send({ text: 'x' });
    expect(await req.result()).toMatchObject({ audioBytes: 4 });
    expect(warnings).toEqual([]);
  });

  it('never hangs when the injected sleep rejects', async () => {
    const m = await wsServer((ws) => ws.terminate()); // every connection drops
    const ws = new Bakbak({
      apiKey: 'k',
      baseURL: m.url,
      maxRetries: 2,
      sleep: async () => {
        throw new Error('sleep aborted');
      },
    }).tts.websocket({ voice_id: 'v', language: 'hi' });
    cleanups.push(() => ws.close());
    const req = await ws.context().send({ text: 'x' });
    await expect(req.result()).rejects.toBeInstanceOf(WebSocketClosedError);
  });

  it('close() returns within about a second when the peer stops answering', async () => {
    const m = await wsServer(() => {});
    const ws = new Bakbak({ apiKey: 'k', baseURL: m.url }).tts.websocket({ voice_id: 'v', language: 'hi' });
    await ws.connect();
    await new Promise((r) => setTimeout(r, 20));
    // Freeze the server side: it no longer reads, so it never answers the close frame.
    (m.sockets[0] as unknown as { _socket: { pause(): void } })._socket.pause();
    const started = Date.now();
    await ws.close();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('an unread stream does not keep the process alive', () => {
    const script = fileURLToPath(new URL('../fixtures/unconsumed-stream.ts', import.meta.url));
    const started = Date.now();
    const child = spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
    // The read timeout is 30 s; the process must exit long before it.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
