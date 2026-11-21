import type { ClientOptions, Config, FetchFn, RequestOptions } from './core/config';
import { BakbakError } from './core/errors';
import { detectRuntime, readEnv } from './core/runtime';
import { defaultSleep } from './core/util';
import { TTS } from './resources/tts';
import { Voices } from './resources/voices';
import { VERSION } from './version';

const DEFAULT_BASE_URL = 'https://hub.getraya.app';

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new BakbakError(`${name} must be a positive number of milliseconds (or Infinity), got ${value}.`);
  }
  return value;
}

/**
 * The Bakbak text-to-speech client.
 *
 * ```ts
 * const client = new Bakbak(); // reads BAKBAK_API_KEY
 * const audio = await client.tts.generate({ text: 'नमस्ते', voice_id, language: 'hi', model: 'm1' });
 * ```
 */
export class Bakbak {
  /** Text-to-speech: `generate()`, `stream()` and `websocket()`. */
  readonly tts: TTS;
  /** The voice catalog. */
  readonly voices: Voices;
  /** The API base URL in use. */
  readonly baseURL: string;
  #cfg: Config;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv('BAKBAK_API_KEY');
    if (!apiKey) {
      throw new BakbakError(
        'No API key: pass apiKey to new Bakbak({ apiKey }) or set the BAKBAK_API_KEY environment variable.',
      );
    }
    const runtime = detectRuntime();
    if (runtime.browser && !options.dangerouslyAllowBrowser) {
      throw new BakbakError(
        'Bakbak is running in a browser, where the API key would be visible to anyone using the page. ' +
          'Call the API from your server instead, or pass dangerouslyAllowBrowser: true if you accept that risk.',
      );
    }
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new BakbakError(`maxRetries must be a non-negative integer, got ${maxRetries}.`);
    }
    this.baseURL = (options.baseURL ?? readEnv('BAKBAK_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const headers: Record<string, string> = { 'X-API-Key': apiKey };
    if (runtime.userAgent && !runtime.browser) {
      // Browsers send neither: the API's CORS policy refuses extra headers (BEHAVIOR.md §8).
      headers['User-Agent'] = runtime.userAgent;
      headers['X-Bakbak-Client'] = `bakbak-js/${VERSION}`;
    }
    Object.assign(headers, options.defaultHeaders);
    const fetchFn: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.#cfg = {
      apiKey,
      baseURL: this.baseURL,
      timeout: positive('timeout', options.timeout, 60_000),
      connectTimeout: positive('connectTimeout', options.connectTimeout, 5_000),
      maxRetries,
      headers,
      fetch: fetchFn,
      sleep: options.sleep ?? defaultSleep,
      logger: options.logger,
      runtime,
      webSocket: options.webSocket ?? 'auto',
    };
    this.tts = new TTS(this.#cfg);
    this.voices = new Voices(this.#cfg);
  }

  /**
   * Opens and keeps an HTTPS connection to the API (with a voice-list request), so the
   * first synthesis does not pay for DNS, TCP and TLS. Optional.
   */
  async warmup(options?: RequestOptions): Promise<void> {
    await this.voices.list({}, options);
  }
}
