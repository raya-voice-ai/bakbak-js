// biome-ignore lint/suspicious/noExplicitAny: feature detection of runtime-specific APIs.
const g = globalThis as any;

interface NodeBufferLike extends Uint8Array {
  write(text: string, offset: number, encoding: 'base64'): number;
}
interface NodeBufferCtor {
  allocUnsafeSlow(size: number): NodeBufferLike;
}

const NodeBuffer: NodeBufferCtor | undefined =
  typeof g.Buffer?.allocUnsafeSlow === 'function' ? (g.Buffer as NodeBufferCtor) : undefined;
const fromBase64: ((text: string) => Uint8Array) | undefined =
  typeof g.Uint8Array?.fromBase64 === 'function'
    ? (text: string) => g.Uint8Array.fromBase64(text)
    : undefined;

/** Exact decoded size of padded or unpadded standard base64 without whitespace. */
function decodedLength(b64: string): number {
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** A chunk's `data` that is not valid base64 (BEHAVIOR.md §6.4: it fails its request). */
export class InvalidBase64Error extends Error {
  constructor() {
    super("A chunk's audio data was not valid base64.");
    this.name = 'InvalidBase64Error';
  }
}

/**
 * Decodes base64 once into a fresh `Uint8Array` that starts at offset 0 of its own
 * `ArrayBuffer` (safe to wrap in `Int16Array`/`Float32Array`), optionally after `prefix`.
 */
export function decodeBase64(b64: string, prefix?: Uint8Array): Uint8Array {
  const pre = prefix?.length ?? 0;
  if (b64.length % 4 === 1) throw new InvalidBase64Error();
  if (NodeBuffer) {
    const expected = decodedLength(b64);
    const buf = NodeBuffer.allocUnsafeSlow(pre + expected);
    if (prefix && pre) buf.set(prefix, 0);
    // Node skips characters that are not base64, so a short write means invalid input.
    const written = buf.write(b64, pre, 'base64');
    if (written !== expected) throw new InvalidBase64Error();
    return new Uint8Array(buf.buffer, 0, pre + written);
  }
  if (fromBase64) {
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(b64);
    } catch {
      throw new InvalidBase64Error();
    }
    if (!pre) return bytes;
    const out = new Uint8Array(pre + bytes.length);
    out.set(prefix as Uint8Array, 0);
    out.set(bytes, pre);
    return out;
  }
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new InvalidBase64Error();
  }
  const out = new Uint8Array(pre + binary.length);
  if (prefix && pre) out.set(prefix, 0);
  for (let i = 0; i < binary.length; i++) out[pre + i] = binary.charCodeAt(i);
  return out;
}

const SAMPLE_BYTES: Record<string, number> = {
  pcm_f32le: 4,
  pcm_s16le: 2,
  pcm_mulaw: 1,
  pcm_alaw: 1,
};

/** Bytes per sample of a raw encoding; 1 (no alignment) for unknown or compressed ones. */
export function sampleBytes(encoding: string | undefined): number {
  return (encoding && SAMPLE_BYTES[encoding]) || 1;
}

/**
 * Decodes stream chunks and keeps whole samples together: if a chunk ends mid-sample, the
 * remainder is carried into the next chunk (BEHAVIOR.md §5.2).
 */
export class SampleAligner {
  #size: number;
  #carry: Uint8Array | undefined;

  constructor(sampleSize: number) {
    this.#size = sampleSize;
  }

  /** Decodes one base64 chunk; returns the whole samples available, or undefined if none. */
  push(b64: string): Uint8Array | undefined {
    const bytes = decodeBase64(b64, this.#carry);
    this.#carry = undefined;
    const rest = bytes.length % this.#size;
    if (rest === 0) return bytes.length ? bytes : undefined;
    const whole = bytes.length - rest;
    this.#carry = bytes.slice(whole);
    return whole ? bytes.slice(0, whole) : undefined;
  }

  /** Returns any carried partial sample at the end of a stream, so no byte is lost. */
  flush(): Uint8Array | undefined {
    const carry = this.#carry;
    this.#carry = undefined;
    return carry;
  }
}
