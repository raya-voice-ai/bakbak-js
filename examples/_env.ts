// Settings shared by the examples, from environment variables.
// BAKBAK_API_KEY is required; BAKBAK_BASE_URL defaults to production.
import { mkdirSync } from 'node:fs';

/** "Anika M1", an m1 Hindi voice. List others with `npx tsx examples/quickstart.ts`. */
export const voice_id = process.env.BAKBAK_VOICE_ID ?? '009ae8b5-4a03-492d-af1c-3055989ac734';
export const language = process.env.BAKBAK_LANGUAGE ?? 'hi';
export const model = process.env.BAKBAK_MODEL ?? 'm1';

/** Where examples write audio. */
export function outPath(name: string): string {
  mkdirSync('out', { recursive: true });
  return `out/${name}`;
}
