import { CLIENT_HEADER } from '@nexus/shared';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type Deps } from '../app';
import { Devices, Pairings } from '../auth/devices';
import { LoginIntents } from '../auth/intents';
import { Oidc } from '../auth/oidc';
import { IdentityStatus } from '../auth/identity-status';
import { Revocations, type PeerConfig } from '../auth/revocation';
import { LoginLimiter } from '../auth/rate-limit';
import { Auth } from '../auth/sessions';
import { ConfigRepo } from '../config/repo';
import { LEGACY_ADMIN_ID, type DB } from '../db';
import { testDb, type Dialect } from '../db/testing';
import type { Env } from '../env';
import { HealthChecker } from '../health/checker';
import { IconProxy } from '../icons/proxy';
import { IconStore } from '../icons/store';
import { Linkwarden } from '../integrations/linkwarden';
import { SecretBox } from '../integrations/secret';
import { LogProvider, Outbox } from '../mail/outbox';
import { Users } from '../users/users';
import { Commons, Daily, Gallery, Unsplash } from '../wallpapers/sources';
import { WallpaperStore } from '../wallpapers/store';
import { DEFAULT_LIMITS as DEFAULT_LIMITS_FOR_TESTS, RateLimiter, type BucketSpec, type LimitKind } from '../http/limits';
import { DEFAULT_QUOTAS, Quota, type AccountQuotas } from '../quota';
import type { FakeIdp } from './fake-idp';

export const PASSWORD = 'correct horse battery';
export const PUBLIC_URL = 'https://home.example.test';
export const write = { [CLIENT_HEADER]: '1', 'content-type': 'application/json' };

export interface TestApp {
  app: ReturnType<typeof createApp>;
  deps: Deps;
  db: DB;
  dir: string;
  mail: LogProvider;
  clock: { now: number };
  close(): Promise<void>;
  /** The legacy administrator's way in (old access password). Returns the cookie header value. */
  loginLegacy(): Promise<string>;
  /** Full OIDC round trip through the fake provider; returns the session cookie. */
  loginOidc(user: { sub: string; email?: string; name?: string; nickname?: string; preferredUsername?: string; sid?: string }, opts?: { returnTo?: string; invite?: string }): Promise<{ cookie: string; location: string }>;
}

const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

/**
 * The whole application on either database, as the server wires it (index.ts), with fakes only at
 * the edges: the identity provider, CDNs and image sources never touch the network.
 */
export async function buildTestApp(
  opts: {
    dialect?: Dialect;
    idp?: FakeIdp;
    registration?: 'closed' | 'invite' | 'open';
    legacyPasswordLogin?: 'auto' | 'on' | 'off';
    /** TN-07: limits of non-administrator accounts (default: the production defaults). */
    quotas?: AccountQuotas;
    /** TN-07: request allowances (default: the production defaults). */
    limits?: Partial<Record<LimitKind, BucketSpec>>;
    importFetch?: Deps['sources']['importFetch'];
    /** ADR-019 §2.4: the other product (its address, the shared secret) and how to reach it. */
    peer?: PeerConfig | null;
    peerFetch?: typeof fetch;
    /** ADR-019 §2.5: the central status check against the fake provider's admin API. */
    centralCheck?: boolean;
    sseRecheckMs?: number;
    /** UI v2 (N3): new accounts start with the starter sites, as in the server (default off here). */
    starterSites?: boolean;
  } = {},
): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-app-'));
  const db = await testDb(opts.dialect ?? 'sqlite');
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const env: Env = {
    production: false,
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    password: PASSWORD,
    generatedPassword: false,
    cookieSecure: 'auto',
    trustProxy: false,
    allowedOrigins: [],
    sessionDays: 30,
    webDist: null,
    allowPrivate: false,
    allowLoopback: false,
    secret: null,
    unsplashKey: null,
    passwordHash: null,
    publicUrl: PUBLIC_URL,
    oidc: opts.idp ? { issuer: opts.idp.issuer, clientId: opts.idp.clientId, clientSecret: opts.idp.clientSecret } : null,
    registration: opts.registration ?? 'open',
    legacyPasswordLogin: opts.legacyPasswordLogin ?? 'auto',
    quotas: opts.quotas ?? DEFAULT_QUOTAS,
  };
  const auth = new Auth(db, 30, now);
  await auth.ensurePassword({ hash: null, plain: PASSWORD });
  const itemUsers = new Users(db, now);
  const repo = new ConfigRepo(db, undefined, async (id) => ((await itemUsers.get(id))?.isAdmin ? null : (opts.quotas ?? DEFAULT_QUOTAS).items), now, { starterSites: !!opts.starterSites });
  const health = new HealthChecker(db, repo, { allowPrivate: false, allowLoopback: false }, async () => ({ reached: true, status: 200, latencyMs: 5, message: 'HTTP 200' }), LEGACY_ADMIN_ID);
  const users = new Users(db, now);
  const quota = new Quota(db, { wallpapers: join(dir, 'wallpapers'), icons: join(dir, 'icons') }, async (id) => ((await users.get(id))?.isAdmin ? null : (opts.quotas ?? env.quotas ?? null)));
  const wallpapers = new WallpaperStore(db, join(dir, 'wallpapers'), quota);
  const commons = new Commons(async () => new Response(null, { status: 503 }));
  const devices = new Devices(db, now);
  const secrets = new SecretBox(randomBytes(32));
  const mail = new LogProvider();
  const oidc = opts.idp ? new Oidc({ issuer: opts.idp.issuer, clientId: opts.idp.clientId, clientSecret: opts.idp.clientSecret, redirectUri: `${PUBLIC_URL}/auth/callback`, postLogoutRedirectUri: `${PUBLIC_URL}/`, fetch: opts.idp.fetch }) : null;
  const pairings = new Pairings(devices, now);
  const revocations = new Revocations({ db, users, devices, pairings, oidc, secrets, now, peer: opts.peer ?? null, peerFetch: opts.peerFetch });
  const identity = oidc && opts.centralCheck && opts.idp ? new IdentityStatus({ oidc, adminUrl: opts.idp.adminUrl, users, revocations, now }) : null;
  const deps: Deps = {
    env,
    repo,
    auth,
    users,
    intents: new LoginIntents(db, now),
    oidc,
    secrets,
    limiter: new LoginLimiter(),
    devices,
    pairings,
    revocations,
    identity,
    sseRecheckMs: opts.sseRecheckMs,
    wallpapers,
    icons: new IconStore(db, join(dir, 'icons'), now, quota),
    limits: new RateLimiter({ ...DEFAULT_LIMITS_FOR_TESTS, ...opts.limits }, now),
    health,
    iconProxy: new IconProxy(join(dir, 'icon-cache'), (async () => new Response(null, { status: 404 })) as typeof fetch),
    linkwarden: new Linkwarden(db, secrets, { allowPrivate: false, allowLoopback: false }, undefined, LEGACY_ADMIN_ID),
    sources: { gallery: new Gallery(wallpapers, commons, join(dir, 'previews'), []), daily: new Daily(wallpapers, commons, join(dir, 'daily-cache')), unsplash: new Unsplash(null, wallpapers), importPolicy: { allowPrivate: false, allowLoopback: false }, ...(opts.importFetch ? { importFetch: opts.importFetch } : {}) },
    mail: new Outbox(db, mail, { from: 'Nexus <no-reply@mail.example.test>', replyTo: null }, now),
    now,
  };
  const app = createApp(deps);
  const t: TestApp = {
    app,
    deps,
    db,
    dir,
    mail,
    clock,
    async close() {
      health.stop();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async loginLegacy() {
      const res = await app.request('/api/auth/login', { method: 'POST', headers: write, body: JSON.stringify({ password: PASSWORD }) });
      if (res.status !== 200) throw new Error(`legacy login failed: ${res.status}`);
      return cookieOf(res, 'nexus_session')!;
    },
    async loginOidc(user, o = {}) {
      if (!opts.idp) throw new Error('no identity provider');
      const q = new URLSearchParams();
      if (o.returnTo) q.set('returnTo', o.returnTo);
      if (o.invite) q.set('invite', o.invite);
      const start = await app.request(`/auth/login?${q}`);
      const intent = cookieOf(start, 'nexus_oidc');
      const auth = new URL(start.headers.get('location')!);
      const code = opts.idp.authorize(auth, user);
      const cb = await app.request(`/auth/callback?code=${code}&state=${auth.searchParams.get('state')}`, { headers: { cookie: intent ?? '' } });
      return { cookie: cookieOf(cb, 'nexus_session') ?? '', location: cb.headers.get('location') ?? '' };
    },
  };
  return t;
}

export { cookieOf };
