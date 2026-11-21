import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createApp } from './app';
import { Devices, Pairings } from './auth/devices';
import { LoginIntents } from './auth/intents';
import { Oidc } from './auth/oidc';
import { LoginLimiter } from './auth/rate-limit';
import { Auth } from './auth/sessions';
import { ConfigRepo } from './config/repo';
import { LEGACY_ADMIN_ID, openDb, openPg, type DB } from './db';
import { EnvError, readEnv } from './env';
import { HealthChecker } from './health/checker';
import { IconProxy } from './icons/proxy';
import { IconStore } from './icons/store';
import { Linkwarden } from './integrations/linkwarden';
import { SecretBox } from './integrations/secret';
import { createProvider, Outbox } from './mail/outbox';
import { Users } from './users/users';
import { cleanLegacyDaily } from './wallpapers/legacy';
import { Commons, Daily, Gallery, Unsplash } from './wallpapers/sources';
import { WallpaperStore } from './wallpapers/store';
import { DEFAULT_QUOTAS, Quota } from './quota';

async function main() {
  const env = readEnv();
  const dbFile = join(env.dataDir, 'nexus.db');
  const db: DB = env.databaseUrl ? await openPg(env.databaseUrl) : openDb(dbFile);
  const auth = new Auth(db, env.sessionDays);
  const result = await auth.ensurePassword({ hash: env.passwordHash, plain: env.passwordHash ? null : env.password });
  // With unified sign-in the old password is optional (it only serves the legacy administrator).
  if (result === 'missing' && !env.oidc) throw new EnvError('尚未设置访问密码：用 deploy.sh 设置（写入 NEXUS_PASSWORD_HASH），或设置环境变量 NEXUS_PASSWORD（至少 8 个字符）；公开部署请改为配置统一身份（NEXUS_OIDC_ISSUER 等）');

  const users = new Users(db);
  const repo = new ConfigRepo(db, undefined, async (id) => ((await users.get(id))?.isAdmin ? null : (env.quotas ?? DEFAULT_QUOTAS).items));
  // Administrators come only from this server: the access password's account, claimed by a unified
  // identity. Without a password nobody could ever become one (invitations, disabling, status).
  if (result === 'missing' && env.oidc && !(await users.list()).some((u) => u.isAdmin && u.issuer && !u.disabled)) {
    console.warn('[nexus] 统一身份已启用，但还没有管理员：请设置访问密码（NEXUS_PASSWORD_HASH），用它登录后在「设置 › 数据、同步与安全」绑定统一账号');
  }
  const policy = { allowPrivate: env.allowPrivate, allowLoopback: env.allowLoopback };
  // Health checks probe the administrator's own services, nobody else's.
  const health = new HealthChecker(db, repo, policy, undefined, LEGACY_ADMIN_ID);
  const { box, generated } = SecretBox.fromEnv(env.secret ?? undefined, join(env.dataDir, 'secret.key'));
  if (generated) console.log('[nexus] 未设置 NEXUS_SECRET，已在数据目录生成 secret.key 用于加密服务凭据；备份时请一并保存');
  await health.start();
  // TN-07: storage limits for every account except the administrator (whose server it is).
  const quota = new Quota(db, { wallpapers: join(env.dataDir, 'wallpapers'), icons: join(env.dataDir, 'icons') }, async (id) => ((await users.get(id))?.isAdmin ? null : (env.quotas ?? DEFAULT_QUOTAS)));
  const wallpapers = new WallpaperStore(db, join(env.dataDir, 'wallpapers'), quota);
  const icons = new IconStore(db, join(env.dataDir, 'icons'), undefined, quota);
  // Icons uploaded before accounts existed were the single user's.
  const adopted = await icons.adoptUnowned(LEGACY_ADMIN_ID);
  if (adopted) console.log(`[nexus] ${adopted} 个早于 v0.4 上传的应用图标已归属管理员账号`);
  // Housekeeping: a failure is logged and retried at the next start, it never keeps the portal down.
  await cleanLegacyDaily({ db, dbFile, repo, store: wallpapers }).then(
    (r) => {
      if (r.removed || r.kept) console.log(`[nexus] 每日一图不再占用「我的壁纸」：移出 ${r.removed} 张自动生成的图片，保留 ${r.kept} 张收藏或使用中的图片${r.folder ? `；移出的文件暂存在 ${r.folder}，30 天后自动删除` : ''}`);
    },
    (e) => console.error('[nexus] 清理旧的每日一图失败，下次启动时重试', e),
  );
  const commons = new Commons();
  const sources = {
    gallery: new Gallery(wallpapers, commons, join(env.dataDir, 'gallery-previews')),
    daily: new Daily(wallpapers, commons, join(env.dataDir, 'daily-cache')),
    unsplash: new Unsplash(env.unsplashKey, wallpapers),
    // Imported wallpaper addresses must be public: they come from the internet, not the LAN.
    importPolicy: { allowPrivate: false, allowLoopback: false },
  };
  const devices = new Devices(db);
  const oidc = env.oidc
    ? new Oidc({ ...env.oidc, redirectUri: `${env.publicUrl}/auth/callback`, postLogoutRedirectUri: `${env.publicUrl}/`, allowHttp: !env.production })
    : null;
  const mail = env.mail ? new Outbox(db, createProvider(env.mail), { from: env.mail.from, replyTo: env.mail.replyTo }) : null;
  mail?.start();
  const app = createApp({
    env,
    repo,
    auth,
    users,
    intents: new LoginIntents(db),
    oidc,
    secrets: box,
    limiter: new LoginLimiter(),
    devices,
    pairings: new Pairings(devices),
    wallpapers,
    icons,
    health,
    iconProxy: new IconProxy(join(env.dataDir, 'icon-cache')),
    linkwarden: new Linkwarden(db, box, policy, undefined, LEGACY_ADMIN_ID),
    sources,
    mail,
  });
  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    const version = process.env.NEXUS_VERSION ? ` ${process.env.NEXUS_VERSION}` : '';
    console.log(`[nexus]${version} 已启动 http://${info.address}:${info.port} · 数据目录 ${env.dataDir} · 数据库 ${db.dialect === 'pg' ? 'PostgreSQL' : 'SQLite'}`);
    if (oidc) console.log(`[nexus] 统一身份：${env.oidc!.issuer}（注册：${env.registration}）`);
    if (env.generatedPassword) console.log(`[nexus] 开发模式临时密码：${env.password}（设置 NEXUS_PASSWORD 可固定）`);
    else if (result === 'set') console.log('[nexus] 访问密码已更新，管理员的旧会话和设备授权已失效');
    else if (result === 'upgraded') console.log('[nexus] 已将密码哈希升级为 Argon2id，现有登录不受影响');
    if (env.passwordHash && env.password) console.log('[nexus] 已设置 NEXUS_PASSWORD_HASH，忽略明文 NEXUS_PASSWORD：可以从 .env 中删除它');
    else if (env.password && !env.generatedPassword) console.log('[nexus] .env 中保存着明文密码：建议运行 deploy.sh 迁移为 NEXUS_PASSWORD_HASH');
    if (mail) console.log(`[nexus] 产品通知邮件：${mail.providerName}${mail.providerName === 'log' ? '（只记录，不真正发送）' : ''}`);
    if (!env.webDist) console.log('[nexus] 未找到前端构建产物，仅提供 API');
  });

  const shutdown = () => {
    health.stop();
    mail?.stop();
    server.close();
    void db.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e instanceof EnvError ? `[nexus] ${e.message}` : e);
  process.exit(1);
});
