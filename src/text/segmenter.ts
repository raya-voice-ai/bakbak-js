/**
 * The Bakbak sentence segmenter, version 1: a port of `conformance/segmenter/reference.py`,
 * which is the specification. It splits text into the sentence-sized requests the models
 * voice best, as early as possible when text arrives a token at a time, without ever
 * splitting where a sentence does not end. All lengths are in Unicode code points.
 */

import { BakbakError } from '../core/errors';

/** Options of {@link Segmenter} and {@link splitSentences}. */
export interface SegmenterOptions {
  /** Shorter sentences (after the first) merge with the next one. Default 20. */
  minChars?: number | undefined;
  /** The minimum for the first sentence; 1 sends it as soon as it ends. Default 1. */
  firstMinChars?: number | undefined;
  /** Longer groups are wrapped into pieces of at most this many code points. Default 400, at most 5000. */
  maxChars?: number | undefined;
  /** Until the first sentence is sent, also split at a clause (`,`, `;`, …). Default false. */
  eagerFirstClause?: boolean | undefined;
  /** The shortest first clause `eagerFirstClause` sends on its own. Default 24. */
  firstClauseMinChars?: number | undefined;
}

const cps = (...codepoints: number[]) => new Set(codepoints.map((c) => String.fromCodePoint(c)));

const WHITESPACE = cps(
  0x20,
  0x09,
  0x0a,
  0x0d,
  0x0c,
  0x0b,
  0x85,
  0xa0,
  0x1680,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
);
// . ! ? … । ॥ 。 ！ ？
const TERMINATORS = cps(0x2e, 0x21, 0x3f, 0x2026, 0x0964, 0x0965, 0x3002, 0xff01, 0xff1f);
// " ' ) ] } ’ ” » › 》 」 』
const CLOSERS = cps(0x22, 0x27, 0x29, 0x5d, 0x7d, 0x2019, 0x201d, 0xbb, 0x203a, 0x300b, 0x300d, 0x300f);
// , ; : — – ،
const SOFT_DELIMITERS = cps(0x2c, 0x3b, 0x3a, 0x2014, 0x2013, 0x060c);
const JOINERS = cps(0x200c, 0x200d);
const VIRAMAS = cps(0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d4d, 0x0dca);

const fromCps = (...codepoints: number[]) => String.fromCodePoint(...codepoints);
const TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'rs',
  'smt',
  'shri',
  'sh',
  'lt',
  'col',
  'gen',
  'capt',
  'sgt',
  'hon',
  'rev',
  'mt',
  fromCps(0x0921, 0x0949), // डॉ
  fromCps(0x092a, 0x094d, 0x0930, 0x094b), // प्रो
  fromCps(0x0915, 0x0941), // कु
  fromCps(0x0938, 0x094d, 0x0935), // स्व
  fromCps(0x092e, 0x093f), // मि
  fromCps(0x0930, 0x0941), // रु
]);
const AMBIGUOUS = new Set([
  'etc',
  'inc',
  'ltd',
  'co',
  'corp',
  'approx',
  'dept',
  'govt',
  'est',
  'fig',
  'no',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

const SPEAKABLE = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;

/** The API's limit on `text`, in characters. */
const API_MAX_CHARS = 5000;

// The text is held as an array of code points, so every index and length is in code points.
type CodePoints = string[];

function isWordChar(ch: string): boolean {
  if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) return true;
  const cp = ch.codePointAt(0) as number;
  return cp >= 0x0900 && cp <= 0x0dff && cp !== 0x0964 && cp !== 0x0965;
}

function speakable(t: CodePoints, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (SPEAKABLE.test(t[i] as string)) return true;
  return false;
}

/** [start, end) of t[from:to] without leading and trailing whitespace. */
function strip(t: CodePoints, from: number, to: number): [number, number] {
  let a = from;
  let b = to;
  while (a < b && WHITESPACE.has(t[a] as string)) a++;
  while (b > a && WHITESPACE.has(t[b - 1] as string)) b--;
  return [a, b];
}

function strippedLength(t: CodePoints, from: number, to: number): number {
  const [a, b] = strip(t, from, to);
  return b - a;
}

function skipWs(t: CodePoints, i: number): number {
  while (i < t.length && WHITESPACE.has(t[i] as string)) i++;
  return i;
}

function atLineStart(t: CodePoints, start: number): boolean {
  let i = start;
  while (i > 0 && (t[i - 1] === ' ' || t[i - 1] === '\t')) i--;
  return i === 0 || t[i - 1] === '\n';
}

interface Candidate {
  /** Where the sentence ends (exclusive); the next one starts after whitespace. */
  end: number;
  decided: boolean;
  /** Meaningful only when decided. */
  boundary: boolean;
}

/** The single "." exceptions: initials, titles, list markers and ambiguous abbreviations. */
function dotIsBoundary(t: CodePoints, dot: number, nextChar: string): boolean {
  let start = dot;
  while (start > 0 && isWordChar(t[start - 1] as string)) start--;
  const length = dot - start;
  const word = t.slice(start, dot).join('');
  const lower = word.toLowerCase();
  if (length === 1 && /^[A-Za-z]$/.test(word)) return false;
  if (TITLES.has(lower)) return false;
  if (length >= 1 && length <= 3 && /^[0-9]+$/.test(word) && atLineStart(t, start)) return false;
  if (AMBIGUOUS.has(lower) && !(nextChar >= 'A' && nextChar <= 'Z')) return false;
  return true;
}

/**
 * Boundary candidates in t[start:], in order. `clause`, when given, is [groupStart,
 * firstClauseMinChars]: soft delimiters followed by whitespace also count, if the stripped
 * text from groupStart through the delimiter is long enough.
 */
function candidates(
  t: CodePoints,
  start: number,
  final: boolean,
  clause: [number, number] | undefined,
): Candidate[] {
  const out: Candidate[] = [];
  const n = t.length;
  let i = start;
  while (i < n) {
    const ch = t[i] as string;
    if (ch === '\n') {
      let j = i;
      while (j < n && WHITESPACE.has(t[j] as string)) j++;
      out.push({ end: i, decided: final || j < n, boundary: true });
      i = j;
      continue;
    }
    const isClause =
      clause !== undefined && SOFT_DELIMITERS.has(ch) && strippedLength(t, clause[0], i + 1) >= clause[1];
    if (!TERMINATORS.has(ch) && !isClause) {
      i++;
      continue;
    }
    const runStart = i;
    let j = i + 1;
    if (!isClause) while (j < n && TERMINATORS.has(t[j] as string)) j++;
    const runEnd = j;
    while (j < n && CLOSERS.has(t[j] as string)) j++;
    const end = j;
    if (j >= n) {
      // Nothing after the run yet: undecided unless final (the end of text is a boundary anyway).
      if (!final) out.push({ end, decided: false, boundary: false });
      break;
    }
    if (!WHITESPACE.has(t[j] as string)) {
      i = j; // e.g. "3.14", "a.com", "है।राहुल": not a candidate
      continue;
    }
    let k = j;
    while (k < n && WHITESPACE.has(t[k] as string)) k++;
    if (k >= n && !final) {
      out.push({ end, decided: false, boundary: false });
      break;
    }
    const nextChar = k < n ? (t[k] as string) : '';
    const boundary =
      isClause || runEnd - runStart !== 1 || t[runStart] !== '.' || dotIsBoundary(t, runStart, nextChar);
    out.push({ end, decided: true, boundary });
    i = k;
  }
  return out;
}

/** Where to cut the window t[start:start+maxChars]; returns an index > start. */
function wrapCut(t: CodePoints, start: number, maxChars: number): number {
  const windowEnd = start + maxChars;
  const half = start + Math.floor(maxChars / 2);
  for (let j = windowEnd; j > half; j--) if (SOFT_DELIMITERS.has(t[j - 1] as string)) return j;
  for (let j = windowEnd; j > start; j--) {
    // Cut before the whitespace; never produce an empty piece.
    if (WHITESPACE.has(t[j - 1] as string) && strippedLength(t, start, j - 1) > 0) return j - 1;
  }
  // Hard cut. Never before a combining mark or a joiner, or right after a virama or a joiner,
  // which would split an Indic conjunct or a cluster.
  let cut = windowEnd;
  const breaksCluster = (at: number) => {
    const here = t[at] ?? '';
    const before = t[at - 1] ?? '';
    return MARK.test(here) || JOINERS.has(here) || VIRAMAS.has(before) || JOINERS.has(before);
  };
  while (cut > start + 1 && breaksCluster(cut)) cut--;
  return cut > start + 1 ? cut : windowEnd;
}

/**
 * How much text before the group start a streaming segmenter must keep. Two decisions look
 * behind the group start: the word before a "." (which, after a hard cut, began before the
 * group) and whether a list marker starts a line. Keeping the word the group starts in, the
 * spaces or tabs before it and one more character answers both as the whole text would.
 */
function keepFrom(t: CodePoints, gs: number): number {
  let i = gs;
  while (i > 0 && isWordChar(t[i - 1] as string)) i--;
  while (i > 0 && (t[i - 1] === ' ' || t[i - 1] === '\t')) i--;
  return i > 0 ? i - 1 : 0;
}

function resolveOptions(options: SegmenterOptions = {}): Required<SegmenterOptions> {
  const o = {
    minChars: options.minChars ?? 20,
    firstMinChars: options.firstMinChars ?? 1,
    maxChars: options.maxChars ?? 400,
    eagerFirstClause: options.eagerFirstClause ?? false,
    firstClauseMinChars: options.firstClauseMinChars ?? 24,
  };
  if (!Number.isInteger(o.maxChars) || o.maxChars < 1 || o.maxChars > API_MAX_CHARS) {
    throw new BakbakError(`maxChars must be an integer from 1 to ${API_MAX_CHARS}, got ${o.maxChars}.`);
  }
  return o;
}

/**
 * Streaming sentence segmenter. `push()` returns the sentences that are now final and
 * `flush()` the rest. Pushing text in any pieces, then flushing, gives exactly the
 * sentences {@link splitSentences} gives for the whole text.
 */
export class Segmenter {
  #o: Required<SegmenterOptions>;
  #buf: CodePoints = [];
  /** Where the current group starts in #buf; what comes before it is look-behind only. */
  #gs = 0;
  #first = true;
  /** Inside a wrapped group: no merging until it ends. */
  #wrapping = false;

  constructor(options?: SegmenterOptions) {
    this.#o = resolveOptions(options);
  }

  /** Adds text; returns the sentences it completed. */
  push(text: string): string[] {
    for (const ch of text) this.#buf.push(ch);
    return this.#drain(false);
  }

  /** Ends the input; returns the remaining sentences and resets the segmenter for reuse. */
  flush(): string[] {
    const out = this.#drain(true);
    this.#buf = [];
    this.#gs = 0;
    this.#first = true;
    this.#wrapping = false;
    return out;
  }

  #emit(out: string[], t: CodePoints, from: number, to: number): void {
    // A piece with nothing to say (only punctuation or symbols) is dropped: the API refuses
    // text that has no sentence in it.
    if (to > from && speakable(t, from, to)) {
      out.push(t.slice(from, to).join(''));
      this.#first = false;
    }
  }

  #drain(final: boolean): string[] {
    const o = this.#o;
    const out: string[] = [];
    const t = this.#buf;
    let gs = skipWs(t, this.#gs); // group start
    for (;;) {
      const clause: [number, number] | undefined =
        o.eagerFirstClause && this.#first ? [gs, o.firstClauseMinChars] : undefined;
      const cands = candidates(t, gs, final, clause);
      let emitted = false;
      for (const c of cands) {
        if (!c.decided) break;
        if (!c.boundary) continue;
        const [a, b] = strip(t, gs, c.end);
        if (b - a > o.maxChars) break; // handled by wrapping below
        if (!speakable(t, a, b)) continue; // punctuation only: nothing to say yet, extend
        if (this.#wrapping || b - a >= (this.#first ? o.firstMinChars : o.minChars)) {
          this.#emit(out, t, a, b);
          this.#wrapping = false;
          gs = skipWs(t, c.end);
          emitted = true;
          break;
        }
        // too short: extend the group to the next boundary
      }
      if (emitted) continue;
      // No boundary closes a group of acceptable size. Wrap if the group is certainly
      // longer than maxChars.
      const limit = gs + o.maxChars;
      const firstOpen = cands.find((c) => !c.decided || c.boundary)?.end;
      const [ra, rb] = strip(t, gs, t.length);
      const restLength = rb - ra;
      let certainlyLong = (firstOpen === undefined || firstOpen > limit) && t.length > limit;
      if (final && restLength > o.maxChars) certainlyLong = true;
      if (certainlyLong && restLength > o.maxChars) {
        const cut = wrapCut(t, gs, o.maxChars);
        const [a, b] = strip(t, gs, cut);
        this.#emit(out, t, a, b);
        this.#wrapping = true;
        gs = skipWs(t, cut);
        continue;
      }
      if (final) {
        this.#emit(out, t, ra, rb);
        gs = t.length;
      }
      break;
    }
    const keep = keepFrom(t, gs);
    this.#buf = keep ? t.slice(keep) : t;
    this.#gs = gs - keep;
    return out;
  }
}

/** Splits text into sentences for synthesis (BEHAVIOR.md §7). */
export function splitSentences(text: string, options?: SegmenterOptions): string[] {
  const segmenter = new Segmenter(options);
  return [...segmenter.push(text), ...segmenter.flush()];
}
