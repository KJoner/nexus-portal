import { build } from 'esbuild';

// Bundles the server (and the deploy helper CLI) with @nexus/shared into ESM files; native modules stay external.
await build({
  entryPoints: ['src/index.ts', 'src/cli.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3', 'sharp'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
