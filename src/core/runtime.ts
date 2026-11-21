import { VERSION } from '../version';

/** What the SDK knows about the JavaScript runtime it is running in. */
export interface RuntimeInfo {
  kind: 'node' | 'bun' | 'deno' | 'workerd' | 'browser' | 'unknown';
  /** A browser page or browser worker, where an API key would be visible to users. */
  browser: boolean;
  /** Node's global WebSocket (undici) can send request headers (undici >= 6.13, Node >= 22). */
  nativeWebSocketHeaders: boolean;
  /** `User-Agent` value, or undefined where the SDK must not set one (browsers). */
  userAgent: string | undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: runtime feature detection reads untyped globals.
type AnyGlobal = Record<string, any>;

function versionAtLeast(version: string | undefined, major: number, minor: number): boolean {
  if (!version) return false;
  const [a, b] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (a === undefined || Number.isNaN(a)) return false;
  return a > major || (a === major && (b ?? 0) >= minor);
}

/** Detects the runtime from globals. Takes the global object as a parameter so tests can fake one. */
export function detectRuntime(g: AnyGlobal = globalThis as AnyGlobal): RuntimeInfo {
  const client = `bakbak-js/${VERSION}`;
  if (g.Bun !== undefined) {
    return {
      kind: 'bun',
      browser: false,
      nativeWebSocketHeaders: false,
      userAgent: `${client} bun/${g.Bun.version} ${g.process?.platform ?? 'unknown'}/${g.process?.arch ?? 'unknown'}`,
    };
  }
  if (g.Deno !== undefined) {
    const build = g.Deno.build ?? {};
    return {
      kind: 'deno',
      browser: false,
      nativeWebSocketHeaders: false,
      userAgent: `${client} deno/${g.Deno.version?.deno ?? 'unknown'} ${build.os ?? 'unknown'}/${build.arch ?? 'unknown'}`,
    };
  }
  const versions = g.process?.versions;
  if (typeof versions?.node === 'string') {
    return {
      kind: 'node',
      browser: false,
      nativeWebSocketHeaders: versionAtLeast(versions.undici, 6, 13),
      userAgent: `${client} node/${versions.node} ${g.process.platform}/${g.process.arch}`,
    };
  }
  if (g.navigator?.userAgent === 'Cloudflare-Workers') {
    return { kind: 'workerd', browser: false, nativeWebSocketHeaders: false, userAgent: `${client} workerd` };
  }
  const page = g.window !== undefined && g.document !== undefined;
  const worker =
    typeof g.WorkerGlobalScope === 'function' &&
    g.self !== undefined &&
    g.self instanceof g.WorkerGlobalScope;
  if (page || worker) {
    return { kind: 'browser', browser: true, nativeWebSocketHeaders: false, userAgent: undefined };
  }
  return { kind: 'unknown', browser: false, nativeWebSocketHeaders: false, userAgent: client };
}

/** Reads an environment variable where the runtime has them (Node, Bun, Deno), else undefined. */
export function readEnv(name: string, g: AnyGlobal = globalThis as AnyGlobal): string | undefined {
  try {
    if (typeof g.process?.env === 'object' && g.process.env !== null) {
      const value = g.process.env[name];
      if (typeof value === 'string') return value.trim() || undefined;
    }
    if (typeof g.Deno?.env?.get === 'function') {
      return (g.Deno.env.get(name) as string | undefined)?.trim() || undefined;
    }
  } catch {
    // Deno without --allow-env throws; treat as unset.
  }
  return undefined;
}

/**
 * Imports a module by a name bundlers cannot see, so browser bundles never include `ws` or
 * `node:` built-ins. Only called on runtimes that have them.
 */
export function importOptional<T>(specifier: string): Promise<T> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as Promise<T>;
}
