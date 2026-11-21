import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_DIST, NEW_DIST, ROOT } from './harness';

/**
 * Needs the production build (`npm run build`). Builds the 0.4.0 Service Worker fixture for the
 * upgrade test unless NEXUS_E2E_LEGACY_DIST points at a real old build.
 */
export default function globalSetup() {
  for (const f of [join(NEW_DIST, 'sw.js'), join(ROOT, 'apps/server/dist/index.mjs')]) if (!existsSync(f)) throw new Error(`缺少生产构建 ${f}：先运行 npm run build`);
  if (!readFileSync(join(NEW_DIST, 'sw.js'), 'utf8').includes('NetworkOnly')) throw new Error('apps/web/dist/sw.js 不是本分支的构建（没有 /auth/* 的网络路由）：先运行 npm run build');
  if (process.env.NEXUS_E2E_LEGACY_DIST?.trim()) {
    if (!existsSync(join(LEGACY_DIST, 'sw.js'))) throw new Error(`NEXUS_E2E_LEGACY_DIST=${LEGACY_DIST} 里没有 sw.js`);
    return;
  }
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(ROOT, 'e2e-auth/legacy-0.4.0.vite.config.ts')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('构建 0.4.0 Service Worker 夹具失败');
}
