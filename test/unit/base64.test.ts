import { describe, expect, it } from 'vitest';
import { decodeBase64, SampleAligner } from '../../src/core/base64';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

describe('base64 decoding', () => {
  it('decodes into a fresh, aligned buffer of exactly the right size', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Array.from({ length: n }, (_, i) => (i * 37) & 255);
      const out = decodeBase64(b64(bytes));
      expect([...out]).toEqual(bytes);
      expect(out.byteOffset).toBe(0);
      expect(out.buffer.byteLength).toBe(n);
    }
  });

  it('can be viewed as Float32Array without copying', () => {
    const floats = new Float32Array([0.5, -0.25, 1]);
    const out = decodeBase64(Buffer.from(floats.buffer).toString('base64'));
    expect([...new Float32Array(out.buffer, out.byteOffset, out.length / 4)]).toEqual([0.5, -0.25, 1]);
  });

  it('prepends a prefix', () => {
    expect([...decodeBase64(b64([3, 4]), new Uint8Array([1, 2]))]).toEqual([1, 2, 3, 4]);
  });
});

describe('SampleAligner', () => {
  it('never hands out a partial sample', () => {
    const aligner = new SampleAligner(4);
    expect(aligner.push(b64([1, 2, 3, 4, 5, 6]))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(aligner.push(b64([7]))).toBeUndefined();
    expect(aligner.push(b64([8, 9, 10]))).toEqual(new Uint8Array([5, 6, 7, 8]));
    expect(aligner.flush()).toEqual(new Uint8Array([9, 10]));
    expect(aligner.flush()).toBeUndefined();
  });

  it('passes whole-sample chunks through without copying', () => {
    const aligner = new SampleAligner(2);
    const out = aligner.push(b64([1, 2, 3, 4])) as Uint8Array;
    expect(out.buffer.byteLength).toBe(4);
  });

  it('every chunk it hands out owns an exact buffer', () => {
    const aligner = new SampleAligner(2);
    const a = aligner.push(b64([1, 2, 3])) as Uint8Array;
    expect(a.byteOffset).toBe(0);
    expect(a.buffer.byteLength).toBe(2);
  });
});

describe('invalid base64', () => {
  it('is refused, not silently shortened', async () => {
    const { InvalidBase64Error } = await import('../../src/core/base64');
    for (const bad of ['A*A=', 'AAAAA', 'AA A', '!!!!', 'AAAA====']) {
      expect(() => decodeBase64(bad), bad).toThrow(InvalidBase64Error);
    }
    expect([...decodeBase64('AQID')]).toEqual([1, 2, 3]);
    expect([...decodeBase64('AQI')]).toEqual([1, 2]); // unpadded is fine
  });
});
