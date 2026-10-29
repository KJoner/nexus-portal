import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Env {
  production: boolean;
  host: string;
  port: number;
  dataDir: string;
  /** Plain password from NEXUS_PASSWORD; hashed into the database on start. */
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
}

export class EnvError extends Error {}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const production = source.NODE_ENV === 'production';
  let password = source.NEXUS_PASSWORD?.trim() || null;
  let generatedPassword = false;
  if (!password && !production) {
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
  };
}
