import { describe, expect, it } from 'vitest';
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
    expect(() => toWav(new Uint8Array(2), { encoding: 'mp3', sampleRate: 8000 })).toThrow(BakbakError);
    expect(() => toWav(new Uint8Array(2), { encoding: 'pcm_s16le', sampleRate: 0 })).toThrow(BakbakError);
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

  it('explains what is missing for raw audio of unknown format, and refuses mp3', () => {
    expect(() => new Audio(new Uint8Array(8)).toWav()).toThrow(/toWav\(audio.data/);
    expect(() => new Audio(new Uint8Array(8), { encoding: 'mp3', sampleRate: 24000 }).toWav()).toThrow(
      BakbakError,
    );
  });
});
