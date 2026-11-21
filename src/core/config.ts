import type { RuntimeInfo } from './runtime';
import type { SleepFn } from './util';

/**
 * Receives the SDK's diagnostic messages. Logs never contain the API key or synthesis text,
 * only request ids, statuses, timings and sizes. Each method is optional.
 */
export interface Logger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
}

/** The `fetch` signature the SDK calls. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Options of `new Bakbak(options)`. */
export interface ClientOptions {
  /** API key. Defaults to the `BAKBAK_API_KEY` environment variable. */
  apiKey?: string | undefined;
  /** API base URL. Defaults to `BAKBAK_BASE_URL`, then `https://hub.getraya.app`. */
  baseURL?: string | undefined;
  /**
   * Read timeout in milliseconds (default 60 000): the longest wait for the next bytes of a
   * response, or the next message of a WebSocket context with unfinished requests. It
   * includes the time to first audio. For a total deadline, pass an `AbortSignal`.
   */
  timeout?: number | undefined;
  /** WebSocket connect timeout in milliseconds (default 5 000): TCP, TLS and the upgrade. */
  connectTimeout?: number | undefined;
  /** Retries of a failure before any audio (default 2, so at most 3 attempts). */
  maxRetries?: number | undefined;
  /** Headers sent with every request. */
  defaultHeaders?: Record<string, string> | undefined;
  /** A `fetch` implementation, e.g. for a proxy or tests. Defaults to the global `fetch`. */
  fetch?: FetchFn | undefined;
  /**
   * Allows running in a browser. Off by default because the API key would be visible to
   * anyone using the page; use it only with a key you are willing to expose.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
  /** Receives debug and warning messages. The SDK logs nothing by default. */
  logger?: Logger | undefined;
  /**
   * WebSocket implementation. `auto` (default): the `ws` package on Node when installed,
   * else the runtime's global `WebSocket`. `ws` or `global` force one.
   */
  webSocket?: 'auto' | 'ws' | 'global' | undefined;
  /**
   * The function used to wait between retries; replace it in tests to record or skip waits.
   * Receives milliseconds and the call's abort signal.
   */
  sleep?: SleepFn | undefined;
}

/** Options of one call, the last argument of every method that talks to the API. */
export interface RequestOptions {
  /** Aborts the call; the promise or stream rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
  /** Read timeout for this call in milliseconds; see {@link ClientOptions.timeout}. */
  timeout?: number | undefined;
  /** Retries for this call; see {@link ClientOptions.maxRetries}. */
  maxRetries?: number | undefined;
  /** Extra headers for this call. */
  headers?: Record<string, string> | undefined;
  /** Extra JSON body fields, for API features the SDK does not model yet. */
  extraBody?: Record<string, unknown> | undefined;
}

/** The client's resolved configuration (internal). */
export interface Config {
  apiKey: string;
  baseURL: string;
  timeout: number;
  connectTimeout: number;
  maxRetries: number;
  /** X-API-Key, identity headers and the caller's default headers. */
  headers: Record<string, string>;
  fetch: FetchFn;
  sleep: SleepFn;
  logger: Logger | undefined;
  runtime: RuntimeInfo;
  webSocket: 'auto' | 'ws' | 'global';
}
