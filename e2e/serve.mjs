// Starts the built server on a throw-away data directory for the e2e run.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const data = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
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
