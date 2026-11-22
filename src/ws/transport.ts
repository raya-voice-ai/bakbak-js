import type { FetchFn, Logger } from '../core/config';
import {
  APIConnectionError,
  APITimeoutError,
  type BakbakError,
  makeStatusError,
  redirectError,
  safeCause,
  scrub,
} from '../core/errors';
import { importOptional, type RuntimeInfo } from '../core/runtime';
import { finiteTimeout, parseRetryAfter, setRetryAfter, startTimer } from '../core/util';

/** An open WebSocket, whichever library provides it. */
export interface Socket {
  send(data: string): void;
  /** Closes with a close frame. */
  close(code: number, reason: string): void;
  /** Drops the connection at once (a dead peer would never answer a close frame). */
  terminate(): void;
}

/** Callbacks of an open socket. */
export interface SocketHandlers {
  onMessage(data: string): void;
  onBinary(): void;
  onClose(code: number, reason: string): void;
}

export interface OpenOptions {
  /** `wss://…/v1/text-to-speech/ws`, without credentials. */
  url: string;
  apiKey: string;
  /** X-API-Key, identity and default headers, for transports that can send headers. */
  headers: Record<string, string>;
  impl: 'auto' | 'ws' | 'global';
  runtime: RuntimeInfo;
  connectTimeout: number;
  logger: Logger | undefined;
  /** The client's fetch, for asking over HTTP why a global WebSocket's handshake failed. */
  fetch: FetchFn;
}

/** Replaces the API key in a URL's query string with `***`, for anything that is logged. */
export function redactKey(url: string): string {
  return url.replace(/([?&]x-api-key=)[^&#]*/gi, '$1***');
}

/** The `ws` package's client class, structurally (the package is an optional peer dependency). */
interface WsClient {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: { toString(): string }, isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: { toString(): string }) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'unexpected-response', listener: (req: { destroy(): void }, res: UpgradeResponse) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
type WsCtor = new (url: string, options: Record<string, unknown>) => WsClient;

interface UpgradeResponse {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'end' | 'error' | 'close', listener: () => void): void;
}

let wsModule: Promise<WsCtor | undefined> | undefined;

/** Loads the optional `ws` package once; undefined if it is not installed. */
function loadWs(): Promise<WsCtor | undefined> {
  wsModule ??= importOptional<{ WebSocket?: WsCtor; default?: WsCtor }>('ws').then(
    (mod) => mod.WebSocket ?? mod.default,
    () => undefined,
  );
  return wsModule;
}

/**
 * A refused upgrade becomes the §3 error for its status and body; so does the answer to the
 * plain GET sent when a global WebSocket hides the refusal. `header` takes lower-case names.
 */
function refusalError(
  status: number,
  reason: string | undefined,
  header: (name: string) => string | null | undefined,
  text: string,
): BakbakError {
  let body: unknown = text || undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  if (status >= 300 && status < 400) return redirectError(status, header('location'), header('x-request-id'));
  const err = makeStatusError(status, body, header('x-request-id'), reason);
  return setRetryAfter(err, parseRetryAfter(header('retry-after')));
}

function upgradeError(res: UpgradeResponse, text: string): BakbakError {
  const header = (name: string) => {
    const value = res.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return refusalError(res.statusCode ?? 0, res.statusMessage, header, text);
}

function openWithWs(WS: WsCtor, o: OpenOptions, h: SocketHandlers): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ws = new WS(o.url, {
      headers: o.headers,
      perMessageDeflate: false,
      // Never follow a redirect: ws would resend X-API-Key to the other origin (BEHAVIOR.md §8).
      followRedirects: false,
      handshakeTimeout: finiteTimeout(o.connectTimeout) ? o.connectTimeout : undefined,
      maxPayload: 64 * 1024 * 1024,
    });
    ws.on('unexpected-response', (req, res) => {
      const parts: Uint8Array[] = [];
      let size = 0;
      const finish = () => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        fail(upgradeError(res, new TextDecoder().decode(bytes)));
        req.destroy();
      };
      res.on('data', (chunk) => {
        if (size < 65_536) {
          parts.push(chunk);
          size += chunk.length;
        }
      });
      res.on('end', finish);
      res.on('error', finish);
    });
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        terminate: () => ws.terminate(),
      });
    });
    ws.on('error', (err) => {
      if (settled) {
        o.logger?.debug?.('websocket: socket error', { error: err.message });
        return;
      }
      const cause = safeCause(err, o.apiKey);
      fail(
        /handshake has timed out/i.test(err.message)
          ? new APITimeoutError(`The WebSocket handshake took longer than ${o.connectTimeout} ms.`, { cause })
          : new APIConnectionError(scrub(`WebSocket connection failed: ${err.message}`, o.apiKey), { cause }),
      );
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) h.onBinary();
      else h.onMessage(data.toString());
    });
    ws.on('close', (code, reason) => {
      if (settled) h.onClose(code, reason.toString());
      else fail(new APIConnectionError(`The WebSocket closed during the handshake (code ${code}).`));
    });
  });
}

/** The WHATWG WebSocket constructor, plus the `headers` option undici and some runtimes accept. */
type NativeCtor = new (url: string, options?: string[] | { headers: Record<string, string> }) => WebSocket;

/**
 * The WHATWG WebSocket hides why a handshake failed, so a wrong key would look like a network
 * failure and be retried. One plain GET to the same URL, with the key placed the same way and
 * timed by the connect timeout, tells (BEHAVIOR.md §6.1): the endpoint answers 426 to a request
 * that is not an upgrade, so a 426 means the key and URL are good and the WebSocket itself was
 * refused; any other error status is the §3 error the upgrade got. Without an answer, or with a
 * 2xx, `noAnswer` stands.
 */
async function askWhyHandshakeFailed(
  url: string,
  o: OpenOptions,
  withHeaders: boolean,
  noAnswer: BakbakError,
): Promise<BakbakError> {
  const httpURL = url.replace(/^ws/i, 'http'); // wss: → https:, ws: → http:
  const controller = new AbortController();
  const timer = startTimer(() => controller.abort(), o.connectTimeout);
  try {
    const res = await o.fetch(httpURL, {
      method: 'GET',
      // Where the key goes in the query string (browsers), it is already in the URL.
      headers: withHeaders ? o.headers : {},
      // Never follow a redirect: fetch would carry X-API-Key to the other origin (BEHAVIOR.md §8).
      redirect: 'manual',
      signal: controller.signal,
    });
    o.logger?.debug?.('websocket: the handshake failed; asked over HTTP', {
      url: redactKey(httpURL),
      status: res.status,
    });
    if (res.type === 'opaqueredirect') return redirectError(undefined, null, null);
    if (res.status === 426) {
      await res.body?.cancel().catch(() => {});
      return new APIConnectionError(
        'The WebSocket handshake failed, but the API accepted the key and URL over HTTP: the network or a ' +
          'proxy refused the WebSocket.',
      );
    }
    if (res.status < 300) {
      await res.body?.cancel().catch(() => {});
      return noAnswer;
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      // A body that cannot be read leaves the status to speak for itself.
    }
    return refusalError(res.status, res.statusText, (name) => res.headers.get(name), text);
  } catch (err) {
    o.logger?.debug?.('websocket: the handshake failed; no answer over HTTP', {
      url: redactKey(httpURL),
      error: err instanceof Error ? scrub(err.message, o.apiKey) : undefined,
    });
    return noAnswer;
  } finally {
    clearTimeout(timer);
  }
}

function openWithGlobal(Native: NativeCtor, o: OpenOptions, h: SocketHandlers): Promise<Socket> {
  const withHeaders = o.runtime.nativeWebSocketHeaders;
  const url = withHeaders
    ? o.url
    : `${o.url}${o.url.includes('?') ? '&' : '?'}X-API-Key=${encodeURIComponent(o.apiKey)}`;
  o.logger?.debug?.('websocket: connecting with the global WebSocket', {
    url: redactKey(url),
    key: withHeaders ? 'header' : 'query string',
  });
  return new Promise((resolve, reject) => {
    let opened = false;
    let failed = false;
    const fail = (err: unknown) => {
      if (opened || failed) return;
      failed = true;
      clearTimeout(timer);
      reject(err);
    };
    // The handshake failed before open, and this WebSocket does not say why: ask over HTTP,
    // once per attempt (error and close both report it), and settle with what that tells.
    const handshakeFailed = (noAnswer: BakbakError) => {
      if (opened || failed) return;
      failed = true;
      clearTimeout(timer);
      askWhyHandshakeFailed(url, o, withHeaders, noAnswer).then(reject, reject);
    };
    const ws = withHeaders ? new Native(url, { headers: o.headers }) : new Native(url);
    ws.binaryType = 'arraybuffer';
    const timer = startTimer(() => {
      fail(new APITimeoutError(`The WebSocket handshake took longer than ${o.connectTimeout} ms.`));
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    }, o.connectTimeout);
    ws.onopen = () => {
      if (failed) return;
      opened = true;
      clearTimeout(timer);
      resolve({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        terminate: () => ws.close(4000, 'terminated'),
      });
    };
    ws.onerror = () => {
      handshakeFailed(
        new APIConnectionError(
          'The WebSocket handshake failed, and neither the WebSocket nor an HTTP request to the same URL ' +
            'said why: check the network, the base URL and the API key.',
        ),
      );
    };
    ws.onclose = (event) => {
      if (opened) h.onClose(event.code, event.reason);
      else
        handshakeFailed(
          new APIConnectionError(`The WebSocket closed during the handshake (code ${event.code}).`),
        );
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') h.onMessage(event.data);
      else h.onBinary();
    };
  });
}

/**
 * Opens the synthesis WebSocket with the implementation BEHAVIOR.md §6.1 calls for: the `ws`
 * package on Node (key in a header), else the runtime's global WebSocket, with the key in a
 * header where the runtime supports that (Node 22+) and in the query string elsewhere.
 */
export async function openSocket(o: OpenOptions, h: SocketHandlers): Promise<Socket> {
  if (o.impl === 'ws' || (o.impl === 'auto' && o.runtime.kind === 'node')) {
    const WS = await loadWs();
    if (WS) {
      o.logger?.debug?.('websocket: connecting with ws', { url: o.url });
      return openWithWs(WS, o, h);
    }
    if (o.impl === 'ws') {
      throw new APIConnectionError('webSocket: "ws" needs the ws package: npm install ws', {
        retryable: false,
      });
    }
  }
  const Native = (globalThis as { WebSocket?: NativeCtor }).WebSocket;
  if (typeof Native !== 'function') {
    throw new APIConnectionError(
      'This runtime has no WebSocket. On Node 20, install the ws package (npm install ws); Node 22+ has one built in.',
      { retryable: false },
    );
  }
  return openWithGlobal(Native, o, h);
}
