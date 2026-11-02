// Starts the built server on a throw-away data directory for the e2e run.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const data = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));

/** Today's 每日一图, already in the server's cache: the tests never reach Wikimedia. */
async function seedDaily() {
  const id = 'dl-0e2e0e2e0e2e';
  const folder = join(data, 'daily-cache', id);
  mkdirSync(folder, { recursive: true });
  const image = sharp({ create: { width: 1280, height: 800, channels: 3, background: '#38506a' } });
  await Promise.all([image.clone().avif().toFile(join(folder, '1280.avif')), image.clone().webp().toFile(join(folder, '1280.webp')), image.clone().jpeg().toFile(join(folder, '1280.jpg'))]);
  const date = new Date().toISOString().slice(0, 10);
  const placeholder = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const credit = { author: 'e2e', license: 'CC0', provider: 'Wikimedia Commons', required: false };
  writeFileSync(join(folder, 'meta.json'), JSON.stringify({ date, wallpaper: { id, name: '每日一图 · 测试', width: 1280, height: 800, widths: [1280], placeholder, createdAt: new Date().toISOString(), source: 'daily', ref: date, credit, luma: 0.3, focal: null } }));
}
await seedDaily();

const child = spawn(process.execPath, [join(root, 'apps/server/dist/index.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: process.env.E2E_PORT ?? '8790',
    NEXUS_DATA_DIR: data,
    NEXUS_WEB_DIST: join(root, 'apps/web/dist'),
    NEXUS_PASSWORD: 'e2e-password',
    NEXUS_SECRET: 'e2e-secret-0123456789',
  },
});
const stop = () => {
  child.kill();
  rmSync(data, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
