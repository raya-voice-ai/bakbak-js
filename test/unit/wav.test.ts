import { describe, expect, it } from 'vitest';
import { wavFormat } from '../../src/audio';
import { Audio, BakbakError, toWav } from '../../src/index';

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
const text = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

describe('toWav (BEHAVIOR.md §5.2)', () => {
  it('writes the canonical 44-byte header for pcm_s16le', () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);
    const wav = toWav(pcm, { encoding: 'pcm_s16le', sampleRate: 8000 });
    const v = view(wav);
    expect(wav.length).toBe(44 + 6);
    expect(text(wav, 0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(text(wav, 8)).toBe('WAVE');
    expect(text(wav, 12)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(28, true)).toBe(16000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(wav, 36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([...pcm]);
  });

  const extended: Array<[string, number, number]> = [
    ['pcm_f32le', 3, 32],
    ['pcm_alaw', 6, 8],
    ['pcm_mulaw', 7, 8],
  ];
  for (const [encoding, tag, bits] of extended) {
    it(`writes an 18-byte fmt chunk and a fact chunk (58 bytes) for ${encoding}`, () => {
      const pcm = new Uint8Array(24).fill(7);
      const wav = toWav(pcm, { encoding, sampleRate: 24000 });
      const v = view(wav);
      const block = bits / 8;
      expect(wav.length).toBe(58 + 24);
      expect(v.getUint32(4, true)).toBe(50 + 24);
      expect(v.getUint32(16, true)).toBe(18);
      expect(v.getUint16(20, true)).toBe(tag);
      expect(v.getUint16(22, true)).toBe(1);
      expect(v.getUint32(24, true)).toBe(24000);
      expect(v.getUint32(28, true)).toBe(24000 * block);
      expect(v.getUint16(32, true)).toBe(block);
      expect(v.getUint16(34, true)).toBe(bits);
      expect(v.getUint16(36, true)).toBe(0); // cbSize
      expect(text(wav, 38)).toBe('fact');
      expect(v.getUint32(42, true)).toBe(4);
      expect(v.getUint32(46, true)).toBe(24 / block); // samples
      expect(text(wav, 50)).toBe('data');
      expect(v.getUint32(54, true)).toBe(24);
      expect([...wav.subarray(58)]).toEqual([...pcm]);
    });
  }

  it('refuses unknown encodings and bad sample rates', () => {
    expect(() => toWav(new Uint8Array(2), { encoding: 'opus', sampleRate: 8000 })).toThrow(BakbakError);
    expect(() => toWav(new Uint8Array(2), { encoding: 'pcm_s16le', sampleRate: 0 })).toThrow(BakbakError);
  });

  it('says that mp3 has to be decoded, not wrapped', () => {
    expect(() => toWav(new Uint8Array(2), { encoding: 'mp3', sampleRate: 24000 })).toThrow(
      /MP3 audio cannot be wrapped in WAV; decode it with an audio library/,
    );
  });
});

/** Bytes of a little-endian WAV built field by field, for headers toWav never writes. */
function bytes(...parts: Array<string | [number, 2 | 4] | Uint8Array>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const c of part) out.push(c.charCodeAt(0));
    else if (part instanceof Uint8Array) out.push(...part);
    else for (let i = 0; i < part[1]; i++) out.push((part[0] >>> (8 * i)) & 0xff);
  }
  return new Uint8Array(out);
}

/** A 16-byte `fmt ` body: tag, channels, rate, byte rate, block align, bits. */
function fmtBody(tag: number, channels: number, rate: number, bits: number): Uint8Array {
  const block = (channels * bits) / 8;
  return bytes([tag, 2], [channels, 2], [rate, 4], [rate * block, 4], [block, 2], [bits, 2]);
}

/** The KSDATAFORMAT_SUBTYPE GUID for a format tag: the tag, then a fixed tail. */
function subFormat(tag: number): Uint8Array {
  return bytes([tag, 2], [0, 2], [0, 2], [0x10, 2], new Uint8Array([0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]));
}

describe('wavFormat: encoding and sample rate from the fmt chunk (BEHAVIOR.md §5.2)', () => {
  const formats: Array<[string, number]> = [
    ['pcm_s16le', 24000],
    ['pcm_s16le', 8000],
    ['pcm_f32le', 22050],
    ['pcm_alaw', 8000],
    ['pcm_mulaw', 16000],
  ];
  for (const [encoding, sampleRate] of formats) {
    it(`reads ${encoding} at ${sampleRate} Hz from the header toWav writes`, () => {
      expect(wavFormat(toWav(new Uint8Array(16), { encoding, sampleRate }))).toEqual({
        encoding,
        sampleRate,
      });
    });
  }

  it('does not trust the RIFF and data sizes (a streamed WAV gives 0xFFFFFFFF)', () => {
    const wav = bytes(
      'RIFF',
      [0xffffffff, 4],
      'WAVE',
      'fmt ',
      [16, 4],
      fmtBody(1, 1, 24000, 16),
      'data',
      [0xffffffff, 4],
      new Uint8Array(10),
    );
    expect(wavFormat(wav)).toEqual({ encoding: 'pcm_s16le', sampleRate: 24000 });
    // Cut anywhere after the fmt chunk, it still says what it holds.
    expect(wavFormat(wav.subarray(0, 36))).toEqual({ encoding: 'pcm_s16le', sampleRate: 24000 });
  });

  it('skips other chunks before fmt, with their padding byte', () => {
    const wav = bytes(
      'RIFF',
      [0, 4],
      'WAVE',
      'LIST',
      [3, 4],
      'abc',
      '\0',
      'fmt ',
      [16, 4],
      fmtBody(7, 1, 8000, 8),
    );
    expect(wavFormat(wav)).toEqual({ encoding: 'pcm_mulaw', sampleRate: 8000 });
  });

  it('accepts RF64', () => {
    const wav = bytes('RF64', [0xffffffff, 4], 'WAVE', 'fmt ', [16, 4], fmtBody(3, 1, 24000, 32));
    expect(wavFormat(wav)).toEqual({ encoding: 'pcm_f32le', sampleRate: 24000 });
  });

  it('takes the format of WAVE_FORMAT_EXTENSIBLE from the first two bytes of its sub-format', () => {
    const extensible = (tag: number, bits: number) =>
      bytes(
        'RIFF',
        [0xffffffff, 4],
        'WAVE',
        'fmt ',
        [40, 4],
        fmtBody(0xfffe, 1, 16000, bits),
        [22, 2], // cbSize
        [bits, 2], // valid bits
        [4, 4], // channel mask: front centre
        subFormat(tag),
        'data',
        [0xffffffff, 4],
      );
    expect(wavFormat(extensible(1, 16))).toEqual({ encoding: 'pcm_s16le', sampleRate: 16000 });
    expect(wavFormat(extensible(3, 32))).toEqual({ encoding: 'pcm_f32le', sampleRate: 16000 });
    expect(wavFormat(extensible(7, 8))).toEqual({ encoding: 'pcm_mulaw', sampleRate: 16000 });
    expect(wavFormat(extensible(1, 24))).toBeUndefined();
    // Too short to hold the sub-format.
    expect(wavFormat(extensible(1, 16).subarray(0, 12 + 8 + 25))).toBeUndefined();
    expect(
      wavFormat(bytes('RIFF', [0, 4], 'WAVE', 'fmt ', [18, 4], fmtBody(0xfffe, 1, 16000, 16), [0, 2])),
    ).toBe(undefined);
  });

  it('leaves both unset for formats the API does not produce', () => {
    const wav = (body: Uint8Array) => bytes('RIFF', [0, 4], 'WAVE', 'fmt ', [16, 4], body);
    expect(wavFormat(wav(fmtBody(1, 2, 24000, 16)))).toBeUndefined(); // stereo
    expect(wavFormat(wav(fmtBody(1, 1, 24000, 24)))).toBeUndefined(); // 24-bit
    expect(wavFormat(wav(fmtBody(3, 1, 24000, 64)))).toBeUndefined(); // 64-bit float
    expect(wavFormat(wav(fmtBody(2, 1, 24000, 4)))).toBeUndefined(); // ADPCM
    expect(wavFormat(wav(fmtBody(1, 1, 0, 16)))).toBeUndefined(); // no rate
  });

  it('never throws on a malformed or short body, and leaves both unset', () => {
    const good = toWav(new Uint8Array(4), { encoding: 'pcm_s16le', sampleRate: 24000 });
    const bad = [
      new Uint8Array(0),
      bytes('RIFF'),
      bytes('RIFF', [0, 4], 'WAV'),
      bytes('RIFF', [0, 4], 'WAVE'),
      bytes('RIFX', [0, 4], 'WAVE', 'fmt ', [16, 4], fmtBody(1, 1, 24000, 16)), // big-endian
      bytes('RIFF', [0, 4], 'AVI ', 'fmt ', [16, 4], fmtBody(1, 1, 24000, 16)),
      bytes('RIFF', [0, 4], 'WAVE', 'fmt ', [14, 4], fmtBody(1, 1, 24000, 16)), // fmt too small
      bytes('RIFF', [0, 4], 'WAVE', 'data', [0xffffffff, 4], 'fmt ', [16, 4], fmtBody(1, 1, 24000, 16)),
      bytes('RIFF', [0, 4], 'WAVE', 'LIST', [0xffffffff, 4], 'fmt ', [16, 4], fmtBody(1, 1, 24000, 16)),
      bytes('ID3', new Uint8Array(40)),
      new Uint8Array(64).fill(0xff),
    ];
    for (let n = 0; n < 36; n++) bad.push(good.subarray(0, n)); // the fmt chunk cut short
    for (const body of bad) expect(wavFormat(body), String([...body])).toBeUndefined();

    // Random bytes behind a valid RIFF/WAVE start, and random bytes alone.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed & 0xff;
    };
    for (let i = 0; i < 2000; i++) {
      const tail = Uint8Array.from({ length: i % 80 }, random);
      expect(() => wavFormat(bytes('RIFF', [0, 4], 'WAVE', tail))).not.toThrow();
      expect(() => wavFormat(tail)).not.toThrow();
    }
  });

  it('reads a view into a larger buffer at its own offset', () => {
    const wav = toWav(new Uint8Array(4), { encoding: 'pcm_alaw', sampleRate: 8000 });
    const padded = new Uint8Array(wav.length + 3);
    padded.set(wav, 3);
    expect(wavFormat(padded.subarray(3))).toEqual({ encoding: 'pcm_alaw', sampleRate: 8000 });
  });
});

describe('Audio', () => {
  it('returns WAV bytes unchanged', () => {
    const wav = toWav(new Uint8Array(4), { encoding: 'pcm_s16le', sampleRate: 8000 });
    const audio = new Audio(wav, { contentType: 'audio/wav' });
    expect(audio.isWav).toBe(true);
    expect(audio.toWav()).toBe(wav);
  });

  it('wraps raw audio using its metadata', () => {
    const audio = new Audio(new Uint8Array(8), { encoding: 'pcm_mulaw', sampleRate: 8000, requestId: 'r' });
    expect(audio.toWav().length).toBe(58 + 8);
    expect(audio.requestId).toBe('r');
  });

  it('explains what is missing for raw audio of unknown format', () => {
    expect(() => new Audio(new Uint8Array(8)).toWav()).toThrow(/toWav\(audio.data/);
    expect(() => new Audio(new Uint8Array(8), { encoding: 'pcm_s16le' }).toWav()).toThrow(
      /did not state this audio's encoding and sample rate/,
    );
  });

  it('says that mp3 has to be decoded, not wrapped, whatever the metadata says', () => {
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]);
    const message = /MP3 audio cannot be wrapped in WAV; decode it with an audio library/;
    expect(() => new Audio(mp3, { encoding: 'mp3' }).toWav()).toThrow(message);
    expect(() => new Audio(mp3, { encoding: 'mp3', sampleRate: 24000 }).toWav()).toThrow(message);
    expect(() => new Audio(mp3, { contentType: 'audio/mpeg' }).toWav()).toThrow(message);
    expect(() => new Audio(mp3, { contentType: 'Audio/MPEG; charset=binary' }).toWav()).toThrow(message);
    expect(() => new Audio(mp3, { contentType: 'audio/mpeg' }).toWav()).toThrow(BakbakError);
  });

  it('returns a WAV body unchanged even when it is labelled mp3', () => {
    const wav = toWav(new Uint8Array(4), { encoding: 'pcm_s16le', sampleRate: 24000 });
    expect(new Audio(wav, { encoding: 'mp3', contentType: 'audio/mpeg' }).toWav()).toBe(wav);
  });

  it('needs RIFF and WAVE to call the bytes WAV', () => {
    expect(new Audio(bytes('RIFF', [0, 4], 'WAVE')).isWav).toBe(true);
    expect(new Audio(bytes('RF64', [0, 4], 'WAVE')).isWav).toBe(true);
    expect(new Audio(bytes('RIFF', [0, 4], 'AVI ')).isWav).toBe(false);
    expect(new Audio(bytes('RIFF', [0, 4])).isWav).toBe(false);
  });
});
