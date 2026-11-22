import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'neutral',
  treeshake: true,
  // esbuild renames a class that refers to itself (`class _NotFoundError`); keepNames restores
  // the name that console.log and err.constructor.name show.
  keepNames: true,
  splitting: false,
  minify: false,
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
