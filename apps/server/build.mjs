import { build } from 'esbuild';

// 应用目录 build-time check (v0.4): bundle the checker on the fly and run it; an invalid catalog
// stops the build here instead of reaching a running server.
const check = await build({ entryPoints: ['src/catalog/check.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false, logLevel: 'silent' });
await import(`data:text/javascript;base64,${Buffer.from(check.outputFiles[0].text).toString('base64')}`);

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
