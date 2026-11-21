import { Audio, type AudioMetadata } from './audio';
import { SampleAligner, sampleBytes } from './core/base64';
import type { Config, RequestOptions } from './core/config';
import {
  BakbakError,
  interruptedBy,
  isObject,
  makeInterruptedFromEvent,
  makeStatusError,
  StreamInterruptedError,
} from './core/errors';
import { Attempt, fetchOk, jsonBody, retriesOf, timeoutOf, toSDKError, waitToRetry } from './core/http';
import { parseSSE } from './core/sse';
import { type Deferred, deferred, quiet } from './core/util';
import type { TTSParams } from './types';

/** One piece of streamed audio. Chunks always hold whole samples. */
export interface AudioChunk {
  /** Decoded audio bytes, in the requested encoding. */
  audio: Uint8Array;
  /** The model's generation time for this chunk, in seconds, when the API reports it. */
  stepTime: number | undefined;
  /** The request id, when known. */
  requestId: string | undefined;
}

/** How long to keep reading a finished stream for its end, so its connection can be reused. */
const DRAIN_MS = 2_000;

const CONTENT_TYPES: Record<string, string> = {
  pcm_f32le: 'audio/pcm',
  pcm_s16le: 'audio/pcm',
  pcm_mulaw: 'audio/basic',
  pcm_alaw: 'application/octet-stream',
};

interface StreamHooks {
  /** A successful response started (called again if a retry follows). */
  onResponse(metadata: AudioMetadata): void;
  /** The first audio arrived, or the stream finished: no retry can follow now. */
  onCommitted(requestId: string | undefined): void;
}

/**
 * The SSE request loop: retries before audio, `StreamInterruptedError` after it, and an
 * error rather than a short success when the stream ends without `done` (BEHAVIOR.md §4, §5).
 */
async function* sseChunks(
  cfg: Config,
  params: TTSParams,
  options: RequestOptions | undefined,
  hooks: StreamHooks,
): AsyncGenerator<AudioChunk, void, undefined> {
  const body = jsonBody(params, options);
  const maxRetries = retriesOf(cfg, options);
  const signal = options?.signal;
  for (let retry = 0; ; retry++) {
    const attempt = new Attempt(timeoutOf(cfg, options), signal);
    let gotChunk = false;
    let delivered = 0;
    let requestId: string | undefined;
    let finished = false;
    try {
      const res = await fetchOk(
        cfg,
        { method: 'POST', path: '/v1/text-to-speech/stream', body, accept: 'text/event-stream' },
        options,
        attempt,
      );
      requestId = res.headers.get('x-request-id') ?? undefined;
      const encoding =
        res.headers.get('x-audio-format') ??
        params.output_format?.encoding ??
        (params.output_format ? undefined : 'pcm_f32le');
      const rate = res.headers.get('x-audio-sample-rate');
      hooks.onResponse({
        requestId,
        encoding,
        sampleRate: rate
          ? Number(rate)
          : (params.output_format?.sample_rate ?? (params.output_format ? undefined : 24000)),
        contentType: encoding ? CONTENT_TYPES[encoding] : undefined,
      });
      cfg.logger?.debug?.('stream: response', { requestId, status: res.status });
      const aligner = new SampleAligner(sampleBytes(encoding));
      if (!res.body)
        throw new StreamInterruptedError('The stream had no body.', {
          retryable: true,
          requestId,
          audioBytes: 0,
        });
      for await (const event of parseSSE(res.body, () => attempt.touch())) {
        if (finished) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          cfg.logger?.debug?.('stream: skipped an event that is not JSON', {
            requestId,
            size: event.data.length,
          });
          continue;
        }
        if (!isObject(payload)) continue;
        if (payload.type === 'chunk') {
          if (typeof payload.data !== 'string') continue;
          if (!gotChunk) {
            gotChunk = true;
            hooks.onCommitted(requestId);
          }
          const audio = aligner.push(payload.data);
          if (audio) {
            delivered += audio.length;
            yield {
              audio,
              stepTime: typeof payload.step_time === 'number' ? payload.step_time : undefined,
              requestId,
            };
          }
        } else if (payload.type === 'done') {
          const tail = aligner.flush();
          if (tail) {
            delivered += tail.length;
            yield { audio: tail, stepTime: undefined, requestId };
          }
          finished = true;
          hooks.onCommitted(requestId);
          attempt.shorten(DRAIN_MS);
        } else if (payload.type === 'error') {
          const status = typeof payload.status_code === 'number' ? payload.status_code : 502;
          throw gotChunk
            ? makeInterruptedFromEvent(payload, requestId, delivered)
            : makeStatusError(status, payload, requestId);
        }
        // Other event types are ignored (forward compatibility).
      }
      if (finished) return;
      throw new StreamInterruptedError(
        gotChunk
          ? `The stream ended without a done event after ${delivered} bytes of audio.`
          : 'The stream ended before any audio and without a done event.',
        { retryable: true, requestId, audioBytes: delivered },
      );
    } catch (thrown) {
      if (finished) return; // The audio is complete; a failure while draining does not matter.
      let err = toSDKError(thrown, attempt, signal);
      attempt.dispose();
      attempt.controller.abort();
      if (gotChunk) {
        if (!(err instanceof StreamInterruptedError) && err instanceof BakbakError) {
          err = interruptedBy(err, delivered, requestId);
        }
        throw err;
      }
      if (!(await waitToRetry(cfg, err, retry, maxRetries, signal, 'stream'))) throw err;
    } finally {
      attempt.dispose();
      attempt.controller.abort();
    }
  }
}

/**
 * A streamed synthesis (`client.tts.stream()`): an async iterable of {@link AudioChunk}s.
 * The request starts as soon as the stream is created. Iterate it once, or collect it
 * with `bytes()`, `arrayBuffer()`, `toAudio()` or `toReadableStream()`.
 */
export class AudioStream implements AsyncIterable<AudioChunk> {
  /**
   * Resolves with `X-Request-Id` once audio starts (after any retries); rejects if the
   * request fails before that.
   */
  readonly requestId: Promise<string | undefined>;
  #iterator: AsyncGenerator<AudioChunk, void, undefined>;
  #first: Promise<IteratorResult<AudioChunk, void>>;
  #consumed = false;
  #metadata: AudioMetadata = {};
  #ready: Deferred<string | undefined>;

  /** @internal Use `client.tts.stream()`. */
  constructor(cfg: Config, params: TTSParams, options: RequestOptions | undefined) {
    this.#ready = deferred<string | undefined>();
    this.requestId = quiet(this.#ready.promise);
    const iterator = sseChunks(cfg, params, options, {
      onResponse: (metadata) => {
        this.#metadata = metadata;
      },
      onCommitted: (requestId) => this.#ready.resolve(requestId),
    });
    this.#iterator = iterator;
    // Start now, not on first iteration: time to first audio starts with the call.
    this.#first = quiet(this.#watch(iterator.next()));
  }

  /** Rejects `requestId` if the stream fails before audio started. */
  #watch<T>(step: Promise<T>): Promise<T> {
    return step.catch((err: unknown) => {
      this.#ready.reject(err);
      throw err;
    });
  }

  /** `Content-Type` of the audio (derived from the encoding), once the response started. */
  get contentType(): string | undefined {
    return this.#metadata.contentType;
  }

  /** The raw encoding (`X-Audio-Format`), once the response started. */
  get encoding(): string | undefined {
    return this.#metadata.encoding;
  }

  /** Samples per second (`X-Audio-Sample-Rate`), once the response started. */
  get sampleRate(): number | undefined {
    return this.#metadata.sampleRate;
  }

  [Symbol.asyncIterator](): AsyncIterator<AudioChunk, void, undefined> {
    if (this.#consumed)
      throw new BakbakError('This AudioStream has already been consumed; it can be read only once.');
    this.#consumed = true;
    const iterator = this.#iterator;
    let first: Promise<IteratorResult<AudioChunk, void>> | undefined = this.#first;
    return {
      next: () => {
        if (first) {
          const result = first;
          first = undefined;
          return result;
        }
        return this.#watch(iterator.next());
      },
      return: async () => {
        first = undefined;
        const result = await iterator.return(undefined);
        this.#ready.resolve(this.#metadata.requestId);
        return result;
      },
    };
  }

  /** All the audio, concatenated. */
  async bytes(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this) {
      parts.push(chunk.audio);
      total += chunk.audio.length;
    }
    if (parts.length === 1) return parts[0] as Uint8Array;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /** All the audio, as an `ArrayBuffer`. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes();
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  }

  /** All the audio as an {@link Audio}, with its metadata (for `toWav()` and `save()`). */
  async toAudio(): Promise<Audio> {
    const data = await this.bytes();
    const requestId = await this.requestId;
    return new Audio(data, { ...this.#metadata, requestId });
  }

  /** The audio bytes as a web `ReadableStream`. Cancelling it aborts the request. */
  toReadableStream(): ReadableStream<Uint8Array> {
    const iterator = this[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (result.done) controller.close();
          else controller.enqueue(result.value.audio);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }
}
