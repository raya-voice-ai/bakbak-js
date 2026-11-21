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

function ascii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Wraps raw mono audio in a WAV header (BEHAVIOR.md §5.2): the canonical 44-byte PCM header
 * for `pcm_s16le`; for `pcm_f32le`, `pcm_alaw` and `pcm_mulaw` an 18-byte `fmt ` chunk plus
 * a `fact` chunk, 58 bytes in all.
 */
export function toWav(pcm: Uint8Array, options: WavOptions): Uint8Array {
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

/** Response metadata of a synthesis, from its headers. */
export interface AudioMetadata {
  /** `X-Request-Id`: quote it to support. */
  requestId?: string | undefined;
  /** `Content-Type` of the audio, e.g. `audio/wav`, `audio/basic`, `audio/pcm`. */
  contentType?: string | undefined;
  /** `X-Audio-Format`: the raw encoding (e.g. `pcm_s16le`) or `mp3`. Present with `output_format`. */
  encoding?: string | undefined;
  /** `X-Audio-Sample-Rate`. Present with `output_format`, except for mp3. */
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
  /** The raw encoding (`pcm_s16le`, `pcm_f32le`, `pcm_mulaw`, `pcm_alaw`) or `mp3`, when known. */
  readonly encoding: string | undefined;
  /** Samples per second, when known. */
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
    const d = this.data;
    return d.length >= 12 && d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46;
  }

  /**
   * The audio as a WAV file: the bytes unchanged if they already are one, else raw audio
   * wrapped in a WAV header. Throws for mp3 and for raw audio of unknown format.
   */
  toWav(): Uint8Array {
    if (this.isWav) return this.data;
    if (this.encoding === undefined || this.sampleRate === undefined) {
      throw new BakbakError(
        'The encoding or sample rate of this audio is unknown; call toWav(audio.data, { encoding, sampleRate }) instead.',
      );
    }
    return toWav(this.data, { encoding: this.encoding, sampleRate: this.sampleRate });
  }

  /** Writes exactly the received bytes to `path`. Node, Bun and Deno only. */
  save(path: string): Promise<void> {
    return writeFileBytes(path, this.data);
  }
}
