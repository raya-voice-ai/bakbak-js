/**
 * Runs every conformance/http/*.json scenario against a real node:http server on a real
 * socket, following conformance/README.md's matching rules exactly.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Bakbak, type TTSParams } from '../../src/index';
import {
  concat,
  deepEqual,
  type ExpectedError,
  expectError,
  expectSleeps,
  loadScenarios,
  recordingSleep,
  sha256,
} from '../helpers';

interface Exchange {
  expect_request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    json?: unknown;
  };
  response:
    | { status: number; headers: Record<string, string>; json: unknown }
    | { status: number; headers: Record<string, string>; sse: string }
    | { status: number; headers: Record<string, string>; body_base64: string }
    | { network_error: true };
}

interface HttpScenario {
  id: string;
  description: string;
  call: { method: 'generate' | 'stream' | 'voices.list'; params: Record<string, unknown> };
  exchanges: Exchange[];
  expect: {
    result?: {
      audio_bytes?: number;
      audio_sha256?: string;
      chunks?: number;
      request_id?: string;
      content_type?: string;
      encoding?: string;
      sample_rate?: number;
      count?: number;
      ids?: string[];
    };
    error?: ExpectedError;
    sleeps: Array<[number, number]>;
  };
}

interface MockServer {
  baseURL: string;
  attempts: number;
  problems: string[];
  close(): Promise<void>;
}

async function startServer(exchanges: Exchange[]): Promise<MockServer> {
  const state = { attempts: 0, problems: [] as string[] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const n = state.attempts++;
      const exchange = exchanges[n];
      if (!exchange) {
        state.problems.push(`unexpected attempt ${n + 1}: ${req.method} ${req.url}`);
        req.socket.destroy();
        return;
      }
      const exp = exchange.expect_request;
      if (req.method !== exp.method)
        state.problems.push(`attempt ${n + 1}: method ${req.method} != ${exp.method}`);
      if (req.url !== exp.path) state.problems.push(`attempt ${n + 1}: path ${req.url} != ${exp.path}`);
      for (const [name, value] of Object.entries(exp.headers ?? {})) {
        const got = req.headers[name.toLowerCase()];
        if (got !== value)
          state.problems.push(`attempt ${n + 1}: header ${name}: ${String(got)} != ${value}`);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (exp.json !== undefined) {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        // A request body must match exactly: clients send only what the caller gave.
        if (!deepEqual(body, exp.json)) state.problems.push(`attempt ${n + 1}: body ${raw}`);
      }
      const response = exchange.response;
      if ('network_error' in response) {
        req.socket.destroy();
        return;
      }
      res.writeHead(response.status, response.headers);
      if ('json' in response) res.end(JSON.stringify(response.json));
      else if ('sse' in response) res.end(response.sse);
      else res.end(Buffer.from(response.body_base64, 'base64'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://localhost:${port}`,
    get attempts() {
      return state.attempts;
    },
    problems: state.problems,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const scenarios = loadScenarios<HttpScenario>('http');
let current: MockServer | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('conformance: HTTP', () => {
  it('has scenarios', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      const server = await startServer(scenario.exchanges);
      current = server;
      const sleeps: number[] = [];
      const client = new Bakbak({
        apiKey: 'test-key',
        baseURL: server.baseURL,
        maxRetries: 2,
        sleep: recordingSleep(sleeps),
      });

      let result: Record<string, unknown> | undefined;
      let error: unknown;
      try {
        const params = scenario.call.params;
        if (scenario.call.method === 'generate') {
          const audio = await client.tts.generate(params as unknown as TTSParams);
          result = {
            audio_bytes: audio.data.length,
            audio_sha256: sha256(audio.data),
            request_id: audio.requestId,
            content_type: audio.contentType,
            encoding: audio.encoding,
            sample_rate: audio.sampleRate,
          };
        } else if (scenario.call.method === 'stream') {
          const stream = client.tts.stream(params as unknown as TTSParams);
          const parts: Uint8Array[] = [];
          for await (const chunk of stream) parts.push(chunk.audio);
          const audio = concat(parts);
          result = {
            audio_bytes: audio.length,
            audio_sha256: sha256(audio),
            chunks: parts.length,
            request_id: await stream.requestId,
            encoding: stream.encoding,
            sample_rate: stream.sampleRate,
          };
        } else {
          const list = await client.voices.list(params);
          result = { count: list.count, ids: list.voices.map((v) => v.id) };
        }
      } catch (err) {
        error = err;
      }

      expect(server.problems).toEqual([]);
      expect(server.attempts, 'attempts').toBe(scenario.exchanges.length);
      if (scenario.expect.error) {
        expect(result, 'expected an error, got a result').toBeUndefined();
        expectError(error, scenario.expect.error);
      } else {
        if (error) throw error;
        for (const [key, value] of Object.entries(scenario.expect.result ?? {})) {
          expect(result?.[key], key).toEqual(value);
        }
      }
      expectSleeps(sleeps, scenario.expect.sleeps);
    });
  }
});
