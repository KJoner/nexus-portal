import { randomBytes } from 'node:crypto';
import { isArgon2Hash } from './auth/password';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Env {
  production: boolean;
  host: string;
  port: number;
  dataDir: string;
  /** Argon2id PHC string from NEXUS_PASSWORD_HASH (v0.2.1, what deploy.sh writes). */
  passwordHash: string | null;
  /** Plain password from NEXUS_PASSWORD (older deployments); hashed into the database on start. */
  password: string | null;
  /** Generated for local development when no password is configured. */
  generatedPassword: boolean;
  /** `auto` sets Secure when the request arrived over https (directly or via a trusted proxy). */
  cookieSecure: 'auto' | 'always' | 'never';
  trustProxy: boolean;
  /** Extra origins allowed to write, for reverse proxies that rewrite the Host header. */
  allowedOrigins: string[];
  sessionDays: number;
  webDist: string | null;
  /** Health checks and integrations may reach LAN / Tailscale addresses (default on). */
  allowPrivate: boolean;
  /** …and loopback (default off: protects Nexus itself and local admin ports). */
  allowLoopback: boolean;
  /** Encrypts integration tokens at rest; a key file in the data directory is used when unset. */
  secret: string | null;
  /** Optional Unsplash access key (each deployment registers its own); stays on the server. */
  unsplashKey: string | null;
  /**
   * Public address of this deployment's LiteSync (v0.4). The 应用目录 offers LiteSync only when it
   * is set; it is never pinned for anyone.
   */
  litesyncUrl?: string | null;
  /** v0.4: PostgreSQL (public deployments). Unset: SQLite in the data directory (self-hosted). */
  databaseUrl?: string | null;
  /** v0.4: this deployment's own address (https), for OIDC callbacks and links in mail. */
  publicUrl?: string | null;
  /** v0.4: sign-in through the shared identity service (ADR-011); null keeps the single-user password. */
  oidc?: { issuer: string; clientId: string; clientSecret: string } | null;
  /** v0.4: who may create an account on first sign-in (enforced here, not only by the identity service). */
  registration?: 'closed' | 'invite' | 'open';
  /**
   * v0.4: the old access password. `auto`: available until the legacy administrator has claimed a
   * unified account (and always when OIDC is not configured); `on`/`off` force it.
   */
  legacyPasswordLogin?: 'auto' | 'on' | 'off';
  /** v0.4 product notification mail (ADR-018). Identity mail is sent by the identity service. */
  mail?: { provider: 'log' | 'smtp' | 'resend'; from: string; replyTo: string | null; smtpUrl: string | null; resendKey: string | null } | null;
}

export class EnvError extends Error {}

const httpsUrl = (v: string) => /^https:\/\/[^\s/?#]+/i.test(v);

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const production = source.NODE_ENV === 'production';
  const passwordHash = source.NEXUS_PASSWORD_HASH?.trim() || null;
  if (passwordHash && !isArgon2Hash(passwordHash)) throw new EnvError('NEXUS_PASSWORD_HASH 不是有效的 Argon2id 哈希：请用 deploy.sh --password 重新设置密码');
  let password = source.NEXUS_PASSWORD?.trim() || null;
  let generatedPassword = false;
  if (!password && !passwordHash && !production) {
    password = randomBytes(9).toString('base64url');
    generatedPassword = true;
  }
  if (password && password.length < 8) throw new EnvError('NEXUS_PASSWORD 至少需要 8 个字符');
  if (source.NEXUS_SECRET && source.NEXUS_SECRET.trim().length < 16) throw new EnvError('NEXUS_SECRET 至少需要 16 个字符');

  const litesyncUrl = source.NEXUS_LITESYNC_URL?.trim() || null;
  if (litesyncUrl && !/^https:\/\/[^\s/?#]+/i.test(litesyncUrl)) throw new EnvError('NEXUS_LITESYNC_URL 必须是 https:// 开头的完整地址');

  const publicUrl = source.NEXUS_PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
  const issuer = source.NEXUS_OIDC_ISSUER?.trim() || null;
  let oidc: Env['oidc'] = null;
  if (issuer) {
    const clientId = source.NEXUS_OIDC_CLIENT_ID?.trim();
    const clientSecret = source.NEXUS_OIDC_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new EnvError('配置了 NEXUS_OIDC_ISSUER 时，还需要 NEXUS_OIDC_CLIENT_ID 与 NEXUS_OIDC_CLIENT_SECRET');
    if (!publicUrl) throw new EnvError('配置了统一身份（NEXUS_OIDC_ISSUER）时，必须设置 NEXUS_PUBLIC_URL（回调地址由它生成）');
    if (production && (!httpsUrl(issuer) || !httpsUrl(publicUrl))) throw new EnvError('生产环境中 NEXUS_OIDC_ISSUER 与 NEXUS_PUBLIC_URL 必须使用 https');
    oidc = { issuer, clientId, clientSecret };
  }
  const registration = (source.NEXUS_REGISTRATION_MODE?.trim() || 'invite') as NonNullable<Env['registration']>;
  if (!['closed', 'invite', 'open'].includes(registration)) throw new EnvError('NEXUS_REGISTRATION_MODE 只能是 closed / invite / open');
  const legacy = (source.NEXUS_LEGACY_PASSWORD_LOGIN?.trim() || 'auto') as NonNullable<Env['legacyPasswordLogin']>;
  if (!['auto', 'on', 'off'].includes(legacy)) throw new EnvError('NEXUS_LEGACY_PASSWORD_LOGIN 只能是 auto / on / off');
  const databaseUrl = source.NEXUS_DATABASE_URL?.trim() || null;
  if (databaseUrl && !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new EnvError('NEXUS_DATABASE_URL 必须是 postgres:// 连接串');
  const provider = (source.NEXUS_MAIL_PROVIDER?.trim() || 'log') as 'log' | 'smtp' | 'resend';
  if (!['log', 'smtp', 'resend'].includes(provider)) throw new EnvError('NEXUS_MAIL_PROVIDER 只能是 log / smtp / resend');
  const mail: Env['mail'] = {
    provider,
    from: source.NEXUS_MAIL_FROM?.trim() || 'Nexus <no-reply@localhost>',
    replyTo: source.NEXUS_MAIL_REPLY_TO?.trim() || null,
    smtpUrl: source.NEXUS_SMTP_URL?.trim() || null,
    resendKey: source.NEXUS_RESEND_API_KEY?.trim() || null,
  };
  if (provider === 'smtp' && !mail.smtpUrl) throw new EnvError('NEXUS_MAIL_PROVIDER=smtp 需要 NEXUS_SMTP_URL');
  if (provider === 'resend' && !mail.resendKey) throw new EnvError('NEXUS_MAIL_PROVIDER=resend 需要 NEXUS_RESEND_API_KEY');

  const dist = source.NEXUS_WEB_DIST ?? resolve(import.meta.dirname, '../../web/dist');
  const cookie = source.NEXUS_COOKIE_SECURE ?? 'auto';
  if (!['auto', 'always', 'never'].includes(cookie)) throw new EnvError('NEXUS_COOKIE_SECURE 只能是 auto / always / never');

  return {
    production,
    host: source.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port: Number(source.PORT ?? 8787),
    dataDir: resolve(source.NEXUS_DATA_DIR ?? (production ? '/data' : resolve(import.meta.dirname, '../../../data'))),
    passwordHash,
    password,
    generatedPassword,
    cookieSecure: cookie as Env['cookieSecure'],
    trustProxy: source.NEXUS_TRUST_PROXY === '1' || source.NEXUS_TRUST_PROXY === 'true',
    allowedOrigins: (source.NEXUS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
    sessionDays: Number(source.NEXUS_SESSION_DAYS ?? 30),
    webDist: existsSync(resolve(dist, 'index.html')) ? dist : null,
    // Public (multi-account) deployments do not reach into private networks unless told to.
    allowPrivate: source.NEXUS_HEALTH_ALLOW_PRIVATE === undefined || source.NEXUS_HEALTH_ALLOW_PRIVATE === '' ? !oidc : !['0', 'false'].includes(source.NEXUS_HEALTH_ALLOW_PRIVATE),
    allowLoopback: ['1', 'true'].includes(source.NEXUS_HEALTH_ALLOW_LOOPBACK ?? ''),
    secret: source.NEXUS_SECRET?.trim() || null,
    unsplashKey: source.NEXUS_UNSPLASH_ACCESS_KEY?.trim() || null,
    litesyncUrl,
    databaseUrl,
    publicUrl,
    oidc,
    registration,
    legacyPasswordLogin: legacy,
    mail,
  };
}
