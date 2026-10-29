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
}

export class EnvError extends Error {}

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
    allowPrivate: !['0', 'false'].includes(source.NEXUS_HEALTH_ALLOW_PRIVATE ?? ''),
    allowLoopback: ['1', 'true'].includes(source.NEXUS_HEALTH_ALLOW_LOOPBACK ?? ''),
    secret: source.NEXUS_SECRET?.trim() || null,
    unsplashKey: source.NEXUS_UNSPLASH_ACCESS_KEY?.trim() || null,
  };
}
