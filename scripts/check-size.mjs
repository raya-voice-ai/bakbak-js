// Bundles the ESM entry for a browser the way an application's bundler would (minified),
// and checks that it stays under the size budget and pulls in neither ws nor node: modules.
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const BUDGET = 20 * 1024;

const result = await build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  metafile: true,
  logLevel: 'silent',
});
const code = result.outputFiles[0].contents;
const gzipped = gzipSync(code, { level: 9 }).length;
const inputs = Object.keys(result.metafile.inputs);
const problems = [];
if (inputs.some((p) => /node_modules[\\/]ws[\\/]/.test(p))) problems.push('the browser bundle includes ws');
if (inputs.some((p) => p.startsWith('node:'))) problems.push('the browser bundle includes node: built-ins');
if (gzipped > BUDGET) problems.push(`main entry is ${gzipped} bytes gzipped, over the ${BUDGET}-byte budget`);
console.log(`main entry, minified: ${code.length} bytes; gzipped: ${gzipped} bytes (budget ${BUDGET})`);
if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
