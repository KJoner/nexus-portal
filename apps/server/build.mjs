import { build } from 'esbuild';

// Bundles the server and @nexus/shared into one ESM file; native modules stay external.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3', 'sharp'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
