import { SampleAligner, sampleBytes } from '../core/base64';
import type { Config } from '../core/config';
import {
  APIConnectionError,
  type APIError,
  APITimeoutError,
  BakbakError,
  isObject,
  makeInterruptedFromEvent,
  makeStatusError,
  StreamInterruptedError,
  WebSocketClosedError,
} from '../core/errors';
import { backoffMs, type Deferred, deferred, noop, now, quiet, retryDelayMs, Signal } from '../core/util';
import { Segmenter, type SegmenterOptions } from '../text/segmenter';
import { textOf } from '../text/tokens';
import type { TTSDefaults } from '../types';
import { openSocket, type Socket } from './transport';

/** Requests accepted and not finished, per connection (the server's limit). */
export const MAX_UNFINISHED = 64;
/** Contexts generating at once, per connection (the server's limit). */
export const MAX_ACTIVE_CONTEXTS = 16;

const CONTEXT_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** A request's final outcome, from `request.result()`. */
export interface WebSocketRequestResult {
  /** The request id to quote to support. */
  requestId: string | undefined;
  /** Bytes of audio delivered. */
  audioBytes: number;
  /** True if `cancel()` stopped the request. */
  cancelled: boolean;
}

/** What happened on a context, in order, from `ctx.events()`. */
export type ContextEvent =
  | { type: 'chunk'; audio: Uint8Array; stepTime: number | undefined; request: WebSocketRequest }
  | { type: 'done'; request: WebSocketRequest }
  | { type: 'failed'; error: BakbakError; request: WebSocketRequest }
  | { type: 'cancelled'; request: WebSocketRequest };

type Outcome = { type: 'done' } | { type: 'failed'; error: BakbakError } | { type: 'cancelled' };

interface Rec {
  event: ContextEvent;
  req: Req;
  taken: boolean;
}

class Conn {
  socket!: Socket;
  unfinished = 0;
  readonly active = new Set<Ctx>();
  draining = false;
  closed = false;
  closeAs: number | undefined;
  readonly gone = deferred<void>();
  constructor(readonly id: number) {}
}

class Req {
  readonly facade: WebSocketRequest;
  readonly aligner: SampleAligner;
  requestId: string | undefined;
  audioBytes = 0;
  hadAudio = false;
  inflight = false;
  settled = false;
  error: BakbakError | undefined;
  conn: Conn | undefined;
  retries = 0;
  /** Draining refusals of this request; only the first one is free (BEHAVIOR.md §6.4). */
  drainRefusals = 0;
  backoff = false;
  readonly sent = deferred<void>();
  readonly result: Deferred<WebSocketRequestResult>;
  recs: Rec[] = [];
  rHead = 0;
  readonly signal = new Signal();

  constructor(
    readonly ctx: Ctx,
    readonly json: string,
    sampleSize: number,
  ) {
    this.aligner = new SampleAligner(sampleSize);
    this.result = deferred<WebSocketRequestResult>();
    quiet(this.result.promise);
    this.facade = new WebSocketRequest(this);
  }
}

interface CancelState {
  conn: Conn;
  /** Requests on the wire when the cancel was sent; they end at the acknowledgement. */
  requests: Req[];
  /** Requests never sent; they end with the others. */
  local: Req[];
  done: Deferred<void>;
}

class Ctx {
  readonly facade: WebSocketContext;
  /** Not yet on the wire, in order; requests held after a drain refusal come first. */
  pending: Req[] = [];
  /** How many requests at the front of `pending` a draining connection refused, and which one. */
  heldCount = 0;
  heldFrom: Conn | undefined;
  /** On the wire on `conn`, in order. */
  inflight: Req[] = [];
  conn: Conn | undefined;
  cancel: CancelState | undefined;
  queue: Rec[] = [];
  qHead = 0;
  readonly signal = new Signal();
  inputEnded = false;
  unfinished = 0;
  lastActivity = 0;
  inputError: { error: unknown } | undefined;

  constructor(
    readonly session: Session,
    readonly id: string,
    readonly defaults: TTSDefaults,
  ) {
    this.facade = new WebSocketContext(this);
  }
}

function merge(...layers: Array<object | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) if (value !== undefined) out[key] = value;
  }
  return out;
}

function randomContextId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `ctx_${hex}`;
}

/**
 * A draining refusal (BEHAVIOR.md §6.4): status 503 and a message containing the reconnect
 * phrase. `error_code` alone never marks one: `service_unavailable` also means the service
 * cannot check balances, and treating that as a drain would reconnect in a tight loop.
 */
function isDrainSignal(msg: Record<string, unknown>): boolean {
  return (
    msg.status_code === 503 &&
    typeof msg.message === 'string' &&
    msg.message.includes('Reconnect and send the request again')
  );
}

const CLOSE_NAMES: Record<number, string> = { 1008: 'policy violation', 1009: 'message too big' };

/** The engine behind a {@link TTSWebSocket}: connections, routing, retries and reconnects. */
class Session {
  readonly contexts = new Map<string, Ctx>();
  /** Contexts with requests not yet on the wire, in the order they got them. */
  readonly withPending = new Set<Ctx>();
  readonly conns = new Set<Conn>();
  current: Conn | undefined;
  connecting: Promise<Conn> | undefined;
  reconnectWait = false;
  abnormalCloses = 0;
  connectionCount = 0;
  closed = false;
  sweepTimer: ReturnType<typeof setInterval> | undefined;
  readonly url: string;

  constructor(
    readonly cfg: Config,
    readonly defaults: TTSDefaults,
    readonly facade: TTSWebSocket,
  ) {
    this.url = `${cfg.baseURL.replace(/^http/i, 'ws')}/v1/text-to-speech/ws`;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.cfg.logger?.debug?.(`websocket: ${message}`, fields);
  }

  // ---------------------------------------------------------------- connections

  ensureConnection(): Promise<Conn> {
    const cur = this.current;
    if (cur && !cur.closed) return Promise.resolve(cur);
    if (!this.connecting) {
      const attempt = this.openWithRetries();
      this.connecting = attempt;
      attempt.then(
        () => {
          this.connecting = undefined;
          this.pump();
        },
        (err: unknown) => {
          this.connecting = undefined;
          this.failPending(
            err instanceof BakbakError ? err : new APIConnectionError(String(err), { cause: err }),
          );
        },
      );
    }
    return this.connecting;
  }

  async openWithRetries(): Promise<Conn> {
    const cfg = this.cfg;
    for (let retry = 0; ; retry++) {
      if (this.closed) throw this.closedError();
      const conn = new Conn(++this.connectionCount);
      try {
        conn.socket = await openSocket(
          {
            url: this.url,
            apiKey: cfg.apiKey,
            headers: cfg.headers,
            impl: cfg.webSocket,
            runtime: cfg.runtime,
            connectTimeout: cfg.connectTimeout,
            logger: cfg.logger,
          },
          {
            onMessage: (data) => this.onMessage(conn, data),
            onBinary: () => this.debug('ignored a binary message', { connection: conn.id }),
            onClose: (code, reason) => this.onClose(conn, code, reason),
          },
        );
      } catch (thrown) {
        const err =
          thrown instanceof BakbakError ? thrown : new APIConnectionError(String(thrown), { cause: thrown });
        if (this.closed || !err.retryable || retry >= cfg.maxRetries) throw err;
        const delay = retryDelayMs(err, retry + 1);
        this.debug('connect failed; retrying', {
          retry: retry + 1,
          delayMs: Math.round(delay),
          error: err.name,
        });
        await cfg.sleep(delay);
        continue;
      }
      if (this.closed) {
        conn.socket.close(1000, 'client closed');
        throw this.closedError();
      }
      this.conns.add(conn);
      this.current = conn;
      this.debug('connected', { connection: conn.id });
      return conn;
    }
  }

  closedError(): WebSocketClosedError {
    return new WebSocketClosedError('The WebSocket was closed by the client.', { retryable: false });
  }

  /** Closes a connection ourselves and handles it as if the server had closed it with `as`. */
  forceClose(conn: Conn, as: number): void {
    if (conn.closed) return;
    conn.closeAs = as;
    conn.socket.terminate();
    // Some implementations report the close asynchronously or not at all for a dead peer.
    setTimeout(() => this.onClose(conn, as, 'closed by the client'), 1_000);
  }

  // ---------------------------------------------------------------- sending

  hasSendable(): boolean {
    for (const ctx of this.withPending) if (ctx.pending[0] && !ctx.pending[0].backoff) return true;
    return false;
  }

  /** Sends whatever can be sent now, opening a connection if one is needed. */
  pump(): void {
    if (this.closed) return;
    const conn = this.current;
    if (!conn || conn.closed) {
      if (!this.connecting && !this.reconnectWait && this.hasSendable()) quiet(this.ensureConnection());
      return;
    }
    if (conn.draining) return; // A send failed: the socket is closing, and its close resends.
    for (const ctx of this.withPending) {
      while (ctx.pending.length) {
        const req = ctx.pending[0] as Req;
        if (req.backoff) break;
        if (ctx.conn && ctx.conn !== conn) break;
        if (conn.unfinished >= MAX_UNFINISHED) return;
        if (!ctx.conn && conn.active.size >= MAX_ACTIVE_CONTEXTS) break;
        try {
          conn.socket.send(req.json);
        } catch (err) {
          // The socket is closing; its close event will reconnect and resend.
          this.debug('send failed', { connection: conn.id, error: String(err) });
          conn.draining = true;
          return;
        }
        ctx.pending.shift();
        if (ctx.heldCount) ctx.heldCount--;
        req.inflight = true;
        req.conn = conn;
        ctx.inflight.push(req);
        if (!ctx.conn) {
          ctx.conn = conn;
          conn.active.add(ctx);
          ctx.lastActivity = now();
        }
        conn.unfinished++;
        req.sent.resolve();
        this.ensureSweep();
      }
      if (!ctx.pending.length) this.withPending.delete(ctx);
    }
  }

  send(ctx: Ctx, params: object, extraBody: Record<string, unknown> | undefined): Promise<WebSocketRequest> {
    if (this.closed) return Promise.reject(new BakbakError('This WebSocket is closed; create a new one.'));
    if (ctx.inputEnded) {
      return Promise.reject(
        new BakbakError(`endInput() was called on context ${ctx.id}; use a new context.`),
      );
    }
    const body = merge(this.defaults, ctx.defaults, params, extraBody, { context_id: ctx.id });
    const format = body.output_format as { encoding?: string } | undefined;
    const req = new Req(ctx, JSON.stringify(body), sampleBytes(format ? format.encoding : 'pcm_f32le'));
    ctx.pending.push(req);
    ctx.unfinished++;
    this.withPending.add(ctx);
    this.pump();
    return req.sent.promise.then(() => req.facade);
  }

  // ---------------------------------------------------------------- receiving

  onMessage(conn: Conn, data: string): void {
    this.abnormalCloses = 0;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      this.debug('ignored a message that is not JSON', { connection: conn.id, size: data.length });
      return;
    }
    if (!isObject(msg)) return;
    const contextId = typeof msg.context_id === 'string' ? msg.context_id : undefined;
    const ctx = contextId === undefined ? undefined : this.contexts.get(contextId);
    if (!ctx || ctx.conn !== conn) {
      if (msg.type === 'error' && contextId === undefined && msg.request_id === undefined) this.notice(msg);
      else this.debug('ignored a message for no unfinished request', { connection: conn.id, type: msg.type });
      return;
    }
    ctx.lastActivity = now();
    if (ctx.cancel) {
      // Everything before the acknowledgement belongs to cancelled requests.
      if (msg.type === 'cancelled') this.finishCancel(ctx);
      return;
    }
    const req = ctx.inflight[0];
    if (!req) return;
    // Each attempt has its own id; the latest one is the request's.
    if (typeof msg.request_id === 'string') req.requestId = msg.request_id;
    switch (msg.type) {
      case 'chunk': {
        if (typeof msg.data !== 'string') return;
        req.hadAudio = true;
        const audio = req.aligner.push(msg.data);
        if (audio) this.deliver(req, audio, typeof msg.step_time === 'number' ? msg.step_time : undefined);
        return;
      }
      case 'done': {
        const tail = req.aligner.flush();
        if (tail) this.deliver(req, tail, undefined);
        this.release(req);
        this.settle(req, { type: 'done' });
        this.pump();
        return;
      }
      case 'error':
        this.onRequestError(conn, ctx, req, msg);
        return;
      default:
        // `cancelled` without a cancel, and unknown types, are ignored (forward compatibility).
        return;
    }
  }

  onRequestError(conn: Conn, ctx: Ctx, req: Req, msg: Record<string, unknown>): void {
    const status = typeof msg.status_code === 'number' ? msg.status_code : 500;
    if (req.hadAudio) {
      this.release(req);
      this.settle(req, { type: 'failed', error: makeInterruptedFromEvent(msg, undefined, req.audioBytes) });
      this.pump();
      return;
    }
    const error = makeStatusError(status, msg);
    if (isDrainSignal(msg)) {
      if (req.drainRefusals++ === 0) {
        this.hold(conn, ctx, req, 0);
        return;
      }
      // Refused again: an ordinary retryable error, resent on a new connection after a backoff.
      if (req.retries < this.cfg.maxRetries) {
        req.retries++;
        this.hold(conn, ctx, req, backoffMs(req.retries));
        return;
      }
      this.markDraining(conn);
      this.release(req);
      this.settle(req, { type: 'failed', error });
      this.pump();
      return;
    }
    // Resend only if nothing later on this context was sent: a resend would break the order.
    if (error.retryable && ctx.inflight.length === 1 && req.retries < this.cfg.maxRetries) {
      this.detach(req);
      req.retries++;
      req.backoff = true;
      ctx.pending.unshift(req);
      this.withPending.add(ctx);
      const delay = backoffMs(req.retries);
      this.debug('request refused; resending', {
        requestId: error.requestId,
        status,
        delayMs: Math.round(delay),
      });
      this.cfg.sleep(delay).then(() => {
        req.backoff = false;
        this.pump();
      }, noop);
      this.pump();
      return;
    }
    this.release(req);
    this.settle(req, { type: 'failed', error });
    this.pump();
  }

  /** Stops sending on a draining connection; new work goes to a new one (BEHAVIOR.md §6.4). */
  markDraining(conn: Conn): void {
    if (conn.draining || conn.closed) return;
    conn.draining = true;
    this.debug('connection is draining; moving to a new one', { connection: conn.id });
    if (this.current === conn) this.current = undefined;
    quiet(this.ensureConnection());
  }

  /**
   * A draining refusal: the request is held, with any later ones of its context, and resent
   * in order on a new connection as soon as its context has nothing unfinished on the
   * draining one, after `delayMs` (0 for a first refusal, which is not counted as a retry).
   */
  hold(conn: Conn, ctx: Ctx, req: Req, delayMs: number): void {
    this.markDraining(conn);
    this.detach(req);
    ctx.pending.splice(ctx.heldCount, 0, req);
    ctx.heldCount++;
    ctx.heldFrom = conn;
    this.withPending.add(ctx);
    if (delayMs > 0) {
      req.backoff = true;
      this.debug('refused again by a draining connection; resending after a backoff', {
        delayMs: Math.round(delayMs),
      });
      this.cfg.sleep(delayMs).then(() => {
        req.backoff = false;
        this.pump();
      }, noop);
    }
    this.pump();
  }

  notice(msg: Record<string, unknown>): void {
    const error: APIError = makeStatusError(typeof msg.status_code === 'number' ? msg.status_code : 400, msg);
    const callback = this.facade.onNotice;
    if (callback) {
      try {
        callback(error);
      } catch (err) {
        this.cfg.logger?.error?.('websocket: onNotice threw', { error: String(err) });
      }
    } else {
      this.cfg.logger?.warn?.(`websocket: ${error.message}`, { status: error.status });
    }
  }

  deliver(req: Req, audio: Uint8Array, stepTime: number | undefined): void {
    req.audioBytes += audio.length;
    this.push(req, { type: 'chunk', audio, stepTime, request: req.facade });
  }

  push(req: Req, event: ContextEvent): void {
    const ctx = req.ctx;
    const rec: Rec = { event, req, taken: false };
    ctx.queue.push(rec);
    req.recs.push(rec);
    // Drop records already taken by the other reader, so neither buffer grows without bound.
    while (ctx.qHead < ctx.queue.length && (ctx.queue[ctx.qHead] as Rec).taken) ctx.qHead++;
    if (ctx.qHead > 256 && ctx.qHead * 2 >= ctx.queue.length) {
      ctx.queue = ctx.queue.slice(ctx.qHead);
      ctx.qHead = 0;
    }
    while (req.rHead < req.recs.length && (req.recs[req.rHead] as Rec).taken) req.rHead++;
    if (req.rHead > 64 && req.rHead * 2 >= req.recs.length) {
      req.recs = req.recs.slice(req.rHead);
      req.rHead = 0;
    }
    ctx.signal.notify();
    req.signal.notify();
  }

  /** Takes a request off the wire without settling it. */
  detach(req: Req): void {
    const ctx = req.ctx;
    const conn = req.conn;
    const i = ctx.inflight.indexOf(req);
    if (i !== -1) ctx.inflight.splice(i, 1);
    req.inflight = false;
    req.conn = undefined;
    if (conn) {
      conn.unfinished--;
      if (ctx.inflight.length === 0 && ctx.conn === conn) {
        conn.active.delete(ctx);
        ctx.conn = undefined;
      }
      if (conn.draining && conn.active.size === 0 && !conn.closed) {
        // Nothing left to wait for on it: close it rather than wait for the server.
        this.debug('closing a drained connection', { connection: conn.id });
        conn.closeAs = 1001;
        try {
          conn.socket.close(1000, 'drained');
        } catch {
          // Already closing.
        }
      }
    }
  }

  release(req: Req): void {
    this.detach(req);
    this.maybeRetire(req.ctx);
  }

  settle(req: Req, outcome: Outcome): void {
    if (req.settled) return;
    req.settled = true;
    const ctx = req.ctx;
    ctx.unfinished--;
    if (outcome.type === 'done') {
      this.push(req, { type: 'done', request: req.facade });
      req.result.resolve({ requestId: req.requestId, audioBytes: req.audioBytes, cancelled: false });
    } else if (outcome.type === 'cancelled') {
      this.push(req, { type: 'cancelled', request: req.facade });
      req.result.resolve({ requestId: req.requestId, audioBytes: req.audioBytes, cancelled: true });
    } else {
      req.error = outcome.error;
      this.push(req, { type: 'failed', error: outcome.error, request: req.facade });
      req.result.reject(outcome.error);
    }
    req.sent.resolve();
    this.maybeRetire(ctx);
  }

  maybeRetire(ctx: Ctx): void {
    if (ctx.inputEnded && ctx.unfinished === 0 && ctx.inflight.length === 0 && !ctx.cancel) {
      if (this.contexts.get(ctx.id) === ctx) this.contexts.delete(ctx.id);
      this.withPending.delete(ctx);
      ctx.signal.notify();
    }
  }

  failPending(error: BakbakError): void {
    for (const ctx of this.withPending) {
      const pending = ctx.pending;
      ctx.pending = [];
      ctx.heldCount = 0;
      for (const req of pending) this.settle(req, { type: 'failed', error });
    }
    this.withPending.clear();
  }

  // ---------------------------------------------------------------- cancel

  async cancel(ctx: Ctx): Promise<void> {
    while (ctx.cancel) await ctx.cancel.done.promise;
    const local = ctx.pending;
    ctx.pending = [];
    ctx.heldCount = 0;
    this.withPending.delete(ctx);
    const doomed = new Set<Req>([...ctx.inflight, ...local]);
    // Audio that arrived but was not read yet is dropped too: after cancel() the context is silent.
    for (let i = ctx.qHead; i < ctx.queue.length; i++) {
      const rec = ctx.queue[i] as Rec;
      if (!rec.taken && rec.event.type === 'chunk' && doomed.has(rec.req)) {
        rec.taken = true;
        rec.req.audioBytes -= rec.event.audio.length;
      }
    }
    const conn = ctx.conn;
    if (!conn || ctx.inflight.length === 0) {
      for (const req of local) this.settle(req, { type: 'cancelled' });
      this.maybeRetire(ctx);
      return;
    }
    const done = deferred<void>();
    ctx.cancel = { conn, requests: ctx.inflight.slice(), local, done };
    ctx.lastActivity = now();
    try {
      conn.socket.send(JSON.stringify({ context_id: ctx.id, cancel: true }));
    } catch {
      // The socket is closing; its close event finishes the cancel.
    }
    await done.promise;
  }

  finishCancel(ctx: Ctx): void {
    const state = ctx.cancel;
    if (!state) return;
    ctx.cancel = undefined;
    for (const req of state.requests) {
      this.detach(req);
      this.settle(req, { type: 'cancelled' });
    }
    for (const req of state.local) this.settle(req, { type: 'cancelled' });
    state.done.resolve();
    this.maybeRetire(ctx);
    this.pump();
  }

  // ---------------------------------------------------------------- timeouts

  ensureSweep(): void {
    if (this.sweepTimer || !Number.isFinite(this.cfg.timeout)) return;
    const tick = Math.max(10, Math.min(1_000, this.cfg.timeout / 4));
    this.sweepTimer = setInterval(() => this.sweep(), tick);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  sweep(): void {
    const t = now();
    let busy = false;
    for (const conn of this.conns) {
      for (const ctx of [...conn.active]) {
        busy = true;
        if (t - ctx.lastActivity >= this.cfg.timeout) this.onContextTimeout(conn, ctx);
      }
    }
    if (!busy) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** No message for a context with unfinished requests within the read timeout. */
  onContextTimeout(conn: Conn, ctx: Ctx): void {
    const ms = Math.round(this.cfg.timeout);
    if (ctx.cancel) {
      // Not even a cancel acknowledgement: the connection is broken.
      this.debug('no answer to a cancel; dropping the connection', { connection: conn.id });
      this.forceClose(conn, 4000);
      return;
    }
    for (const req of ctx.inflight) {
      if (req.settled) continue;
      const error = req.hadAudio
        ? new StreamInterruptedError(`No audio for ${ms} ms after ${req.audioBytes} bytes.`, {
            retryable: true,
            requestId: req.requestId,
            audioBytes: req.audioBytes,
          })
        : new APITimeoutError(`No answer from the API for ${ms} ms.`, { requestId: req.requestId });
      this.settle(req, { type: 'failed', error });
    }
    // Stop the server's work and discard its late messages until it acknowledges.
    ctx.cancel = { conn, requests: ctx.inflight.slice(), local: [], done: deferred<void>() };
    ctx.lastActivity = now();
    try {
      conn.socket.send(JSON.stringify({ context_id: ctx.id, cancel: true }));
    } catch {
      // The socket is closing.
    }
  }

  // ---------------------------------------------------------------- closes

  onClose(conn: Conn, rawCode: number, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    if (this.current === conn) this.current = undefined;
    conn.gone.resolve();
    const code = conn.closeAs ?? rawCode;
    this.debug('closed', { connection: conn.id, code, reason });
    if (this.closed) return;
    const ruleBreak = code === 1008 || code === 1009;
    let resent = 0;
    for (const ctx of [...conn.active]) {
      if (ctx.cancel?.conn === conn) this.finishCancel(ctx);
      const back: Req[] = [];
      for (const req of ctx.inflight) {
        req.inflight = false;
        req.conn = undefined;
        if (req.settled) continue;
        if (ruleBreak) {
          this.settle(req, {
            type: 'failed',
            error: new WebSocketClosedError(
              `The server closed the WebSocket with code ${code} (${CLOSE_NAMES[code]}): ${reason || 'no reason'}.`,
              { closeCode: code, retryable: false, requestId: req.requestId },
            ),
          });
        } else if (req.hadAudio) {
          this.settle(req, {
            type: 'failed',
            error: new StreamInterruptedError(
              `The WebSocket closed (code ${code}) after ${req.audioBytes} bytes of audio.`,
              { retryable: true, requestId: req.requestId, audioBytes: req.audioBytes },
            ),
          });
        } else {
          back.push(req);
        }
      }
      ctx.inflight = [];
      ctx.conn = undefined;
      if (back.length) {
        ctx.pending.splice(ctx.heldCount, 0, ...back);
        this.withPending.add(ctx);
        resent += back.length;
      }
      this.maybeRetire(ctx);
    }
    conn.active.clear();
    conn.unfinished = 0;
    for (const ctx of this.withPending) {
      if (ctx.heldFrom === conn) {
        ctx.heldCount = 0;
        ctx.heldFrom = undefined;
      }
    }

    if (code === 1001 || conn.draining || (code === 1000 && resent > 0)) {
      // Going away (a 1000 with requests unfinished counts as one): reconnect at once and
      // resend; this does not count as a retry.
      if (!this.current) quiet(this.ensureConnection());
      this.pump();
      return;
    }
    if (ruleBreak || code === 1000) {
      this.pump(); // Idle close: the next send reconnects.
      return;
    }
    if (!this.hasSendable()) return;
    this.abnormalCloses++;
    if (this.abnormalCloses === 1) {
      this.pump(); // The first reconnect is immediate.
      return;
    }
    const retry = this.abnormalCloses - 1;
    if (retry > this.cfg.maxRetries) {
      this.failPending(
        new WebSocketClosedError(`The WebSocket keeps closing (last code ${code}); giving up.`, {
          closeCode: code,
          retryable: true,
        }),
      );
      return;
    }
    this.reconnectWait = true;
    this.cfg.sleep(backoffMs(retry)).then(() => {
      this.reconnectWait = false;
      this.pump();
    }, noop);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    const error = this.closedError();
    for (const ctx of this.contexts.values()) {
      const state = ctx.cancel;
      ctx.cancel = undefined;
      for (const req of [...ctx.inflight, ...ctx.pending]) this.settle(req, { type: 'failed', error });
      if (state) {
        for (const req of state.local) this.settle(req, { type: 'failed', error });
        state.done.resolve();
      }
      ctx.inflight = [];
      ctx.pending = [];
      ctx.conn = undefined;
      ctx.inputEnded = true;
      ctx.signal.notify();
    }
    this.contexts.clear();
    this.withPending.clear();
    const conns = [...this.conns];
    for (const conn of conns) {
      try {
        conn.socket.close(1000, 'client closed');
      } catch {
        // Already closing.
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(conns.map((c) => c.gone.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
    clearTimeout(timer);
    for (const conn of conns) if (!conn.closed) conn.socket.terminate();
  }

  // ---------------------------------------------------------------- contexts

  context(options: ContextOptions): Ctx {
    if (this.closed) throw new BakbakError('This WebSocket is closed; create a new one.');
    const { contextId, ...defaults } = options;
    const id = contextId ?? randomContextId();
    if (!CONTEXT_ID.test(id)) {
      throw new BakbakError(
        `Invalid contextId ${JSON.stringify(id)}: use 1-128 characters of A-Z a-z 0-9 . _ -`,
      );
    }
    if (this.contexts.has(id)) throw new BakbakError(`Context ${id} is already open on this WebSocket.`);
    const ctx = new Ctx(this, id, defaults);
    this.contexts.set(id, ctx);
    return ctx;
  }

  endInput(ctx: Ctx): void {
    ctx.inputEnded = true;
    this.maybeRetire(ctx);
    ctx.signal.notify();
  }
}

/** A request on a WebSocket context, as returned by `ctx.send()`. */
export class WebSocketRequest {
  #r: Req;

  /** @internal Created by `ctx.send()`. */
  constructor(internal: unknown) {
    this.#r = internal as Req;
  }

  /** The context the request was sent on. */
  get contextId(): string {
    return this.#r.ctx.id;
  }

  /** The request id, once the API has answered. */
  get requestId(): string | undefined {
    return this.#r.requestId;
  }

  /** Bytes of audio delivered so far. */
  get audioBytes(): number {
    return this.#r.audioBytes;
  }

  /** True once the request is done, failed or cancelled. */
  get finished(): boolean {
    return this.#r.settled;
  }

  /** Resolves when the request is done or cancelled; rejects with its error if it failed. */
  result(): Promise<WebSocketRequestResult> {
    return this.#r.result.promise;
  }

  /**
   * This request's audio. Each chunk is delivered once: to this iterator or to
   * `ctx.events()`/`ctx.audio()`, whichever reads it first, so read a context one way.
   * (Terminal events still reach `ctx.events()`.) Throws the request's error if it failed.
   */
  async *audio(): AsyncGenerator<Uint8Array, void, undefined> {
    const req = this.#r;
    for (;;) {
      while (req.rHead < req.recs.length) {
        const rec = req.recs[req.rHead++] as Rec;
        const event = rec.event;
        if (event.type !== 'chunk') {
          // Terminal events stay visible to ctx.events(); only audio is delivered once.
          if (event.type === 'failed') throw event.error;
          return;
        }
        if (rec.taken) continue;
        rec.taken = true;
        yield event.audio;
      }
      if (req.settled) {
        if (req.error) throw req.error;
        return;
      }
      await req.signal.wait();
    }
  }
}

/** Fields a context applies to every request it sends, and its id. */
export interface ContextOptions extends TTSDefaults {
  /** 1-128 characters of `A-Z a-z 0-9 . _ -`. Default: `ctx_` and 32 random hex digits. */
  contextId?: string | undefined;
}

/** The request fields of `ctx.send()`: `text`, plus any field to set or override. */
export type ContextSendParams = TTSDefaults & { text: string };

/** Options of `ctx.send()`. */
export interface ContextSendOptions {
  /** Extra JSON fields, for API features the SDK does not model yet. */
  extraBody?: Record<string, unknown> | undefined;
}

/** Options of `ctx.sendStream()`. */
export interface SendStreamOptions extends ContextSendOptions {
  /** Request fields for every sentence, over the context's defaults. */
  params?: TTSDefaults | undefined;
  /** Sentence segmenter options. */
  segmenter?: SegmenterOptions | undefined;
  /** Call `endInput()` when the source ends (default true). */
  endInput?: boolean | undefined;
}

/**
 * A context: an ordered sequence of requests on a WebSocket. Requests on one context run
 * one after another; different contexts run at the same time.
 */
export class WebSocketContext {
  #c: Ctx;

  /** @internal Created by `ws.context()`. */
  constructor(internal: unknown) {
    this.#c = internal as Ctx;
  }

  /** The context id sent with every request. */
  get contextId(): string {
    return this.#c.id;
  }

  /**
   * Sends one request, with the context's defaults merged under `params`. Resolves when it
   * is on the wire (waiting, if the connection is at its limits); its outcome arrives through
   * `events()`, `audio()` or the returned request.
   */
  send(params: ContextSendParams, options?: ContextSendOptions): Promise<WebSocketRequest> {
    return this.#c.session.send(this.#c, params, options?.extraBody);
  }

  /**
   * Sends text that arrives in pieces (LLM tokens), one sentence per request as soon as each
   * sentence is complete, then calls `endInput()` unless `endInput: false`. Accepts strings
   * and OpenAI, Anthropic, Gemini and Vercel AI SDK stream events. Resolves when every
   * sentence is on the wire.
   */
  sendStream(
    source: AsyncIterable<unknown> | Iterable<unknown>,
    options: SendStreamOptions = {},
  ): Promise<void> {
    return quiet(this.#sendStream(source, options));
  }

  async #sendStream(
    source: AsyncIterable<unknown> | Iterable<unknown>,
    options: SendStreamOptions,
  ): Promise<void> {
    const ctx = this.#c;
    const segmenter = new Segmenter(options.segmenter);
    const sendAll = async (sentences: string[]) => {
      for (const text of sentences) await this.send({ ...options.params, text }, options);
    };
    try {
      for await (const piece of source) {
        const text = textOf(piece);
        if (text) await sendAll(segmenter.push(text));
      }
      await sendAll(segmenter.flush());
    } catch (error) {
      if (!ctx.inputEnded) {
        ctx.inputError = { error };
        this.endInput();
      }
      throw error;
    }
    if (options.endInput !== false) this.endInput();
  }

  /** No more requests: `events()` and `audio()` end once every request has finished. */
  endInput(): void {
    this.#c.session.endInput(this.#c);
  }

  /**
   * Stops the running request and drops the queued ones; each ends as `cancelled`. Resolves
   * when the API acknowledges. Audio not yet read is discarded. The context stays usable.
   */
  cancel(): Promise<void> {
    return this.#c.session.cancel(this.#c);
  }

  /**
   * Every event of the context, in order: `chunk`, then `done`, `failed` or `cancelled` for
   * each request. Ends after `endInput()` once every request has finished. Read it once.
   */
  async *events(): AsyncGenerator<ContextEvent, void, undefined> {
    const ctx = this.#c;
    for (;;) {
      while (ctx.qHead < ctx.queue.length) {
        const rec = ctx.queue[ctx.qHead++] as Rec;
        if (rec.taken) continue;
        rec.taken = true;
        yield rec.event;
      }
      if (ctx.inputEnded && ctx.unfinished === 0) {
        if (ctx.inputError) throw ctx.inputError.error;
        return;
      }
      await ctx.signal.wait();
    }
  }

  /** Only the audio bytes of `events()`; throws the first failure. */
  async *audio(): AsyncGenerator<Uint8Array, void, undefined> {
    for await (const event of this.events()) {
      if (event.type === 'chunk') yield event.audio;
      else if (event.type === 'failed') throw event.error;
    }
  }
}

/**
 * A WebSocket to the synthesis API (`client.tts.websocket()`): many streaming requests on
 * one connection, in independent ordered contexts. Opens on `connect()` or the first send,
 * reconnects as BEHAVIOR.md §6.4 describes, and must be closed with `close()`.
 */
export class TTSWebSocket {
  /**
   * Called with errors about no request (BEHAVIOR.md §6.5), e.g. a malformed message. When
   * unset they go to the logger's `warn`.
   */
  onNotice: ((error: APIError) => void) | undefined = undefined;
  #s: Session;

  /** @internal Created by `client.tts.websocket()`. */
  constructor(cfg: unknown, defaults: TTSDefaults = {}) {
    this.#s = new Session(cfg as Config, defaults, this);
  }

  /** Opens the connection now, so the first request pays no handshake. */
  async connect(): Promise<void> {
    if (this.#s.closed) throw new BakbakError('This WebSocket is closed; create a new one.');
    await this.#s.ensureConnection();
  }

  /** True while a connection is open. */
  get connected(): boolean {
    const conn = this.#s.current;
    return conn !== undefined && !conn.closed;
  }

  /** A new context with these defaults; without `contextId` one is generated. */
  context(options: ContextOptions = {}): WebSocketContext {
    return this.#s.context(options).facade;
  }

  /** Closes the WebSocket. Unfinished requests fail with `WebSocketClosedError`. */
  close(): Promise<void> {
    return this.#s.close();
  }
}
