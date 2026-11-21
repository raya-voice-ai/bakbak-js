/**
 * Runs every conformance/ws/*.json scenario against a `ws` WebSocketServer, following
 * conformance/README.md exactly. The whole suite runs once with the `ws` transport and, on
 * Node 22+, again with Node's global WebSocket (undici).
 */
import http, { STATUS_CODES } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  Bakbak,
  type ContextEvent,
  type ContextSendParams,
  type WebSocketContext,
  type WebSocketRequest,
} from '../../src/index';
import {
  concat,
  type ExpectedError,
  expectError,
  expectSleeps,
  loadScenarios,
  recordingSleep,
  sha256,
  subsetMismatch,
  waitFor,
} from '../helpers';

type Step =
  | { recv: Record<string, unknown> }
  | { send: Record<string, unknown> }
  | { close: { code: number; reason: string } }
  | { expect_no_more: true };

type Connection =
  | { expect_headers?: Record<string, string>; script: Step[] }
  | { reject: { status: number; headers: Record<string, string>; json: unknown } };

type Op =
  | { op: 'connect' }
  | { op: 'send'; context: string; request: Record<string, unknown> }
  | { op: 'wait_audio'; context: string }
  | { op: 'wait_done'; context: string }
  | { op: 'cancel'; context: string }
  | { op: 'wait_closed' };

type Outcome =
  | { outcome: 'done'; audio_bytes?: number; audio_sha256?: string; request_id?: string }
  | { outcome: 'cancelled'; audio_bytes?: number }
  | { outcome: 'error'; audio_bytes?: number; error: ExpectedError };

interface WsScenario {
  id: string;
  description: string;
  connections: Connection[];
  client: Op[];
  expect: {
    contexts?: Record<string, Outcome[]>;
    connect_error?: ExpectedError;
    connections: number;
    connection_notices?: number;
    sleeps: Array<[number, number]>;
  };
}

class Inbox {
  messages: string[] = [];
  waiters: Array<() => void> = [];
  push(data: string): void {
    this.messages.push(data);
    for (const w of this.waiters.splice(0)) w();
  }
  async next(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages.shift();
  }
}

interface MockWsServer {
  baseURL: string;
  connections: number;
  problems: string[];
  scripts: Promise<void>[];
  close(): Promise<void>;
}

async function runScript(ws: WsSocket, n: number, steps: Step[], problems: string[]): Promise<void> {
  const inbox = new Inbox();
  ws.on('message', (data, isBinary) => {
    if (isBinary) problems.push(`connection ${n}: unexpected binary message`);
    else inbox.push(data.toString());
  });
  for (const [i, step] of steps.entries()) {
    const where = `connection ${n} step ${i}`;
    if ('recv' in step) {
      const raw = await inbox.next(5_000);
      if (raw === undefined) {
        problems.push(`${where}: no message within 5 s (expected ${JSON.stringify(step.recv)})`);
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        problems.push(`${where}: not JSON: ${raw}`);
        return;
      }
      const mismatch = subsetMismatch(step.recv, msg);
      if (mismatch) {
        problems.push(`${where}: ${mismatch}`);
        return;
      }
    } else if ('send' in step) {
      ws.send(JSON.stringify(step.send));
    } else if ('close' in step) {
      ws.close(step.close.code, step.close.reason);
    } else {
      const extra = await inbox.next(300);
      if (extra !== undefined) problems.push(`${where}: unexpected message ${extra}`);
      // Then keep the connection open until the client is done.
    }
  }
}

async function startServer(connections: Connection[]): Promise<MockWsServer> {
  const state = { connections: 0, problems: [] as string[], scripts: [] as Promise<void>[] };
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    state.problems.push('unexpected plain HTTP request');
    res.writeHead(500).end();
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket: Socket, head) => {
    const n = state.connections++;
    const spec = connections[n];
    if (!spec) {
      state.problems.push(`unexpected connection ${n}`);
      socket.destroy();
      return;
    }
    if (req.url?.split('?')[0] !== '/v1/text-to-speech/ws')
      state.problems.push(`connection ${n}: path ${req.url}`);
    if ('reject' in spec) {
      const body = JSON.stringify(spec.reject.json);
      const headers = {
        ...spec.reject.headers,
        'content-length': String(Buffer.byteLength(body)),
        connection: 'close',
      };
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
      socket.end(
        `HTTP/1.1 ${spec.reject.status} ${STATUS_CODES[spec.reject.status]}\r\n${lines.join('\r\n')}\r\n\r\n${body}`,
      );
      return;
    }
    for (const [name, value] of Object.entries(spec.expect_headers ?? {})) {
      const got = req.headers[name.toLowerCase()];
      if (got !== value) state.problems.push(`connection ${n}: header ${name}: ${String(got)} != ${value}`);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.scripts.push(runScript(ws, n, spec.script, state.problems));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    get connections() {
      return state.connections;
    },
    problems: state.problems,
    scripts: state.scripts,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface RequestRecord {
  parts: Uint8Array[];
  terminal?: ContextEvent;
}

interface ContextState {
  ctx: WebSocketContext;
  sent: WebSocketRequest[];
  records: Map<WebSocketRequest, RequestRecord>;
  chunks: number;
  collector: Promise<void>;
}

function recordOf(state: ContextState, request: WebSocketRequest): RequestRecord {
  let record = state.records.get(request);
  if (!record) {
    record = { parts: [] };
    state.records.set(request, record);
  }
  return record;
}

const scenarios = loadScenarios<WsScenario>('ws');
const nodeMajor = Number(process.versions.node.split('.')[0]);
const transports: Array<'ws' | 'global'> = nodeMajor >= 22 ? ['ws', 'global'] : ['ws'];

/** Scenarios a transport cannot express, and why. */
const SKIPS: Record<string, Record<string, string>> = {
  global: {
    ws_handshake_401:
      "The WHATWG WebSocket API does not expose a refused upgrade's status or body, so connect() can only " +
      'raise APIConnectionError; undici also retries the refused handshake. Covered by the ws transport.',
  },
};

let current: MockWsServer | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

for (const transport of transports) {
  describe(`conformance: WebSocket (${transport} transport)`, () => {
    it('has scenarios', () => {
      expect(scenarios.length).toBeGreaterThan(0);
    });

    for (const scenario of scenarios) {
      const skip = SKIPS[transport]?.[scenario.id];
      const name = `${scenario.id}: ${scenario.description}`;
      if (skip) {
        it.skip(`${name} [skipped: ${skip}]`, () => {});
        continue;
      }
      it(name, async () => {
        const server = await startServer(scenario.connections);
        current = server;
        const sleeps: number[] = [];
        const client = new Bakbak({
          apiKey: 'test-key',
          baseURL: server.baseURL,
          maxRetries: 2,
          sleep: recordingSleep(sleeps),
          webSocket: transport,
        });
        const ws = client.tts.websocket();
        let notices = 0;
        ws.onNotice = () => {
          notices++;
        };
        const contexts = new Map<string, ContextState>();
        const contextOf = (id: string): ContextState => {
          let state = contexts.get(id);
          if (!state) {
            const ctx = ws.context({ contextId: id });
            const s: ContextState = {
              ctx,
              sent: [],
              records: new Map(),
              chunks: 0,
              collector: Promise.resolve(),
            };
            s.collector = (async () => {
              for await (const event of ctx.events()) {
                const record = recordOf(s, event.request);
                if (event.type === 'chunk') {
                  record.parts.push(event.audio);
                  s.chunks++;
                } else {
                  record.terminal = event;
                }
              }
            })();
            contexts.set(id, s);
            state = s;
          }
          return state;
        };

        let connectError: unknown;
        try {
          for (const op of scenario.client) {
            switch (op.op) {
              case 'connect':
                try {
                  await ws.connect();
                } catch (err) {
                  connectError = err;
                }
                break;
              case 'send': {
                const state = contextOf(op.context);
                state.sent.push(await state.ctx.send(op.request as unknown as ContextSendParams));
                break;
              }
              case 'wait_audio': {
                const state = contextOf(op.context);
                await waitFor(() => state.chunks > 0, `audio on ${op.context}`);
                break;
              }
              case 'wait_done': {
                const state = contextOf(op.context);
                await waitFor(
                  () => state.sent.every((r) => recordOf(state, r).terminal !== undefined),
                  `requests on ${op.context} to finish`,
                );
                break;
              }
              case 'cancel':
                await contextOf(op.context).ctx.cancel();
                break;
              case 'wait_closed':
                await waitFor(() => !ws.connected, 'the server to close the connection');
                break;
            }
          }
          for (const state of contexts.values()) state.ctx.endInput();
          await Promise.all([...contexts.values()].map((s) => s.collector));
          await Promise.all(server.scripts);
        } finally {
          await ws.close();
        }

        expect(server.problems).toEqual([]);
        if (scenario.expect.connect_error) expectError(connectError, scenario.expect.connect_error);
        else if (connectError) throw connectError;
        for (const [id, outcomes] of Object.entries(scenario.expect.contexts ?? {})) {
          const state = contexts.get(id);
          expect(state, `context ${id}`).toBeDefined();
          if (!state) continue;
          expect(state.sent.length, `requests on ${id}`).toBe(outcomes.length);
          outcomes.forEach((exp, i) => {
            const request = state.sent[i] as WebSocketRequest;
            const record = recordOf(state, request);
            const audio = concat(record.parts);
            const where = `${id}[${i}]`;
            const terminal = record.terminal;
            expect(terminal?.type, `${where} outcome`).toBe(
              exp.outcome === 'error' ? 'failed' : exp.outcome === 'done' ? 'done' : 'cancelled',
            );
            if (exp.audio_bytes !== undefined)
              expect(audio.length, `${where} audio_bytes`).toBe(exp.audio_bytes);
            if (exp.outcome === 'done') {
              if (exp.audio_sha256) expect(sha256(audio), `${where} audio_sha256`).toBe(exp.audio_sha256);
              if (exp.request_id) expect(request.requestId, `${where} request_id`).toBe(exp.request_id);
            }
            if (exp.outcome === 'error' && terminal?.type === 'failed')
              expectError(terminal.error, exp.error);
          });
        }
        expect(server.connections, 'connections').toBe(scenario.expect.connections);
        expect(notices, 'connection_notices').toBe(scenario.expect.connection_notices ?? 0);
        expectSleeps(sleeps, scenario.expect.sleeps);
      });
    }
  });
}
