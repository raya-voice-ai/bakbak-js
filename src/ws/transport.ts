import type { Logger } from '../core/config';
import { APIConnectionError, APITimeoutError, BakbakError, makeStatusError } from '../core/errors';
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

/** A refused upgrade becomes the §3 error for its status and body. */
function upgradeError(res: UpgradeResponse, text: string): BakbakError {
  let body: unknown = text || undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  const header = (name: string) => {
    const value = res.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const err = makeStatusError(res.statusCode ?? 0, body, header('x-request-id'), res.statusMessage);
  return setRetryAfter(err, parseRetryAfter(header('retry-after')));
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
      fail(
        /handshake has timed out/i.test(err.message)
          ? new APITimeoutError(`The WebSocket handshake took longer than ${o.connectTimeout} ms.`, {
              cause: err,
            })
          : new APIConnectionError(`WebSocket connection failed: ${err.message}`, { cause: err }),
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
      fail(
        new APIConnectionError(
          'The WebSocket handshake failed. This runtime does not expose why (a wrong API key, a wrong base URL, ' +
            'or the network); the same key and URL with client.voices.list() show the HTTP error.',
        ),
      );
    };
    ws.onclose = (event) => {
      if (opened) h.onClose(event.code, event.reason);
      else fail(new APIConnectionError(`The WebSocket closed during the handshake (code ${event.code}).`));
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
    if (o.impl === 'ws') throw new BakbakError('webSocket: "ws" needs the ws package: npm install ws');
  }
  const Native = (globalThis as { WebSocket?: NativeCtor }).WebSocket;
  if (typeof Native !== 'function') {
    throw new BakbakError(
      'This runtime has no WebSocket. On Node 20, install the ws package (npm install ws); Node 22+ has one built in.',
    );
  }
  return openWithGlobal(Native, o, h);
}
