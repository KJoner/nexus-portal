import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createApp } from './app';
import { LoginLimiter } from './auth/rate-limit';
import { Auth } from './auth/sessions';
import { ConfigRepo } from './config/repo';
import { openDb } from './db';
import { EnvError, readEnv } from './env';
import { HealthChecker } from './health/checker';
import { IconProxy } from './icons/proxy';
import { IconStore } from './icons/store';
import { Linkwarden } from './integrations/linkwarden';
import { SecretBox } from './integrations/secret';
import { WallpaperStore } from './wallpapers/store';

async function main() {
  const env = readEnv();
  const db = openDb(join(env.dataDir, 'nexus.db'));
  const auth = new Auth(db, env.sessionDays);
  const result = await auth.ensurePassword(env.password);
  if (result === 'missing') throw new EnvError('尚未设置访问密码：请通过环境变量 NEXUS_PASSWORD 设置（至少 8 个字符）');

  const repo = new ConfigRepo(db);
  const policy = { allowPrivate: env.allowPrivate, allowLoopback: env.allowLoopback };
  const health = new HealthChecker(db, repo, policy);
  const { box, generated } = SecretBox.fromEnv(env.secret ?? undefined, join(env.dataDir, 'secret.key'));
  if (generated) console.log('[nexus] 未设置 NEXUS_SECRET，已在数据目录生成 secret.key 用于加密服务凭据；备份时请一并保存');
  health.start();
  const app = createApp({ env, repo, auth, limiter: new LoginLimiter(), wallpapers: new WallpaperStore(db, join(env.dataDir, 'wallpapers')), icons: new IconStore(join(env.dataDir, 'icons')), health, iconProxy: new IconProxy(join(env.dataDir, 'icon-cache')), linkwarden: new Linkwarden(db, box, policy) });
  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    const version = process.env.NEXUS_VERSION ? ` ${process.env.NEXUS_VERSION}` : '';
    console.log(`[nexus]${version} 已启动 http://${info.address}:${info.port} · 数据目录 ${env.dataDir}`);
    if (env.generatedPassword) console.log(`[nexus] 开发模式临时密码：${env.password}（设置 NEXUS_PASSWORD 可固定）`);
    else if (result === 'set') console.log('[nexus] 访问密码已更新，旧会话已失效');
    if (!env.webDist) console.log('[nexus] 未找到前端构建产物，仅提供 API');
  });

  const shutdown = () => {
    health.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e instanceof EnvError ? `[nexus] ${e.message}` : e);
  process.exit(1);
});
