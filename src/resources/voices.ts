import type { Config, RequestOptions } from '../core/config';
import { APIConnectionError, isObject } from '../core/errors';
import { Attempt, fetchOk, retriesOf, timeoutOf, toSDKError, waitToRetry } from '../core/http';
import type { Voice, VoiceFilter, VoiceList } from '../types';

/** `client.voices`: the voice catalog. */
export class Voices {
  #cfg: Config;

  /** @internal */
  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  /**
   * Lists the voices, optionally only those of one `model` and/or `language` (filtered by
   * the SDK; the API returns the whole catalog).
   */
  async list(filter: VoiceFilter = {}, options?: RequestOptions): Promise<VoiceList> {
    const cfg = this.#cfg;
    const maxRetries = retriesOf(cfg, options);
    const signal = options?.signal;
    for (let retry = 0; ; retry++) {
      const attempt = new Attempt(timeoutOf(cfg, options), signal);
      try {
        const res = await fetchOk(
          cfg,
          { method: 'GET', path: '/v1/voices', accept: 'application/json' },
          options,
          attempt,
        );
        const body: unknown = await res.json();
        const all = isObject(body) && Array.isArray(body.voices) ? (body.voices as Voice[]) : undefined;
        if (!all) {
          throw new APIConnectionError('The voice list response had no "voices" array.', {
            retryable: false,
            requestId: res.headers.get('x-request-id') ?? undefined,
            body,
          });
        }
        const voices = all.filter(
          (v) =>
            (filter.model === undefined || v.model === filter.model) &&
            (filter.language === undefined || v.language === filter.language),
        );
        return { voices, count: voices.length };
      } catch (thrown) {
        const err = toSDKError(thrown, attempt, signal);
        attempt.dispose();
        if (!(await waitToRetry(cfg, err, retry, maxRetries, signal, 'voices.list'))) throw err;
      } finally {
        attempt.dispose();
      }
    }
  }
}
