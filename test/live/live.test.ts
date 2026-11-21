/**
 * Live tests against a real deployment. They spend real credits, so they run only when
 * BAKBAK_API_KEY and BAKBAK_BASE_URL are both set, one at a time, with short texts.
 *
 *   BAKBAK_API_KEY=… BAKBAK_BASE_URL=https://… npm run test:live
 *
 * Set BAKBAK_LIVE_WEBSOCKET=0 for a deployment without the WebSocket endpoint. Set
 * BAKBAK_LIVE_VOICE to choose the m1 Hindi voice (default: "Anika M1").
 */
import { describe, expect, it } from 'vitest';
import {
  Bakbak,
  type ContextEvent,
  NotFoundError,
  type TTSParams,
  UnprocessableEntityError,
  type Voice,
} from '../../src/index';

const apiKey = process.env.BAKBAK_API_KEY;
const baseURL = process.env.BAKBAK_BASE_URL;
const enabled = Boolean(apiKey && baseURL);
const websocket = process.env.BAKBAK_LIVE_WEBSOCKET !== '0';
const VOICE = process.env.BAKBAK_LIVE_VOICE ?? '009ae8b5-4a03-492d-af1c-3055989ac734';

// The staging deployment serves each model one request at a time, so overlapping requests
// get real 503s: allow enough retries to ride them out.
const client = enabled ? new Bakbak({ apiKey, baseURL, maxRetries: 4 }) : undefined;
const hi = (text: string): TTSParams => ({ text, voice_id: VOICE, language: 'hi', model: 'm1' });

function sdk(): Bakbak {
  if (!client) throw new Error('live tests need BAKBAK_API_KEY and BAKBAK_BASE_URL');
  return client;
}

describe.skipIf(!enabled)('live: HTTP', () => {
  let voices: Voice[] = [];

  it('lists voices, filtered on the client', async () => {
    const all = await sdk().voices.list();
    expect(all.count).toBeGreaterThan(0);
    expect(all.count).toBe(all.voices.length);
    voices = all.voices;
    expect(voices.some((v) => v.id === VOICE)).toBe(true);
    const m1Hindi = await sdk().voices.list({ model: 'm1', language: 'hi' });
    expect(m1Hindi.voices.length).toBeGreaterThan(0);
    expect(m1Hindi.voices.every((v) => v.model === 'm1' && v.language === 'hi')).toBe(true);
  });

  it('generates a whole WAV file by default', async () => {
    const audio = await sdk().tts.generate(hi('नमस्ते।'));
    expect(audio.isWav).toBe(true);
    expect(audio.data.length).toBeGreaterThan(1000);
    expect(audio.requestId).toBeTruthy();
    expect(audio.toWav()).toBe(audio.data);
  });

  it('generates telephony audio with output_format (raw μ-law, 8 kHz)', async () => {
    const audio = await sdk().tts.generate({
      ...hi('आपका ऑर्डर आज पहुँचेगा।'),
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    });
    expect(audio.encoding).toBe('pcm_mulaw');
    expect(audio.sampleRate).toBe(8000);
    expect(audio.contentType).toBe('audio/basic');
    expect(audio.isWav).toBe(false);
    expect(audio.toWav().length).toBe(58 + audio.data.length);
  });

  it('streams over SSE, in whole samples', async () => {
    const start = performance.now();
    let firstAudio: number | undefined;
    const stream = sdk().tts.stream({
      ...hi('धन्यवाद, आपका दिन शुभ हो।'),
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
    });
    let bytes = 0;
    let chunks = 0;
    for await (const chunk of stream) {
      firstAudio ??= performance.now() - start;
      expect(chunk.audio.length % 2).toBe(0);
      bytes += chunk.audio.length;
      chunks++;
    }
    expect(chunks).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThan(1000);
    expect(await stream.requestId).toBeTruthy();
    expect(stream.encoding).toBe('pcm_s16le');
    expect(stream.sampleRate).toBe(16000);
    console.log(`live SSE: ${chunks} chunks, ${bytes} bytes, TTFA ${firstAudio?.toFixed(1)} ms`);
  });

  it('raises the documented errors', async () => {
    await expect(sdk().tts.generate({ ...hi('नमस्ते।'), voice_id: 'no-such-voice' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const err = await sdk()
      .tts.stream({ ...hi('नमस्ते।'), output_format: { container: 'wav', encoding: 'pcm_s16le' } })
      .bytes()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect((err as UnprocessableEntityError).message).toMatch(/container/);
  });
});

describe.skipIf(!enabled || !websocket)('live: WebSocket', () => {
  async function collect(events: AsyncIterable<ContextEvent>) {
    const out: ContextEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }

  it('sends one request on a prewarmed connection', async () => {
    const ws = sdk().tts.websocket({ voice_id: VOICE, language: 'hi', model: 'm1' });
    try {
      await ws.connect();
      const ctx = ws.context();
      const start = performance.now();
      let firstAudio: number | undefined;
      const req = await ctx.send({ text: 'नमस्ते, आप कैसे हैं?' });
      ctx.endInput();
      let bytes = 0;
      for await (const audio of ctx.audio()) {
        firstAudio ??= performance.now() - start;
        bytes += audio.length;
      }
      const result = await req.result();
      expect(result.audioBytes).toBe(bytes);
      expect(result.requestId).toBeTruthy();
      console.log(`live WebSocket: ${bytes} bytes, TTFA ${firstAudio?.toFixed(1)} ms`);
    } finally {
      await ws.close();
    }
  });

  it('streams LLM-style tokens sentence by sentence (sendStream)', async () => {
    const ws = sdk().tts.websocket({
      voice_id: VOICE,
      language: 'hi',
      model: 'm1',
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    });
    try {
      const ctx = ws.context();
      async function* tokens() {
        for (const t of ['जी ', 'हाँ', '। आपका ', 'रिचार्ज ', 'हो ', 'गया ', 'है', '। ', 'धन्यवाद', '।']) {
          await new Promise((r) => setTimeout(r, 20));
          yield { choices: [{ delta: { content: t } }] };
        }
      }
      const [events] = await Promise.all([collect(ctx.events()), ctx.sendStream(tokens())]);
      const done = events.filter((e) => e.type === 'done');
      const failed = events.filter((e) => e.type === 'failed');
      expect(failed).toEqual([]);
      // "जी हाँ।" goes alone (first sentence), "आपका रिचार्ज हो गया है।" is long enough to go
      // alone, and the short "धन्यवाद।" is sent when the input ends.
      expect(done.length).toBe(3);
      expect(events.filter((e) => e.type === 'chunk').length).toBeGreaterThan(0);
    } finally {
      await ws.close();
    }
  });

  it('cancels a running request, then reuses the context', async () => {
    const ws = sdk().tts.websocket({ voice_id: VOICE, language: 'hi', model: 'm1' });
    try {
      const ctx = ws.context();
      const long = await ctx.send({
        text: 'यह एक लंबा वाक्य है जिसे हम रद्द करने वाले हैं, ताकि हम देख सकें कि रद्द करना कैसे काम करता है।',
      });
      const events = ctx.events();
      const first = await events.next(); // the first audio
      expect(first.value?.type).toBe('chunk');
      await ctx.cancel();
      const cancelled = await events.next();
      expect(cancelled.value).toMatchObject({ type: 'cancelled' });
      expect((await long.result()).cancelled).toBe(true);
      const after = await ctx.send({ text: 'रद्द के बाद।' });
      ctx.endInput();
      const rest = await collect({ [Symbol.asyncIterator]: () => events });
      expect(rest.at(-1)).toMatchObject({ type: 'done' });
      expect((await after.result()).audioBytes).toBeGreaterThan(0);
    } finally {
      await ws.close();
    }
  });
});
