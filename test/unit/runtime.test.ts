import { describe, expect, it } from 'vitest';
import { detectRuntime, readEnv } from '../../src/core/runtime';
import { VERSION } from '../../src/index';
import { redactKey } from '../../src/ws/transport';

describe('detectRuntime', () => {
  it('detects Node and whether its WebSocket can send headers (undici >= 6.13)', () => {
    const node = (undici?: string) =>
      detectRuntime({ process: { versions: { node: '22.1.0', undici }, platform: 'linux', arch: 'x64' } });
    expect(node('6.13.0')).toMatchObject({ kind: 'node', browser: false, nativeWebSocketHeaders: true });
    expect(node('6.12.9').nativeWebSocketHeaders).toBe(false);
    expect(node('7.0.0').nativeWebSocketHeaders).toBe(true);
    expect(node(undefined).nativeWebSocketHeaders).toBe(false);
    expect(node('6.13.0').userAgent).toBe(`bakbak-js/${VERSION} node/22.1.0 linux/x64`);
  });

  it('detects Bun, Deno and Cloudflare Workers, which use the query string', () => {
    expect(detectRuntime({ Bun: { version: '1.2.0' }, process: { versions: { node: '22' } } })).toMatchObject(
      {
        kind: 'bun',
        nativeWebSocketHeaders: false,
      },
    );
    expect(
      detectRuntime({ Deno: { version: { deno: '2.1.0' }, build: { os: 'linux', arch: 'x86_64' } } }),
    ).toMatchObject({ kind: 'deno', userAgent: `bakbak-js/${VERSION} deno/2.1.0 linux/x86_64` });
    expect(detectRuntime({ navigator: { userAgent: 'Cloudflare-Workers' } })).toMatchObject({
      kind: 'workerd',
      browser: false,
    });
  });

  it('detects browser pages and browser workers, and sends no User-Agent there', () => {
    expect(detectRuntime({ window: {}, document: {} })).toMatchObject({
      kind: 'browser',
      browser: true,
      userAgent: undefined,
    });
    class WorkerGlobalScope {}
    const self = new WorkerGlobalScope();
    expect(detectRuntime({ WorkerGlobalScope, self }).browser).toBe(true);
  });
});

describe('readEnv', () => {
  it('reads process.env and Deno.env, treating blanks as unset', () => {
    expect(readEnv('X', { process: { env: { X: ' v ' } } })).toBe('v');
    expect(readEnv('X', { process: { env: { X: '  ' } } })).toBeUndefined();
    expect(readEnv('X', { Deno: { env: { get: () => 'd' } } })).toBe('d');
    const denied = {
      Deno: {
        env: {
          get: () => {
            throw new Error('permission denied');
          },
        },
      },
    };
    expect(readEnv('X', denied)).toBeUndefined();
    expect(readEnv('X', {})).toBeUndefined();
  });
});

describe('redactKey', () => {
  it('replaces the key in a URL with ***', () => {
    expect(redactKey('wss://h/v1/text-to-speech/ws?X-API-Key=sk_live_abc')).toBe(
      'wss://h/v1/text-to-speech/ws?X-API-Key=***',
    );
    expect(redactKey('wss://h/ws?a=1&x-api-key=sk%2Fabc&b=2')).toBe('wss://h/ws?a=1&x-api-key=***&b=2');
    expect(redactKey('wss://h/ws')).toBe('wss://h/ws');
  });
});
