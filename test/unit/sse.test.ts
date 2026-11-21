import { describe, expect, it } from 'vitest';
import { parseSSE, type SSEEvent } from '../../src/core/sse';

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

async function collect(parts: string[]): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const ev of parseSSE(streamOf(parts), () => {})) out.push(ev);
  return out;
}

const BODY =
  ': keep-alive\r\n\r\nevent: chunk\r\ndata: {"a":1}\r\n\r\nid: 7\nretry: 100\nevent: done\ndata: one\ndata: two\n\n';
const EXPECTED = [
  { event: 'chunk', data: '{"a":1}' },
  { event: 'done', data: 'one\ntwo' },
];

describe('SSE parsing (BEHAVIOR.md §5.1)', () => {
  it('accepts LF and CRLF, ignores comments, id and retry, joins data lines', async () => {
    expect(await collect([BODY])).toEqual(EXPECTED);
  });

  it('gives the same events however the body is split', async () => {
    for (let i = 1; i < BODY.length; i++) {
      expect(await collect([BODY.slice(0, i), BODY.slice(i)]), `split at ${i}`).toEqual(EXPECTED);
    }
    expect(await collect([...BODY])).toEqual(EXPECTED);
  });

  it('keeps multi-byte characters split across reads', async () => {
    const enc = new TextEncoder().encode('data: नमस्ते\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of enc) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    const out: SSEEvent[] = [];
    for await (const ev of parseSSE(stream, () => {})) out.push(ev);
    expect(out).toEqual([{ event: '', data: 'नमस्ते' }]);
  });

  it('handles a very long data line', async () => {
    const big = 'A'.repeat(3 * 1024 * 1024);
    const parts = [];
    const body = `data: ${big}\n\n`;
    for (let i = 0; i < body.length; i += 65536) parts.push(body.slice(i, i + 65536));
    const out = await collect(parts);
    expect(out[0]?.data.length).toBe(big.length);
  });

  it('dispatches a complete final event whose blank line never came, but not a partial line', async () => {
    expect(await collect(['data: x\n'])).toEqual([{ event: '', data: 'x' }]);
    expect(await collect(['data: x'])).toEqual([]);
  });

  it('calls onRead for each network read', async () => {
    let reads = 0;
    for await (const _ of parseSSE(streamOf(['data: a\n', '\n', 'data: b\n\n']), () => reads++)) {
      // consume
    }
    expect(reads).toBe(3);
  });
});
