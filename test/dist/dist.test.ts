/**
 * Smoke tests of the built package (run `npm run build` first; `npm run test:dist` does).
 * They load dist/ the way applications do: CommonJS require and ESM import, in this process
 * and in fresh Node processes resolving the package by name.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
type SDK = typeof import('../../src/index');
// Paths in variables: type checking must not need a build.
const CJS_ENTRY = '../../dist/index.cjs';
const ESM_ENTRY = '../../dist/index.js';
const loadCjs = () => require(CJS_ENTRY) as SDK;
const loadEsm = async () => (await import(ESM_ENTRY)) as SDK;

const EXPORTS = [
  'Bakbak',
  'BakbakError',
  'APIError',
  'APIStatusError',
  'BadRequestError',
  'AuthenticationError',
  'InsufficientCreditsError',
  'PermissionDeniedError',
  'NotFoundError',
  'RequestTooLargeError',
  'UnprocessableEntityError',
  'RateLimitError',
  'InternalServerError',
  'StreamInterruptedError',
  'APIConnectionError',
  'APITimeoutError',
  'WebSocketClosedError',
  'Audio',
  'toWav',
  'splitSentences',
  'Segmenter',
  'VERSION',
];

describe('dist', () => {
  it('is built', () => {
    for (const f of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
      expect(existsSync(`${root}dist/${f}`), `dist/${f} (run npm run build)`).toBe(true);
    }
  });

  it('loads with require() and import(), with the same exports', async () => {
    const cjs = loadCjs();
    const esm = await loadEsm();
    for (const name of EXPORTS) {
      expect(cjs, `CJS ${name}`).toHaveProperty(name);
      expect(esm, `ESM ${name}`).toHaveProperty(name);
    }
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };
    expect(cjs.VERSION).toBe(pkg.version);
    expect(esm.VERSION).toBe(pkg.version);
  });

  it('keeps instanceof working between the CJS and ESM copies', async () => {
    const cjs = loadCjs();
    const esm = await loadEsm();
    expect(cjs.RateLimitError).not.toBe(esm.RateLimitError);
    const fromCjs = new cjs.RateLimitError('busy', { status: 429 });
    expect(fromCjs).toBeInstanceOf(esm.RateLimitError);
    expect(fromCjs).toBeInstanceOf(esm.APIStatusError);
    expect(fromCjs).toBeInstanceOf(esm.BakbakError);
    expect(fromCjs).not.toBeInstanceOf(esm.NotFoundError);
    const fromEsm = new esm.StreamInterruptedError('cut', { audioBytes: 1 });
    expect(fromEsm).toBeInstanceOf(cjs.StreamInterruptedError);
    expect(fromEsm).not.toBeInstanceOf(cjs.APIStatusError);
  });

  it('resolves by package name in fresh Node processes', () => {
    const cjs = execFileSync(
      process.execPath,
      [
        '-e',
        "const b = require('bakbak'); console.log(typeof b.Bakbak, b.splitSentences('One. Two.').length)",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(cjs.trim()).toBe('function 2');
    const esm = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { Bakbak, toWav } from 'bakbak'; console.log(typeof Bakbak, toWav(new Uint8Array(2), { encoding: 'pcm_s16le', sampleRate: 8000 }).length)",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(esm.trim()).toBe('function 46');
  });

  it('never imports ws statically', () => {
    for (const f of ['index.js', 'index.cjs']) {
      const code = readFileSync(`${root}dist/${f}`, 'utf8');
      expect(code).not.toMatch(/from ['"]ws['"]|require\(['"]ws['"]\)/);
    }
  });

  it('loads ws lazily from the CommonJS build and synthesizes over it', async () => {
    const cjs = loadCjs();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    let apiKey: string | undefined;
    wss.on('connection', (ws, req) => {
      apiKey = req.headers['x-api-key'] as string;
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { context_id: string };
        const base = { context_id: msg.context_id, request_id: 'req_dist' };
        ws.send(JSON.stringify({ type: 'chunk', data: Buffer.from([1, 2]).toString('base64'), ...base }));
        ws.send(JSON.stringify({ type: 'done', done: true, ...base }));
      });
    });
    await new Promise<void>((r) => server.listen(0, 'localhost', r));
    try {
      const client = new cjs.Bakbak({
        apiKey: 'k',
        baseURL: `http://localhost:${(server.address() as AddressInfo).port}`,
        webSocket: 'ws',
      });
      const ws = client.tts.websocket({ voice_id: 'v', language: 'hi' });
      const ctx = ws.context();
      const req = await ctx.send({ text: 'x', output_format: { container: 'raw', encoding: 'pcm_s16le' } });
      expect(await req.result()).toMatchObject({ requestId: 'req_dist', audioBytes: 2 });
      expect(apiKey).toBe('k');
      await ws.close();
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
