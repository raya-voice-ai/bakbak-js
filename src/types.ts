/** A language code. Known values are listed; any other string is passed through to the API. */
export type Language =
  | 'hi'
  | 'mr'
  | 'te'
  | 'kn'
  | 'bn'
  | 'as'
  | 'gu'
  | 'ne'
  | 'ml'
  | 'ta'
  | 'pa'
  | 'en'
  | 'en-in'
  | 'en-us'
  | (string & {});

/** A model: `standard` (the API's default) or `m1`. Must match the voice's model. */
export type Model = 'standard' | 'm1' | (string & {});

/** Audio container. Streaming (SSE and WebSocket) accepts only `raw`. */
export type Container = 'raw' | 'wav' | 'mp3' | (string & {});

/** Raw sample encoding, mono. Required for `raw` and `wav`; omit it for `mp3`. */
export type Encoding = 'pcm_f32le' | 'pcm_s16le' | 'pcm_mulaw' | 'pcm_alaw' | (string & {});

/** Samples per second. The API's default is 24000. */
export type SampleRate = 8000 | 16000 | 22050 | 24000 | (number & {});

/** The `output_format` request field. */
export interface OutputFormat {
  container: Container;
  encoding?: Encoding | undefined;
  sample_rate?: SampleRate | undefined;
}

/**
 * A synthesis request, in the API's own field names. Without `output_format` the
 * whole-file endpoint returns 24 kHz WAV and the streams send 24 kHz 32-bit float PCM.
 */
export interface TTSParams {
  /** 1 to 5,000 characters. Hindi must be in Devanagari. */
  text: string;
  /** A voice id from `client.voices.list()`. */
  voice_id: string;
  language: Language;
  model?: Model | undefined;
  /**
   * 0.5 to 1.5; default 1.0. Changes `standard` voices only: `m1` voices accept it and speak
   * at their own pace.
   */
  speed?: number | undefined;
  output_format?: OutputFormat | undefined;
}

/** Request fields a WebSocket handle or context applies to every request it sends. */
export type TTSDefaults = Partial<Omit<TTSParams, 'text'>>;

/** One voice of the catalog. */
export interface Voice {
  id: string;
  name: string;
  language: Language;
  model: Model;
  [field: string]: unknown;
}

/** The voice catalog, after the client-side `model`/`language` filters. */
export interface VoiceList {
  voices: Voice[];
  count: number;
}

/** Client-side filters of `client.voices.list()`. */
export interface VoiceFilter {
  model?: Model | undefined;
  language?: Language | undefined;
}
