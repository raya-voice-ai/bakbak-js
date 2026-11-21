import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BakbakError, Segmenter, type SegmenterOptions, splitSentences } from '../../src/index';
import { CONFORMANCE } from '../helpers';

interface Case {
  name: string;
  options: Record<string, number | boolean>;
  input: string;
  sentences: string[];
}

const doc = JSON.parse(readFileSync(new URL('segmenter/cases.json', CONFORMANCE), 'utf8')) as {
  defaults: Record<string, number | boolean>;
  cases: Case[];
};

const NAMES: Record<string, keyof SegmenterOptions> = {
  min_chars: 'minChars',
  first_min_chars: 'firstMinChars',
  max_chars: 'maxChars',
  eager_first_clause: 'eagerFirstClause',
  first_clause_min_chars: 'firstClauseMinChars',
};

function toOptions(options: Record<string, number | boolean>): SegmenterOptions {
  const out: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(options)) {
    const name = NAMES[key];
    if (!name) throw new Error(`unknown segmenter option ${key}`);
    out[name] = value;
  }
  return out as SegmenterOptions;
}

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pushAll(pieces: string[], options: SegmenterOptions): string[] {
  const segmenter = new Segmenter(options);
  const out: string[] = [];
  for (const piece of pieces) out.push(...segmenter.push(piece));
  out.push(...segmenter.flush());
  return out;
}

/** One piece; one code point per piece; fixed sizes; random cuts — all by code point. */
function chunkings(text: string, random: () => number): string[][] {
  const cps = Array.from(text);
  const out: string[][] = [[text], cps];
  for (const size of [2, 3, 7]) {
    const pieces: string[] = [];
    for (let i = 0; i < cps.length; i += size) pieces.push(cps.slice(i, i + size).join(''));
    out.push(pieces);
  }
  for (let round = 0; round < 20; round++) {
    const cuts = new Set<number>();
    const k = Math.floor(random() * 12) + 1;
    for (let i = 0; i < k && cps.length > 1; i++) cuts.add(1 + Math.floor(random() * (cps.length - 1)));
    const sorted = [...cuts].sort((a, b) => a - b);
    const pieces: string[] = [];
    let prev = 0;
    for (const c of [...sorted, cps.length]) {
      pieces.push(cps.slice(prev, c).join(''));
      prev = c;
    }
    out.push(pieces);
  }
  return out;
}

describe('segmenter: conformance vectors', () => {
  it('uses the documented defaults', () => {
    expect(doc.defaults).toEqual({
      min_chars: 20,
      first_min_chars: 1,
      max_chars: 400,
      eager_first_clause: false,
      first_clause_min_chars: 24,
    });
  });

  for (const c of doc.cases) {
    it(`${c.name}`, () => {
      expect(splitSentences(c.input, toOptions(c.options))).toEqual(c.sentences);
    });
  }
});

describe('segmenter: streaming invariant', () => {
  const random = rng(20261121);
  for (const c of doc.cases) {
    it(`${c.name}: any chunking gives the batch result`, () => {
      const options = toOptions(c.options);
      for (const pieces of chunkings(c.input, random)) {
        expect(pushAll(pieces, options), JSON.stringify(pieces)).toEqual(c.sentences);
      }
    });
  }

  it('emits each sentence as soon as it is decided', () => {
    const s = new Segmenter();
    expect(s.push('Hello there.')).toEqual([]);
    expect(s.push(' ')).toEqual([]); // undecided until something follows the space
    expect(s.push('H')).toEqual(['Hello there.']);
    expect(s.flush()).toEqual(['H']);
  });

  it('can be reused after flush', () => {
    const s = new Segmenter();
    expect([...s.push('पहला वाक्य। '), ...s.flush()]).toEqual(['पहला वाक्य।']);
    expect([...s.push('दूसरा वाक्य। '), ...s.flush()]).toEqual(['दूसरा वाक्य।']);
  });
});

describe('segmenter: code points', () => {
  it('measures length in code points, not UTF-16 units', () => {
    // 30 astral letters are 60 UTF-16 units; with maxChars 40 they must not be wrapped.
    const word = '𝐀'.repeat(30);
    expect(splitSentences(word, { maxChars: 40 })).toEqual([word]);
    // ...and with maxChars 10 they are cut into whole code points.
    const pieces = splitSentences(word, { maxChars: 10 });
    expect(pieces).toEqual(['𝐀'.repeat(10), '𝐀'.repeat(10), '𝐀'.repeat(10)]);
  });

  it('applies minChars in code points', () => {
    const emoji = '🙂';
    const first = `${'a'.repeat(18)}${emoji}.`; // 20 code points, 21 UTF-16 units
    expect(splitSentences(`Hi. ${first} Next one here is long enough.`, { minChars: 21 })).toEqual([
      'Hi.',
      `${first} Next one here is long enough.`,
    ]);
  });

  it('rejects maxChars above the API limit', () => {
    expect(() => new Segmenter({ maxChars: 5001 })).toThrow(BakbakError);
    expect(() => new Segmenter({ maxChars: 5000 })).not.toThrow();
  });
});

describe('segmenter: UTF-16 streams', () => {
  it('carries a high surrogate across pushes', () => {
    const text = 'नमस्ते 😀। 𝐀𝐁 दूसरा 🙏🏽 वाक्य है। आख़िरी 𠀀';
    const expected = splitSentences(text);
    const s = new Segmenter();
    const out: string[] = [];
    for (let i = 0; i < text.length; i++) out.push(...s.push(text[i] as string)); // one UTF-16 unit
    out.push(...s.flush());
    expect(out).toEqual(expected);
    expect(out.join('')).not.toMatch(/\uFFFD/);
  });
});

describe('segmenter: linear time (BEHAVIOR.md §7)', () => {
  const inputs: Array<[string, string]> = [
    ['punctuated', 'यह एक छोटा सा वाक्य है जो परीक्षण के लिए है। '.repeat(4400)],
    ['no punctuation', 'शब्द '.repeat(40_000)],
    ['no punctuation or spaces', 'क'.repeat(200_000)],
    ['long runs of spaces and tabs', `क${' \t'.repeat(1_000)}`.repeat(100)],
  ];
  for (const [name, text] of inputs) {
    it(`splits 200k characters (${name}) in well under a second, whole or streamed`, () => {
      let started = performance.now();
      const whole = splitSentences(text);
      const batch = performance.now() - started;
      started = performance.now();
      const s = new Segmenter();
      const streamed: string[] = [];
      for (let i = 0; i < text.length; i += 4) streamed.push(...s.push(text.slice(i, i + 4)));
      streamed.push(...s.flush());
      const stream = performance.now() - started;
      expect(streamed).toEqual(whole);
      expect(batch).toBeLessThan(1_000);
      expect(stream).toBeLessThan(1_000);
    });
  }
});

describe('segmenter: fuzz against the reference', () => {
  const generator = fileURLToPath(new URL('../../scripts/segmenter-fuzz.py', import.meta.url));
  const run = spawnSync('python3', ['-B', generator, '20261121', '1500'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  const available = run.status === 0;
  it.skipIf(!available)('matches reference.py on random text, however it is pushed', () => {
    const cases = JSON.parse(run.stdout) as Array<{
      text: string;
      options: Case['options'];
      sentences: string[];
    }>;
    const random = rng(7);
    for (const c of cases) {
      const options = toOptions(c.options);
      expect(splitSentences(c.text, options), JSON.stringify(c)).toEqual(c.sentences);
      const units = Array.from({ length: c.text.length }, (_, i) => c.text[i] as string);
      expect(pushAll(units, options), `UTF-16 units: ${JSON.stringify(c)}`).toEqual(c.sentences);
      for (const pieces of chunkings(c.text, random).slice(0, 4)) {
        expect(pushAll(pieces, options), JSON.stringify(pieces)).toEqual(c.sentences);
      }
    }
  });
});
