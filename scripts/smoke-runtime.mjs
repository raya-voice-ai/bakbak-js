// Runtime smoke test of the built ESM package: run it with Node, Bun or Deno against
// scripts/smoke-server.mjs.
//   node|bun scripts/smoke-runtime.mjs http://127.0.0.1:<port>
//   deno run --allow-net --allow-env --allow-read --allow-write scripts/smoke-runtime.mjs http://127.0.0.1:<port>
import * as sdk from '../dist/index.js';

const baseURL = globalThis.Deno ? globalThis.Deno.args[0] : globalThis.process.argv[2];
const runtime = globalThis.Bun
  ? `bun ${globalThis.Bun.version}`
  : globalThis.Deno
    ? `deno ${globalThis.Deno.version.deno}`
    : `node ${globalThis.process.version}`;
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.stack ?? err) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const client = new sdk.Bakbak({ apiKey: 'test-key', baseURL });
const params = { text: 'नमस्ते।', voice_id: 'v1', language: 'hi', model: 'm1' };

await check('voices.list', async () => {
  const list = await client.voices.list({ language: 'hi' });
  assert(list.count === 1, `count ${list.count}`);
  return list.voices[0].name;
});
await check('generate + toWav + save', async () => {
  const audio = await client.tts.generate(params);
  assert(audio.data.length === 3200 && audio.sampleRate === 16000, 'audio metadata');
  assert(audio.toWav().length === 3244, 'wav size');
  const path = `${globalThis.Deno ? '/tmp' : (globalThis.process.env.TMPDIR ?? '/tmp')}/bakbak-smoke.wav`;
  await new sdk.Audio(audio.toWav()).save(path);
  return audio.requestId;
});
await check('stream (SSE)', async () => {
  const stream = client.tts.stream(params);
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.audio.length;
  assert(bytes === 6400, `bytes ${bytes}`);
  return await stream.requestId;
});
await check('errors and instanceof', async () => {
  const err = await client.tts.generate({ ...params, voice_id: 'missing' }).catch((e) => e);
  assert(err instanceof sdk.NotFoundError && err instanceof sdk.BakbakError, `got ${err?.name}`);
  assert(err.errorCode === 'voice_not_found' && err.retryable === false, 'error fields');
  return err.name;
});
await check('websocket (global WebSocket)', async () => {
  const ws = client.tts.websocket({ voice_id: 'v1', language: 'hi', model: 'm1' });
  try {
    await ws.connect();
    const ctx = ws.context();
    const req = await ctx.send({ text: 'नमस्ते।', output_format: { container: 'raw', encoding: 'pcm_s16le' } });
    ctx.endInput();
    let bytes = 0;
    for await (const audio of ctx.audio()) bytes += audio.length;
    const result = await req.result();
    assert(bytes === 3200, `bytes ${bytes}`);
    return `key via ${result.requestId === 'req_query' ? 'query string' : 'header'}`;
  } finally {
    await ws.close();
  }
});
await check('splitSentences', async () => {
  const s = sdk.splitSentences('पहला वाक्य। दूसरा वाक्य।');
  assert(s.length === 2, JSON.stringify(s));
  return s.length;
});

console.log(JSON.stringify({ runtime, results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
if (globalThis.Deno) globalThis.Deno.exit(failed ? 1 : 0);
else globalThis.process.exit(failed ? 1 : 0);
