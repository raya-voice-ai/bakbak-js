import { BakbakError } from './core/errors';
import { detectRuntime, importOptional } from './core/runtime';

/** WAV format tags and sample widths for the raw encodings the API produces. */
const WAV_FORMATS: Record<string, { tag: number; bits: number }> = {
  pcm_s16le: { tag: 1, bits: 16 },
  pcm_f32le: { tag: 3, bits: 32 },
  pcm_alaw: { tag: 6, bits: 8 },
  pcm_mulaw: { tag: 7, bits: 8 },
};

/** Options of {@link toWav}. */
export interface WavOptions {
  /** The raw encoding of `pcm`: `pcm_s16le`, `pcm_f32le`, `pcm_mulaw` or `pcm_alaw`. */
  encoding: string;
  /** Samples per second, e.g. 24000 or 8000. */
  sampleRate: number;
}

/** Thrown for mp3, which has to be decoded rather than wrapped. */
const MP3_TO_WAV =
  "MP3 audio cannot be wrapped in WAV; decode it with an audio library, or request output_format: { container: 'wav', encoding: 'pcm_s16le' } instead.";

const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function ascii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** True if `data` starts like a WAV file: `RIFF` (or `RF64`), a size, then `WAVE`. */
export function isWavData(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const riff = fourcc(view, 0);
  return (riff === 'RIFF' || riff === 'RF64') && fourcc(view, 8) === 'WAVE';
}

/**
 * The encoding and sample rate that a mono WAV file's `fmt ` chunk states (BEHAVIOR.md §5.2),
 * or undefined for anything else: not WAV, more than one channel, an encoding the API does
 * not produce, or a header cut short. Never throws. The RIFF and `data` sizes are not
 * trusted: a WAV written as a stream may give them as 0xFFFFFFFF.
 */
export function wavFormat(data: Uint8Array): { encoding: string; sampleRate: number } | undefined {
  if (!isWavData(data)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = fourcc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > data.length) return undefined;
      let tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (tag === WAVE_FORMAT_EXTENSIBLE) {
        // The real tag is the first two bytes of the sub-format GUID.
        if (size < 40 || body + 26 > data.length) return undefined;
        tag = view.getUint16(body + 24, true);
      }
      const match = Object.entries(WAV_FORMATS).find(([, f]) => f.tag === tag && f.bits === bits);
      if (!match || channels !== 1 || sampleRate === 0) return undefined;
      return { encoding: match[0], sampleRate };
    }
    if (id === 'data') return undefined; // the format comes before the audio
    offset = body + size + (size % 2); // chunks are padded to an even size
  }
  return undefined;
}

function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0]?.trim().toLowerCase();
}

/**
 * Wraps raw mono audio in a WAV header (BEHAVIOR.md §5.2): the canonical 44-byte PCM header
 * for `pcm_s16le`; for `pcm_f32le`, `pcm_alaw` and `pcm_mulaw` an 18-byte `fmt ` chunk plus
 * a `fact` chunk, 58 bytes in all. Throws for mp3, which has to be decoded instead.
 */
export function toWav(pcm: Uint8Array, options: WavOptions): Uint8Array {
  if (options.encoding === 'mp3') throw new BakbakError(MP3_TO_WAV);
  const format = WAV_FORMATS[options.encoding];
  if (!format) {
    throw new BakbakError(
      `Cannot wrap ${options.encoding} audio in a WAV header; supported encodings are ${Object.keys(WAV_FORMATS).join(', ')}.`,
    );
  }
  const sampleRate = options.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new BakbakError(`toWav needs a positive integer sampleRate, got ${sampleRate}.`);
  }
  const extended = format.tag !== 1;
  const headerSize = extended ? 58 : 44;
  const blockAlign = format.bits / 8;
  const out = new Uint8Array(headerSize + pcm.length);
  const view = new DataView(out.buffer);
  ascii(view, 0, 'RIFF');
  view.setUint32(4, headerSize - 8 + pcm.length, true);
  ascii(view, 8, 'WAVE');
  ascii(view, 12, 'fmt ');
  view.setUint32(16, extended ? 18 : 16, true);
  view.setUint16(20, format.tag, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bits, true);
  let offset = 36;
  if (extended) {
    view.setUint16(36, 0, true); // cbSize
    ascii(view, 38, 'fact');
    view.setUint32(42, 4, true);
    view.setUint32(46, Math.floor(pcm.length / blockAlign), true);
    offset = 50;
  }
  ascii(view, offset, 'data');
  view.setUint32(offset + 4, pcm.length, true);
  out.set(pcm, headerSize);
  return out;
}

/** Response metadata of a synthesis. */
export interface AudioMetadata {
  /** `X-Request-Id`: quote it to support. */
  requestId?: string | undefined;
  /** `Content-Type` of the audio, e.g. `audio/wav`, `audio/basic`, `audio/pcm`. */
  contentType?: string | undefined;
  /**
   * The raw encoding (e.g. `pcm_s16le`) or `mp3`: `X-Audio-Format`, which comes with
   * `output_format`; for a whole WAV file without it, the file's own `fmt ` chunk.
   */
  encoding?: string | undefined;
  /**
   * Samples per second: `X-Audio-Sample-Rate`, or like `encoding` the WAV file's `fmt `
   * chunk. Unset for mp3, whose rate is in its frames.
   */
  sampleRate?: number | undefined;
}

/** Writes bytes to a file on runtimes that have a file system. */
export async function writeFileBytes(path: string, data: Uint8Array): Promise<void> {
  const runtime = detectRuntime();
  if (runtime.browser || runtime.kind === 'workerd') {
    throw new BakbakError(
      'save() needs a file system (Node, Bun or Deno). In a browser, use audio.data or audio.toWav() with a Blob instead.',
    );
  }
  let fs: { writeFile(path: string, data: Uint8Array): Promise<void> };
  try {
    fs = await importOptional('node:fs/promises');
  } catch (cause) {
    throw new BakbakError('save() needs node:fs/promises, which this runtime does not provide.', { cause });
  }
  await fs.writeFile(path, data);
}

/** A whole synthesized file: the bytes exactly as received, plus their metadata. */
export class Audio {
  /** The audio bytes exactly as the API sent them. */
  readonly data: Uint8Array;
  /** `X-Request-Id`: quote it to support. */
  readonly requestId: string | undefined;
  /** `Content-Type` of the audio. */
  readonly contentType: string | undefined;
  /**
   * The raw encoding (`pcm_s16le`, `pcm_f32le`, `pcm_mulaw`, `pcm_alaw`) or `mp3`, when known:
   * `X-Audio-Format`, or for a WAV file without that header (no `output_format`), the file's
   * own `fmt ` chunk.
   */
  readonly encoding: string | undefined;
  /** Samples per second, when known, from the same place as `encoding`. Unset for mp3. */
  readonly sampleRate: number | undefined;

  constructor(data: Uint8Array, metadata: AudioMetadata = {}) {
    this.data = data;
    this.requestId = metadata.requestId;
    this.contentType = metadata.contentType;
    this.encoding = metadata.encoding;
    this.sampleRate = metadata.sampleRate;
  }

  /** True if the bytes already are a WAV file. */
  get isWav(): boolean {
    return isWavData(this.data);
  }

  /**
   * The audio as a WAV file: the bytes unchanged if they already are one, else raw audio
   * wrapped in a WAV header. Throws for mp3, which has to be decoded instead, and for raw
   * audio whose encoding or sample rate is unknown.
   */
  toWav(): Uint8Array {
    if (this.isWav) return this.data;
    if (this.encoding === 'mp3' || mediaType(this.contentType) === 'audio/mpeg') {
      throw new BakbakError(MP3_TO_WAV);
    }
    if (this.encoding === undefined || this.sampleRate === undefined) {
      throw new BakbakError(
        "The response did not state this audio's encoding and sample rate, so it cannot be wrapped in WAV; if you know them, call toWav(audio.data, { encoding, sampleRate }).",
      );
    }
    return toWav(this.data, { encoding: this.encoding, sampleRate: this.sampleRate });
  }

  /** Writes exactly the received bytes to `path`. Node, Bun and Deno only. */
  save(path: string): Promise<void> {
    return writeFileBytes(path, this.data);
  }
}
