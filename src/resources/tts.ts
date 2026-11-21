import { Audio } from '../audio';
import type { Config, RequestOptions } from '../core/config';
import { BakbakError, interruptedBy } from '../core/errors';
import { Attempt, fetchOk, jsonBody, retriesOf, timeoutOf, toSDKError, waitToRetry } from '../core/http';
import { AudioStream } from '../stream';
import type { TTSDefaults, TTSParams } from '../types';
import { TTSWebSocket } from '../ws/session';

async function readAll(res: Response, attempt: Attempt, onBytes: (n: number) => void): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      attempt.touch();
      parts.push(value);
      total += value.length;
      onBytes(value.length);
    }
  } finally {
    reader.releaseLock();
  }
  // Copy into one buffer that starts at offset 0, so typed-array views of it are aligned.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `client.tts`: text-to-speech. */
export class TTS {
  #cfg: Config;

  /** @internal */
  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  /**
   * Synthesizes a whole file. Without `output_format` the API returns 24 kHz WAV. Retries
   * failures before the first byte of audio; never after it.
   */
  async generate(params: TTSParams, options?: RequestOptions): Promise<Audio> {
    const cfg = this.#cfg;
    const body = jsonBody(params, options);
    const maxRetries = retriesOf(cfg, options);
    const signal = options?.signal;
    for (let retry = 0; ; retry++) {
      const attempt = new Attempt(timeoutOf(cfg, options), signal);
      let received = 0;
      let requestId: string | undefined;
      try {
        const res = await fetchOk(
          cfg,
          { method: 'POST', path: '/v1/text-to-speech', body, accept: '*/*' },
          options,
          attempt,
        );
        requestId = res.headers.get('x-request-id') ?? undefined;
        const rate = res.headers.get('x-audio-sample-rate');
        const metadata = {
          requestId,
          contentType: res.headers.get('content-type') ?? undefined,
          encoding: res.headers.get('x-audio-format') ?? undefined,
          sampleRate: rate ? Number(rate) : undefined,
        };
        const data = await readAll(res, attempt, (n) => {
          received += n;
        });
        cfg.logger?.debug?.('generate: done', { requestId, bytes: data.length });
        return new Audio(data, metadata);
      } catch (thrown) {
        const err = toSDKError(thrown, attempt, signal);
        attempt.dispose();
        attempt.controller.abort();
        // Audio has started: never retry (BEHAVIOR.md §4.1).
        if (received > 0) throw err instanceof BakbakError ? interruptedBy(err, received, requestId) : err;
        if (!(await waitToRetry(cfg, err, retry, maxRetries, signal, 'generate'))) throw err;
      } finally {
        attempt.dispose();
      }
    }
  }

  /**
   * Streams one request over Server-Sent Events. The request starts at once; iterate the
   * returned stream for {@link AudioChunk}s. Streaming accepts only the `raw` container.
   */
  stream(params: TTSParams, options?: RequestOptions): AudioStream {
    return new AudioStream(this.#cfg, params, options);
  }

  /**
   * A WebSocket for many streaming requests on one connection, in ordered contexts. The
   * given fields apply to every request it sends. Call `connect()` to open it ahead of the
   * first request, and `close()` when done.
   */
  websocket(defaults: TTSDefaults = {}): TTSWebSocket {
    return new TTSWebSocket(this.#cfg, defaults);
  }
}
