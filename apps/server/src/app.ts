import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { AppSchema, DEVICE_SCOPE_LABELS, DEVICE_TOKEN, isDeviceScope, OpBatchSchema, OpError, PAIR_CODE, validateApp, type CatalogResponse, type ConfigResponse, type DeviceScope, type AdminRevocationStatus, type LogoutAllResponse, type RevocationStatusResponse, type RevokeEverywhereResponse, type WallpaperSourcesResponse, CONFLICT_CODES, CONFLICT_HTTP_CODE } from '@nexus/shared';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { PairingError, type DeviceAuth, type Devices, type Pairings } from './auth/devices';
import { LoginIntents, safeReturnTo } from './auth/intents';
import { OidcError, type Oidc } from './auth/oidc';
import type { IdentityStatus } from './auth/identity-status';
import { Revocations } from './auth/revocation';
import type { LoginLimiter } from './auth/rate-limit';
import type { Auth, Session } from './auth/sessions';
import { CatalogCursorError, CatalogService } from './catalog/service';
import type { ConfigRepo } from './config/repo';
import { LEGACY_ADMIN_ID } from './db';
import type { Env } from './env';
import type { HealthChecker } from './health/checker';
import { apiError, csrf, headers, isHttps, opConflict, quotaExceeded, rateLimited, v2Error } from './http/security';
import { RateLimiter, type LimitKind } from './http/limits';
import { DEFAULT_QUOTAS, QuotaExceededError } from './quota-types';
import { registerItemsApi } from './items/api';
import { isValidIconKey, type IconProxy, type IconSource } from './icons/proxy';
import { IconError, MAX_ICON_BYTES, type IconStore } from './icons/store';
import { LinkwardenError, type Linkwarden } from './integrations/linkwarden';
import type { SecretBox } from './integrations/secret';
import { fetchSuggestions } from './integrations/suggest';
import type { Outbox } from './mail/outbox';
import type { getBytes } from './net/http';
import type { NetPolicy } from './net/ip';
import type { User, Users } from './users/users';
import { importFromUrl, SourceError, type Daily, type Ensured, type Gallery, type Unsplash } from './wallpapers/sources';
import { MAX_UPLOAD_BYTES, WallpaperError, type WallpaperStore } from './wallpapers/store';

export interface Deps {
  env: Env;
  repo: ConfigRepo;
  auth: Auth;
  /** v0.4 accounts. */
  users: Users;
  /** v0.4 OIDC sign-ins in progress. */
  intents: LoginIntents;
  /** v0.4 relying party; absent when the deployment keeps the single-user password. */
  oidc?: Oidc | null;
  /** Encrypts refresh tokens and ID tokens kept with OIDC sessions. */
  secrets: SecretBox;
  limiter: LoginLimiter;
  devices: Devices;
  pairings: Pairings;
  wallpapers: WallpaperStore;
  icons: IconStore;
  health: HealthChecker;
  iconProxy: IconProxy;
  linkwarden: Linkwarden;
  suggestFetch?: typeof fetch;
  /** TN-07 request limits (per account / device / client address). */
  limits?: RateLimiter;
  sources: WallpaperSources;
  /** Public 应用目录; built from the bundled catalog and the deployment's LiteSync address when omitted. */
  catalog?: CatalogService;
  /** Product notification mail (null: none sent). */
  mail?: Outbox | null;
  /** ADR-019 account revocation (built from the other parts when omitted). */
  revocations?: Revocations;
  /** ADR-019 §2.5 中心停用检查; absent when not configured (NEXUS_IDENTITY_STATUS_CHECK). */
  identity?: IdentityStatus | null;
  /** How often an open event stream re-checks its session (ADR-019 §2.6: 15 s; tests shorten it). */
  sseRecheckMs?: number;
  now?: () => number;
}

/** v0.2 wallpaper sources. Remote imports use their own, stricter network policy (public only). */
export interface WallpaperSources {
  gallery: Gallery;
  daily: Daily;
  unsplash: Unsplash;
  importPolicy: NetPolicy;
  importFetch?: typeof getBytes;
}

type Vars = { user: User; session: Session; device: DeviceAuth; viaDevice: boolean };

const COOKIE = 'nexus_session';
const INTENT_COOKIE = 'nexus_oidc';
const LoginSchema = z.object({ password: z.string().min(1).max(256) });
const PairStartSchema = z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.string().max(32)).max(8).optional() });
const PairPollSchema = z.object({ pairId: z.string().min(1).max(64), secret: z.string().min(1).max(128) });
const DecideSchema = z.object({ approve: z.boolean(), scopes: z.array(z.string().max(32)).max(8).optional() });
/** OIDC sessions are re-checked with the identity provider this often… */
const REVALIDATE_MS = 5 * 60_000;
/** …and survive an unreachable provider this long before they end. */
const REVALIDATE_GRACE_MS = 60 * 60_000;

/** Weak comparison (RFC 9110): proxies such as Cloudflare turn strong ETags weak when they compress. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

export function createApp(deps: Deps) {
  const { env, repo, auth, users, intents, oidc = null, secrets, limiter, devices, pairings, wallpapers, icons, health, iconProxy, linkwarden, suggestFetch, sources, mail = null } = deps;
  const limits = deps.limits ?? new RateLimiter();
  const catalog = deps.catalog ?? new CatalogService({ litesyncUrl: env.litesyncUrl ?? null });
  const now = deps.now ?? Date.now;
  const revocations = deps.revocations ?? new Revocations({ db: repo.db, users, devices, pairings, oidc, secrets, now });
  const identity = deps.identity ?? null;
  const sseRecheckMs = deps.sseRecheckMs ?? 15_000;
  /** Device requests past the identity service's grace (ADR-019 §2.5): retryable, the client keeps its queue. */
  const identityUnavailable = (c: Context) => {
    c.header('Retry-After', '60');
    return v2Error(c, 503, 'IDENTITY_UNAVAILABLE', '暂时无法向账号中心确认这个账号的状态，请稍后重试（未发送的内容已保留）', { retryable: true });
  };
  const app = new Hono<{ Variables: Vars }>();

  const clientKey = (c: Context) => {
    if (env.trustProxy) {
      // The trusted proxy appends the address it saw; entries to its left come from the client
      // and can be forged (which would let anyone sidestep the per-address login limit).
      const fwd = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const secure = (c: Context) => env.cookieSecure === 'always' || (env.cookieSecure === 'auto' && isHttps(c, env));
  const setSession = (c: Context, token: string, maxAge: number) => setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secure(c), path: '/', maxAge });

  /**
   * The old access password is the legacy administrator's way in — and the way to claim a unified
   * account. Once that account is claimed (and OIDC is on), it closes unless forced open.
   */
  const legacyPasswordAvailable = async () => {
    if (env.legacyPasswordLogin === 'off') return false;
    if (!(await auth.hasPassword())) return false;
    if (env.legacyPasswordLogin === 'on' || !oidc) return true;
    const admin = await users.get(LEGACY_ADMIN_ID);
    return !admin?.issuer;
  };

  const configResponse = async (ownerId: string): Promise<ConfigResponse> => ({ ...(await repo.snapshot(ownerId)), wallpapers: await wallpapers.list(ownerId) });
  const notify = async (user: User, key: string, template: 'device-authorized' | 'signed-out-everywhere' | 'signed-out-all-products', data: Record<string, string> = {}) => {
    if (!mail || !user.email || !user.emailVerified) return;
    await mail.enqueue(key, template, user.email, data).catch((e) => console.error('[nexus] 邮件入队失败', e));
  };

  // Read-only handlers shared by the portal (session) and paired devices (/api/sync, token).
  const lwError = (c: Context, e: unknown) => {
    if (!(e instanceof LinkwardenError)) throw e;
    const status = e.code === 'not_configured' ? 404 : e.code === 'invalid' ? 400 : 422;
    return apiError(c, status, e.code, e.message);
  };
  const SOURCE_STATUS = { not_found: 404, invalid: 400, blocked: 422, license: 422, not_configured: 404, unavailable: 502, too_large: 413 } as const;
  const sourceError = (c: Context, e: unknown) => {
    if (e instanceof SourceError) return apiError(c, SOURCE_STATUS[e.code], e.code, e.message);
    if (e instanceof WallpaperError) return apiError(c, e.code === 'too_large' ? 413 : 415, e.code, e.message);
    throw e;
  };
  /** Operator tools (health checks, Linkwarden) are administrator-only in data and in routes. */
  const read = {
    status: async (c: Context, admin: boolean) => c.json(admin ? await health.list() : []),
    bookmarks: async (c: Context, admin: boolean) => {
      const q = (c.req.query('q') ?? '').trim();
      if (!admin) return apiError(c, 404, 'not_configured', '尚未连接 Linkwarden');
      if (!q) return c.json({ bookmarks: [] });
      try {
        return c.json({ bookmarks: await linkwarden.search(q) });
      } catch (e) {
        return lwError(c, e);
      }
    },
    /** 搜索建议 — off unless the user enabled it; failures just mean no suggestions. */
    suggest: async (c: Context, ownerId: string) => {
      if (!(await repo.snapshot(ownerId)).config.settings.search.suggest) return apiError(c, 403, 'disabled', '搜索建议未开启');
      const q = (c.req.query('q') ?? '').trim();
      if (!q) return c.json({ suggestions: [] });
      try {
        return c.json({ suggestions: await fetchSuggestions(c.req.query('engine') ?? '', q, suggestFetch) });
      } catch {
        return c.json({ suggestions: [] });
      }
    },
    wallpaperSources: async (c: Context, ownerId: string) => c.json({ gallery: await sources.gallery.list(ownerId), unsplash: sources.unsplash.configured } satisfies WallpaperSourcesResponse),
    /** Reads a cache, never the configuration: a new day costs no revision and no sync. */
    daily: async (c: Context) => {
      try {
        return c.json(await sources.daily.current());
      } catch (e) {
        return sourceError(c, e);
      }
    },
    wallpaperFile: async (c: Context, ownerId: string) => {
      const id = c.req.param('id')!;
      const file = c.req.param('file')!;
      // The day's public picture is the same for everyone; library pictures are the account's own.
      const path = (await wallpapers.filePath(ownerId, id, file)) ?? sources.daily.filePath(id, file);
      if (!path) return apiError(c, 404, 'not_found', '壁纸不存在');
      const ext = path.slice(path.lastIndexOf('.') + 1);
      c.header('Content-Type', ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
      // Ids are never reused, so variants are immutable — but private to this account.
      c.header('Cache-Control', 'private, max-age=31536000, immutable');
      return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
    },
    icon: async (c: Context, ownerId: string) => {
      const path = await icons.filePath(ownerId, c.req.param('file')!.replace(/\.png$/, ''));
      if (!path || !existsSync(path)) return apiError(c, 404, 'not_found', '图标不存在');
      c.header('Content-Type', 'image/png');
      c.header('Cache-Control', 'private, max-age=31536000, immutable');
      return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
    },
    /** Cached brand icons: …/icon-cache/{di|si}/<slug>, …/icon-cache/fav/<host>. Public data. */
    iconCache: async (c: Context) => {
      const source = c.req.param('source') as IconSource;
      const key = c.req.param('key')!.toLowerCase();
      if (!['di', 'si', 'fav'].includes(source) || !isValidIconKey(source, key)) return apiError(c, 400, 'invalid', '图标名称不正确');
      try {
        const icon = await iconProxy.get(source, key);
        if (icon.status === 404) {
          c.header('Cache-Control', 'private, max-age=3600');
          return apiError(c, 404, 'not_found', '图标不存在');
        }
        c.header('Content-Type', icon.type);
        c.header('Cache-Control', 'private, max-age=86400');
        return c.body(new Uint8Array(icon.body));
      } catch {
        c.header('Cache-Control', 'no-store');
        return c.json({ error: { code: 'unavailable', message: '图标源暂时不可用' } }, 502);
      }
    },
  };

  // Registered before the global headers so this runs last and wins: an icon SVG opened
  // directly must not execute anything.
  const sandboxed: MiddlewareHandler = async (c, next) => {
    await next();
    c.res.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  };
  app.use('/api/icon-cache/*', sandboxed);
  app.use('/api/sync/icon-cache/*', sandboxed);
  app.use('*', headers());
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store');
  });
  app.use('/auth/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('/api/*', csrf(env));

  // ── TN-07: what anyone may call without an account is limited per client address ──
  const byClient =
    (kind: LimitKind): MiddlewareHandler =>
    async (c, next) => {
      const wait = limits.take(kind, clientKey(c));
      if (!wait) return next();
      // Sign-in pages are browser navigations: answer with the login page and a reason, not JSON.
      return kind === 'auth' ? c.redirect('/?auth_error=rate_limited', 302) : rateLimited(c, wait, kind);
    };
  app.use('/api/v2/catalog', byClient('public'));
  app.use('/api/v2/auth/options', byClient('public'));
  app.use('/api/pair/poll', byClient('public'));
  app.use('/api/internal/*', byClient('internal'));
  app.use('/auth/login', byClient('auth'));
  app.use('/auth/link/start', byClient('auth'));

  app.get('/api/healthz', (c) => c.json({ ok: true }));

  /**
   * ADR-019 §2.4 · 另一个产品的撤销事件（服务端到服务端）. Authenticated by its HMAC signature, not by a
   * session: 200 handled (also for a repeated event, and for an identity this product does not
   * know), 400 malformed, 401 signature or timestamp wrong (the sender does not retry those).
   */
  app.post('/api/internal/v1/account-revocations', bodyLimit({ maxSize: 4096, onError: (c) => v2Error(c, 400, 'INVALID_EVENT', '事件过大') }), async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const r = await revocations.receive(raw, { timestamp: c.req.header('x-revocation-timestamp'), signature: c.req.header('x-revocation-signature') });
    return c.json(r.body, r.status);
  });

  // ── 应用目录 (v0.4): public templates, the same for every visitor ─────────
  // Deliberately before the session gate: the catalog holds no private data and the
  // registration page and new accounts browse it too. Filtering of private templates happens
  // when the catalog is built (see servedCatalog), not per request.
  app.get('/api/v2/catalog', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    c.header('ETag', catalog.etag);
    if (etagMatches(c.req.header('if-none-match'), catalog.etag)) return c.body(null, 304);
    const limit = c.req.query('limit');
    try {
      return c.json(catalog.query({ q: c.req.query('q'), category: c.req.query('category'), cursor: c.req.query('cursor') || undefined, limit: limit ? Number(limit) : undefined }) satisfies CatalogResponse);
    } catch (e) {
      if (e instanceof CatalogCursorError) return v2Error(c, 400, 'INVALID_CURSOR', e.message);
      throw e;
    }
  });

  // ── Auth ────────────────────────────────────────────────────────────────
  /** How this deployment signs people in (the login page asks before showing anything). */
  app.get('/api/v2/auth/options', async (c) =>
    c.json({
      oidc: !!oidc,
      legacyPassword: await legacyPasswordAvailable(),
      registration: oidc ? (env.registration ?? 'invite') : 'closed',
      // ?referrer: the account center shows 「回到 Nexus Portal」 (Keycloak, back to the client's base URL).
      accountUrl: oidc ? `${oidc.settings.issuer.replace(/\/+$/, '')}/account?referrer=${encodeURIComponent(oidc.settings.clientId)}` : null,
    }),
  );

  app.get('/api/auth/session', async (c) => c.json({ authenticated: (await auth.validate(getCookie(c, COOKIE))).valid }));

  /** The old access password (the legacy administrator's account). */
  app.post('/api/auth/login', bodyLimit({ maxSize: 4096 }), async (c) => {
    const key = clientKey(c);
    const wait = limiter.retryAfter(key);
    if (wait) {
      c.header('Retry-After', String(wait));
      return rateLimited(c, wait, 'login', `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`);
    }
    if (!(await legacyPasswordAvailable())) return apiError(c, 403, 'legacy_login_disabled', '此部署已改用统一账号登录');
    const body = LoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid', '请输入密码');
    if (!(await auth.checkPassword(body.data.password))) {
      limiter.fail(key);
      return apiError(c, 401, 'bad_password', '密码不正确');
    }
    limiter.succeed(key);
    const { token, maxAgeSec } = await auth.createSession(LEGACY_ADMIN_ID, c.req.header('user-agent') ?? '');
    setSession(c, token, maxAgeSec);
    return c.json({ authenticated: true });
  });

  /** 退出当前产品: this browser's Nexus session only (the identity service and LiteSync stay signed in). */
  app.post('/api/auth/logout', async (c) => {
    await auth.revoke(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ authenticated: false });
  });

  // ── OIDC (browser navigations, not API calls) ───────────────────────────
  const startOidc = async (c: Context, kind: 'login' | 'link', opts: { returnTo?: string; invite?: string; linkUserId?: string }) => {
    if (!oidc) return c.redirect('/', 302);
    const intent = await intents.create(kind, opts);
    let url: URL;
    try {
      url = await oidc.authorizationUrl({ state: intent.state, nonce: intent.nonce, codeChallenge: intent.codeChallenge, prompt: kind === 'link' ? 'login' : undefined });
    } catch {
      return c.redirect('/?auth_error=unavailable', 302);
    }
    setCookie(c, INTENT_COOKIE, intent.token, { httpOnly: true, sameSite: 'Lax', secure: secure(c), path: '/auth', maxAge: intent.maxAgeSec });
    return c.redirect(url.toString(), 302);
  };

  app.get('/auth/login', (c) => startOidc(c, 'login', { returnTo: c.req.query('returnTo'), invite: c.req.query('invite') }));

  /** 旧管理员认领: only from a session opened with the old password, for an account not yet bound. */
  app.get('/auth/link/start', async (c) => {
    const v = await auth.validate(getCookie(c, COOKIE));
    if (!v.valid || v.session.kind !== 'password') return c.redirect('/?auth_error=link_requires_password', 302);
    const user = await users.get(v.session.userId);
    if (!user || user.issuer) return c.redirect('/settings/account?auth_error=already_linked', 302);
    return startOidc(c, 'link', { returnTo: '/settings/account?linked=1', linkUserId: user.id });
  });

  app.get('/auth/callback', async (c) => {
    const intent = await intents.consume(getCookie(c, INTENT_COOKIE), c.req.query('state'));
    deleteCookie(c, INTENT_COOKIE, { path: '/auth' });
    if (!oidc) return c.redirect('/', 302);
    if (!intent) return c.redirect('/?auth_error=state', 302);
    if (c.req.query('error')) return c.redirect(`/?auth_error=${c.req.query('error') === 'access_denied' ? 'access_denied' : 'idp_error'}`, 302);
    let signed: Awaited<ReturnType<Oidc['exchange']>>;
    try {
      // The registered public callback, not the address the request reached us on (a reverse
      // proxy's upstream): redirect_uri must match exactly at the token endpoint.
      const callback = new URL(`${oidc.settings.redirectUri}${new URL(c.req.url).search}`);
      signed = await oidc.exchange(callback, intent);
    } catch (e) {
      // Only the category is logged: never the code, tokens or claims.
      console.warn(`[nexus] 统一身份回调被拒绝（${e instanceof OidcError ? e.code : 'error'}）`);
      return c.redirect(`/?auth_error=${e instanceof OidcError && e.code === 'unavailable' ? 'unavailable' : 'rejected'}`, 302);
    }
    let user: User;
    if (intent.kind === 'link') {
      const r = await users.link(intent.linkUserId!, signed.claims);
      if (r !== 'linked' && r !== 'already_linked') return c.redirect(`/settings/account?auth_error=${r}`, 302);
      console.log(`[nexus] 账号认领：${intent.linkUserId} 已绑定统一身份`);
      user = (await users.get(intent.linkUserId!))!;
      // The old way in may close now (legacy login `auto`); this browser continues with the new identity.
      await auth.revoke(getCookie(c, COOKIE));
    } else {
      const r = await users.signIn(signed.claims, env.registration ?? 'invite', intent.invite);
      if (!r.ok) return c.redirect(`/?auth_error=${r.reason}`, 302);
      user = r.user;
    }
    const { token, maxAgeSec } = await auth.createSession(user.id, c.req.header('user-agent') ?? '', {
      kind: 'oidc',
      oidcSid: signed.sid,
      refreshEnc: signed.refreshToken ? secrets.seal(signed.refreshToken) : null,
      idTokenEnc: secrets.seal(signed.idToken),
      revalidateAt: now() + REVALIDATE_MS,
    });
    setSession(c, token, maxAgeSec);
    return c.redirect(intent.returnTo, 302);
  });

  /** OIDC Back-Channel Logout: the identity service ends sessions here (server to server). */
  app.post('/auth/backchannel-logout', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    if (!oidc) return c.body(null, 404);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof form.logout_token === 'string' ? form.logout_token : '';
    try {
      const { sub, sid } = await oidc.verifyLogoutToken(token);
      if (sid) await auth.revokeBySid(sid);
      else if (sub) {
        const user = await users.byIdentity(oidc.settings.issuer, sub);
        if (user) await auth.revokeAllForUser(user.id);
      }
      return c.body(null, 200);
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
  });
  /** /auth/* belongs to the server (NEX-01): an unknown path there is not an app page. */
  app.all('/auth/*', (c) => c.text('未找到', 404));

  // ── Paired devices (browser extension): pairing, then sync with a device token ──
  // Never reads the session cookie. The extension calls from an extension origin, which is why
  // csrf() skips the Origin check for these two prefixes (the client header still applies).
  app.post('/api/pair/start', bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = PairStartSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid', '缺少设备名称');
    const scopes = (body.data.scopes ?? ['config:read']).filter(isDeviceScope);
    try {
      return c.json(pairings.start(body.data.name, clientKey(c), c.req.header('user-agent') ?? '', scopes), 201);
    } catch (e) {
      if (e instanceof PairingError) {
        c.header('Retry-After', '60');
        return apiError(c, 429, e.code, e.message);
      }
      throw e;
    }
  });

  app.post('/api/pair/poll', bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = PairPollSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid', '请求格式不正确');
    return c.json(await pairings.poll(body.data.pairId, body.data.secret));
  });

  app.use('/api/sync/*', async (c, next) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    const device = token && DEVICE_TOKEN.test(token) ? await devices.validate(token) : null;
    if (!device) return apiError(c, 401, 'device_unauthorized', '此设备的授权已失效或已被撤销');
    // ADR-019 §2.5: an account stopped or deleted in the identity service loses its devices here.
    const owner = identity ? await users.get(device.ownerId) : null;
    const verdict = owner && identity ? await identity.check(owner, 'device') : 'ok';
    if (verdict === 'revoked') return apiError(c, 401, 'device_unauthorized', '此设备的授权已失效或已被撤销');
    if (verdict === 'unavailable') return identityUnavailable(c);
    c.set('device', device);
    // TN-07: each paired device has its own allowance.
    const kind: LimitKind = c.req.path === '/api/sync/suggest' || c.req.path === '/api/sync/bookmarks' ? 'suggest' : 'read';
    const wait = limits.take(kind, `device:${device.id}`);
    return wait ? rateLimited(c, wait, kind) : next();
  });
  /** Every /api/sync read needs config:read; tokens without it (none exist yet) get nothing here. */
  const syncScope = (c: Context<{ Variables: Vars }>, scope: DeviceScope) => c.get('device').scopes.includes(scope);
  const syncOwner = async (c: Context<{ Variables: Vars }>) => {
    const d = c.get('device');
    return { ownerId: d.ownerId, admin: !!(await users.get(d.ownerId))?.isAdmin };
  };
  app.use('/api/sync/*', async (c, next) => (c.req.path === '/api/sync/revoke' || syncScope(c, 'config:read') ? next() : apiError(c, 403, 'scope_required', '此设备没有读取导航的权限')));

  /** Conditional GET: an unchanged configuration costs one tiny 304 instead of the whole document. */
  app.get('/api/sync/config', async (c) => {
    const { ownerId } = await syncOwner(c);
    // Revision plus write time: a restored backup that reuses a revision number still differs.
    const tag = (v: { revision: number; updatedAt: string }) => `"${v.revision}-${Date.parse(v.updatedAt).toString(36)}"`;
    const current = tag(await repo.version(ownerId));
    if (etagMatches(c.req.header('if-none-match'), current)) {
      c.header('ETag', current);
      return c.body(null, 304);
    }
    const res = await configResponse(ownerId);
    c.header('ETag', tag(res));
    return c.json(res);
  });
  app.get('/api/sync/status', async (c) => read.status(c, (await syncOwner(c)).admin));
  app.get('/api/sync/bookmarks', async (c) => read.bookmarks(c, (await syncOwner(c)).admin));
  app.get('/api/sync/suggest', async (c) => read.suggest(c, (await syncOwner(c)).ownerId));
  app.get('/api/sync/wallpaper-sources', async (c) => read.wallpaperSources(c, (await syncOwner(c)).ownerId));
  app.get('/api/sync/daily', (c) => read.daily(c));
  app.get('/api/sync/wallpapers/:id/:file', async (c) => read.wallpaperFile(c, (await syncOwner(c)).ownerId));
  app.get('/api/sync/icons/:file', async (c) => read.icon(c, (await syncOwner(c)).ownerId));
  app.get('/api/sync/icon-cache/:source/:key', (c) => read.iconCache(c));
  /** 断开连接 in the extension revokes its own token. */
  app.post('/api/sync/revoke', async (c) => {
    const d = c.get('device');
    await devices.revoke(d.ownerId, d.id);
    return c.json({ revoked: true });
  });
  app.all('/api/sync/*', (c) => apiError(c, 404, 'not_found', '接口不存在'));

  // 我的收藏 v2 (契约 §6): a paired device may call these with its own token, within its scopes.
  const ITEMS_API = /^\/api\/v2\/(items|pins|snapshot|changes|folders)(\/|$)/;
  app.use('/api/v2/*', async (c, next) => {
    const header = c.req.header('authorization');
    if (!header || !ITEMS_API.test(c.req.path)) return next();
    const token = /^Bearer (\S+)$/.exec(header)?.[1];
    const device = token && DEVICE_TOKEN.test(token) ? await devices.validate(token) : null;
    const user = device ? await users.get(device.ownerId) : null;
    if (!device || !user || user.disabled) return v2Error(c, 401, 'DEVICE_REVOKED', '此设备的授权已失效或已被撤销，请在扩展中重新连接');
    const verdict = identity ? await identity.check(user, 'device') : 'ok';
    if (verdict === 'revoked') return v2Error(c, 401, 'DEVICE_REVOKED', '此设备的授权已失效或已被撤销，请在扩展中重新连接');
    if (verdict === 'unavailable') return identityUnavailable(c);
    c.set('device', device);
    c.set('user', user);
    c.set('viaDevice', true);
    return next();
  });

  // Everything else under /api needs a session, which names the account.
  app.use('/api/*', async (c, next) => {
    if (c.get('viaDevice')) return next();
    const token = getCookie(c, COOKIE);
    const v = await auth.validate(token);
    if (!v.valid) return apiError(c, 401, 'unauthenticated', '需要登录');
    const user = await users.get(v.session.userId);
    if (!user || user.disabled) {
      await auth.revokeById(v.session.idHash);
      deleteCookie(c, COOKIE, { path: '/' });
      return apiError(c, 401, user?.disabled ? 'account_disabled' : 'unauthenticated', user?.disabled ? '此账号已被停用' : '需要登录');
    }
    // ADR-019 §2.5: stopped or deleted in the identity service → 动作 B here, this session included.
    // Unreachable is not an answer: web sessions keep the refresh re-check below (ADR-011).
    if (identity && (await identity.check(user, 'session')) === 'revoked') {
      deleteCookie(c, COOKIE, { path: '/' });
      return apiError(c, 401, 'session_ended', '这个账号已在账号中心停用或删除，登录已失效');
    }
    // OIDC sessions are re-checked with the identity provider: a disabled account or a sign-out
    // elsewhere ends this session within REVALIDATE_MS, not at cookie expiry.
    const s = v.session;
    if (s.kind === 'oidc' && oidc && s.revalidateAt !== null && s.revalidateAt <= now()) {
      const refresh = s.refreshEnc ? safeOpen(secrets, s.refreshEnc) : null;
      const r = refresh ? await oidc.refresh(refresh) : ({ ok: false, reason: 'invalid' } as const);
      if (r.ok) {
        await auth.markRevalidated(s.idHash, now() + REVALIDATE_MS, r.refreshToken ? secrets.seal(r.refreshToken) : undefined);
        // The provider honoured the refresh: the account is enabled there right now.
        await users.markIdentityChecked(user.id, now());
      }
      else if (r.reason === 'invalid' || now() - s.revalidateAt > REVALIDATE_GRACE_MS) {
        await auth.revokeById(s.idHash);
        deleteCookie(c, COOKIE, { path: '/' });
        return apiError(c, 401, 'session_ended', '登录已失效，请重新登录');
      }
    }
    if (v.renewed && token) setSession(c, token, env.sessionDays * 86_400);
    c.set('user', user);
    c.set('session', s);
    return next();
  });

  // ── TN-07: per-account request limits ─────────────────────────────────────
  // Separate allowances per account, so one account's flood or slow upstream never slows another.
  const UPLOADS: [string, RegExp][] = [
    ['POST', /^\/api\/wallpapers$/],
    ['POST', /^\/api\/icons$/],
  ];
  /** Requests that make this server fetch from elsewhere: a `fetch` token and an in-flight slot. */
  const FETCHING: [string, RegExp][] = [
    ['POST', /^\/api\/wallpapers\/import$/],
    ['POST', /^\/api\/gallery\/[^/]+$/],
    ['POST', /^\/api\/daily\/[^/]+\/keep$/],
    ['POST', /^\/api\/unsplash\/[^/]+$/],
    ['POST', /^\/api\/health\/test$/],
    ['POST', /^\/api\/status\/[^/]+\/check$/],
    ['PUT', /^\/api\/integrations\/linkwarden$/],
  ];
  /** Images the pages show by the dozen (icons, wallpaper variants): cached, cheap, never limited. */
  const IMAGES = /^\/api\/(icon-cache\/|icons\/[^/]+$|wallpapers\/[^/]+\/[^/]+$|daily\/[^/]+\/[^/]+$|gallery\/[^/]+\/preview)/;
  app.use('/api/*', async (c, next) => {
    const user = c.get('user');
    const who = `acct:${user.id}`;
    const { method, path } = c.req;
    if ((method === 'GET' || method === 'HEAD') && IMAGES.test(path)) return next();
    const is = (list: [string, RegExp][]) => list.some(([m, re]) => m === method && re.test(path));
    const kind: LimitKind = is(UPLOADS) ? 'upload' : is(FETCHING) ? 'fetch' : path === '/api/suggest' || path === '/api/bookmarks' ? 'suggest' : method === 'GET' || method === 'HEAD' ? 'read' : 'write';
    // The administrator runs this server: only the outbound-fetch limits apply (they protect it).
    if (user.isAdmin && kind !== 'fetch') return next();
    const wait = limits.take(kind, who);
    if (wait) return rateLimited(c, wait, kind);
    if (kind !== 'fetch') return next();
    const release = limits.enter(who);
    if (!release) return rateLimited(c, 2, 'concurrent', '同时进行的下载过多，请等前面的完成后再试');
    try {
      await next();
    } finally {
      release();
    }
  });
  const me = (c: Context<{ Variables: Vars }>) => c.get('user');
  const adminOnly: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => (c.get('user').isAdmin ? next() : apiError(c, 403, 'admin_only', '仅管理员可用'));

  // ── 我的收藏 (v2) ────────────────────────────────────────────────────────
  registerItemsApi(app, { db: repo.db, repo, secrets, icons, itemLimit: (u) => (u.isAdmin ? null : (env.quotas ?? DEFAULT_QUOTAS).items) });

  // ── Account (v2) ────────────────────────────────────────────────────────
  app.get('/api/v2/me', async (c) => {
    const u = me(c);
    const cfg = await repo.snapshot(u.id);
    return c.json({
      // 登录用户名 (UI v2 I1): the identity service's own field, only when it sent one — never made up
      // from the nickname or e-mail. For the account page; the status pill shows none of these.
      account: { id: u.id, displayName: u.displayName || u.email || (u.id === LEGACY_ADMIN_ID ? '管理员' : '用户'), email: u.email, emailVerified: u.emailVerified, ...(u.username ? { username: u.username } : {}) },
      product: 'nexus',
      role: u.isAdmin ? 'admin' : 'user',
      permissions: u.isAdmin ? ['collection', 'devices', 'health', 'integrations', 'admin'] : ['collection', 'devices'],
      onboarding: { state: cfg.config.apps.length ? 'ready' : 'empty_collection' },
      session: c.get('session').kind,
      identityLinked: !!u.issuer,
      canLinkIdentity: !!oidc && !u.issuer && c.get('session').kind === 'password',
    });
  });

  /**
   * ADR-019 动作 B · 退出本产品的全部设备: every browser session, paired device and approved-but-
   * unclaimed pairing of this account in Nexus — in one transaction (a new epoch). The identity
   * service and LiteSync are not touched (that is 动作 C below), so there is no end-session hop.
   */
  app.post('/api/v2/account/logout-all', async (c) => {
    const u = me(c);
    const r = await revocations.revokeProduct(u.id, 'logout-all');
    deleteCookie(c, COOKIE, { path: '/' });
    await notify(u, `signed-out:${u.id}:${now()}`, 'signed-out-everywhere');
    return c.json({ sessions: r?.sessions ?? 0, devices: r?.devices ?? 0, grants: r?.grants ?? 0, endSessionUrl: null } satisfies LogoutAllResponse);
  });

  /**
   * ADR-019 动作 C · 退出所有产品与设备: 动作 B here, then every identity-service session of the user
   * (all browsers), then the other product. The answer reports each part as it really is.
   */
  app.post('/api/v2/account/revoke-everywhere', async (c) => {
    const u = me(c);
    if (!oidc || !u.issuer) return v2Error(c, 409, 'NO_UNIFIED_IDENTITY', '这个账号没有使用统一账号：请改用「退出 Nexus 的全部设备」');
    const r = await revocations.revokeEverywhere(u.id, c.get('session'));
    deleteCookie(c, COOKIE, { path: '/' });
    if (!r) return v2Error(c, 404, 'NOT_FOUND', '账号不存在');
    await notify(u, `signed-out-all:${u.id}:${now()}`, 'signed-out-all-products');
    return c.json(r satisfies RevokeEverywhereResponse);
  });

  /**
   * ADR-019 §2.3: this account's recent cross-product revocation events and their delivery state
   * (times, the other product, states and error categories — never a token), and what this
   * deployment has configured, so the page can say when a part cannot happen at all.
   */
  app.get('/api/v2/account/revocations', async (c) => {
    const u = me(c);
    return c.json({
      peer: { product: revocations.peer?.product ?? 'litesync', configured: !!revocations.peer },
      identityCenter: { configured: !!oidc, accountUrl: revocations.accountUrl },
      centralCheck: { configured: !!identity },
      events: await revocations.list(u.id),
    } satisfies RevocationStatusResponse);
  });

  /** 重新发送: a pending or failed event of this account, one attempt now, a fresh 7-day window. */
  app.post('/api/v2/account/revocations/:id/retry', async (c) => {
    const id = c.req.param('id');
    const r = /^[0-9a-f]{32}$/.test(id) && revocations.peer ? await revocations.retry(me(c).id, id) : null;
    return r ? c.json(r) : v2Error(c, 404, 'NOT_FOUND', '没有可以重新发送的撤销事件');
  });

  // ── Administration (v2): accounts and invitations ──────────────────────
  app.get('/api/v2/admin/users', adminOnly, async (c) => c.json({ users: (await users.list()).map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, emailVerified: u.emailVerified, isAdmin: u.isAdmin, disabled: u.disabled, createdVia: u.createdVia, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, linked: !!u.issuer })) }));
  app.post('/api/v2/admin/users/:id/:action{disable|enable}', adminOnly, async (c) => {
    const id = c.req.param('id');
    if (id === me(c).id) return v2Error(c, 409, 'SELF_LOCKOUT', '不能停用自己的账号');
    const disable = c.req.param('action') === 'disable';
    // Disabling is 动作 B in the same transaction: sessions, devices and approved pairings end now
    // (offline caches cannot be wiped remotely). Enabling again only lets the person sign in again:
    // nothing issued before comes back (the epoch never goes down).
    const done = disable ? !!(await revocations.disable(id)) : await users.setDisabled(id, false);
    if (!done) return v2Error(c, 404, 'NOT_FOUND', '账号不存在');
    return c.json({ id, disabled: disable });
  });
  /** What the administrator must know: cross-product revocation and the central status check (ADR-019). */
  app.get('/api/v2/admin/revocation-status', adminOnly, async (c) =>
    c.json({
      peer: await revocations.health(),
      centralCheck: identity ? { configured: true, lastError: identity.lastError?.error ?? null, lastErrorAt: identity.lastError ? new Date(identity.lastError.at).toISOString() : null, lastSuccessAt: identity.lastSuccessAt ? new Date(identity.lastSuccessAt).toISOString() : null } : { configured: false, lastError: null, lastErrorAt: null, lastSuccessAt: null },
      oidc: !!oidc,
    } satisfies AdminRevocationStatus),
  );
  app.post('/api/v2/admin/invites', adminOnly, bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ttlDays?: unknown };
    const ttl = typeof body.ttlDays === 'number' ? body.ttlDays : 7;
    return c.json(await users.createInvite(me(c).id, ttl), 201);
  });

  // ── Configuration ───────────────────────────────────────────────────────
  app.get('/api/config', async (c) => c.json(await configResponse(me(c).id)));

  app.post('/api/config/ops', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    const body = OpBatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid', body.error.issues[0]?.message ?? '请求格式不正确');
    const u = me(c);
    try {
      const r = await repo.apply(u.id, body.data.batchId, body.data.clientId, body.data.ops as never, { admin: u.isAdmin });
      if (r.changed) repo.emit(u.id, r.snapshot.revision);
      return c.json({ ...r.snapshot, wallpapers: await wallpapers.list(u.id) } satisfies ConfigResponse);
    } catch (e) {
      // A per-account limit is permanent until something is removed: QUOTA_EXCEEDED, never retried.
      if (e instanceof OpError && e.quota) return quotaExceeded(c, 409, e.quota, e.message);
      // Another device got there first (deleted, same field changed, already undone): kept by the client (NEX-04).
      if (e instanceof OpError && (CONFLICT_CODES as string[]).includes(e.code)) return opConflict(c, CONFLICT_HTTP_CODE[e.code as keyof typeof CONFLICT_HTTP_CODE], e.code, e.message, e.details);
      if (e instanceof OpError) return apiError(c, 422, e.code, e.message);
      throw e;
    }
  });

  /** Server-sent revision numbers of this account (and, for the administrator, health results). */
  app.get('/api/events', (c) => {
    const u = me(c);
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      let open = true;
      const off = repo.onChange(u.id, (revision) => void stream.writeSSE({ event: 'revision', data: JSON.stringify({ revision }) }));
      const offStatus = u.isAdmin ? health.onStatus((s) => void stream.writeSSE({ event: 'status', data: JSON.stringify(s) })) : () => undefined;
      stream.onAbort(() => {
        open = false;
        off();
        offStatus();
      });
      await stream.writeSSE({ event: 'revision', data: JSON.stringify({ revision: (await repo.version(u.id)).revision }), retry: 3000 });
      while (open) {
        await stream.sleep(sseRecheckMs);
        if (!open) break;
        // ADR-019 §2.6: every 15 s the session and the account's epoch are checked again (and the
        // identity service, at most once a minute): a revocation anywhere closes the stream, and the
        // page then asks the server who it is.
        if (!(await auth.validate(getCookie(c, COOKIE))).valid) break;
        const current = await users.get(u.id);
        if (!current || current.disabled) break;
        if (identity && (await identity.check(current, 'session')) === 'revoked') break;
        await stream.write(': ping\n\n');
      }
    });
  });

  // ── Paired devices: list, revoke, approve a pairing ────────────────────
  app.get('/api/devices', async (c) => c.json(await devices.list(me(c).id)));

  app.delete('/api/devices/:id', async (c) => ((await devices.revoke(me(c).id, c.req.param('id'))) ? c.json(await devices.list(me(c).id)) : apiError(c, 404, 'not_found', '设备不存在')));

  app.get('/api/devices/pairing/:code', (c) => {
    const code = c.req.param('code').toUpperCase();
    const req = PAIR_CODE.test(code) ? pairings.peek(code) : null;
    return req ? c.json(req) : apiError(c, 404, 'not_found', '连接请求不存在或已过期');
  });

  /** Approving binds the device to the signed-in account, with at most the scopes it asked for. */
  app.post('/api/devices/pairing/:code', bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = DecideSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid', '请求格式不正确');
    const code = c.req.param('code').toUpperCase();
    const u = me(c);
    const request = PAIR_CODE.test(code) ? pairings.peek(code) : null;
    const grant = body.data.scopes?.filter(isDeviceScope);
    // The grant remembers the epoch this request was authenticated under (ADR-019): a revocation
    // that lands before the extension picks the token up makes the pick-up fail.
    if (!request || !pairings.decide(code, body.data.approve, u.id, grant, u.authEpoch)) return apiError(c, 404, 'not_found', '连接请求不存在或已过期');
    if (body.data.approve) {
      const granted = (request.scopes ?? ['config:read']).filter((s) => !grant || grant.includes(s));
      await notify(u, `device-authorized:${code}:${u.id}`, 'device-authorized', { device: request.name, scopes: granted.map((s) => DEVICE_SCOPE_LABELS[s]).join('、') });
    }
    return c.json({ approved: body.data.approve });
  });

  // ── Health checks (administrator) ───────────────────────────────────────
  app.get('/api/status', async (c) => read.status(c, me(c).isAdmin));

  app.post('/api/status/:id/check', adminOnly, async (c) => {
    const s = await health.runNow(c.req.param('id'));
    return s ? c.json(s) : apiError(c, 404, 'not_found', '该服务没有开启健康检查');
  });

  /** 测试连接 for an unsaved draft. Same host rule and network policy as scheduled checks. */
  app.post('/api/health/test', adminOnly, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { app?: unknown } | null;
    const parsed = AppSchema.safeParse(body?.app);
    if (!parsed.success) return apiError(c, 400, 'invalid', '请先填写完整的地址');
    const app = { ...parsed.data, health: { ...parsed.data.health, enabled: true } };
    const err = validateApp(app, []).errors;
    if (err.url || err.lanUrl || err.health) return apiError(c, 422, 'invalid', err.health ?? err.lanUrl ?? err.url!);
    return c.json(await health.test(app));
  });

  // ── Linkwarden (administrator, read-only) ──────────────────────────────
  app.get('/api/integrations/linkwarden', adminOnly, async (c) => c.json(await linkwarden.status()));

  app.put('/api/integrations/linkwarden', adminOnly, bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { baseUrl?: unknown; token?: unknown } | null;
    if (typeof body?.baseUrl !== 'string' || (body.token !== undefined && typeof body.token !== 'string')) return apiError(c, 400, 'invalid', '请填写 Linkwarden 地址');
    try {
      return c.json(await linkwarden.connect(body.baseUrl, body.token as string | undefined));
    } catch (e) {
      if (e instanceof TypeError) return apiError(c, 400, 'invalid', '地址格式不正确');
      return lwError(c, e);
    }
  });

  app.delete('/api/integrations/linkwarden', adminOnly, async (c) => {
    await linkwarden.disconnect();
    return c.json(await linkwarden.status());
  });

  app.get('/api/bookmarks', async (c) => read.bookmarks(c, me(c).isAdmin));
  app.get('/api/suggest', async (c) => read.suggest(c, me(c).id));

  // ── Wallpapers (the account's own library) ──────────────────────────────
  app.get('/api/wallpapers', async (c) => c.json(await wallpapers.list(me(c).id)));

  app.post(
    '/api/wallpapers',
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (c) => apiError(c, 413, 'too_large', '文件超过 10 MB 上限') }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) return apiError(c, 400, 'invalid', '没有收到图片文件');
      try {
        const w = await wallpapers.add(me(c).id, Buffer.from(await file.arrayBuffer()), file.name);
        await repo.touch(me(c).id);
        return c.json(w, 201);
      } catch (e) {
        if (e instanceof WallpaperError) return apiError(c, e.code === 'too_large' ? 413 : 415, e.code, e.message);
        throw e;
      }
    },
  );

  app.get('/api/wallpapers/:id/:file', async (c) => read.wallpaperFile(c, me(c).id));

  // ── Wallpaper sources (精选图库 · 每日一图 · Unsplash · 网址导入) ──────────
  /** A new library entry bumps the revision so every device of the account fetches the updated list. */
  const added = async (c: Context<{ Variables: Vars }>, r: Ensured) => {
    if (r.created) await repo.touch(me(c).id);
    return c.json(r.wallpaper, r.created ? 201 : 200);
  };
  app.get('/api/wallpaper-sources', async (c) => read.wallpaperSources(c, me(c).id));
  app.get('/api/gallery/:id/preview', async (c) => {
    try {
      const body = await sources.gallery.preview(c.req.param('id'));
      c.header('Content-Type', 'image/webp');
      c.header('Cache-Control', 'private, max-age=604800');
      return c.body(new Uint8Array(body));
    } catch (e) {
      return sourceError(c, e);
    }
  });
  app.post('/api/gallery/:id', async (c) => {
    try {
      return await added(c, await sources.gallery.ensure(me(c).id, c.req.param('id')));
    } catch (e) {
      return sourceError(c, e);
    }
  });
  app.get('/api/daily', (c) => read.daily(c));
  app.post('/api/daily/:id/keep', async (c) => {
    try {
      return await added(c, await sources.daily.keep(me(c).id, c.req.param('id')));
    } catch (e) {
      return sourceError(c, e);
    }
  });
  app.post('/api/wallpapers/import', bodyLimit({ maxSize: 4096 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    if (typeof body?.url !== 'string' || body.url.length > 2048) return apiError(c, 400, 'invalid', '请输入图片地址');
    try {
      const w = await importFromUrl(wallpapers, me(c).id, body.url, sources.importPolicy, sources.importFetch);
      await repo.touch(me(c).id);
      return c.json(w, 201);
    } catch (e) {
      return sourceError(c, e);
    }
  });
  app.get('/api/unsplash/photos', async (c) => {
    try {
      return c.json({ photos: await sources.unsplash.search(c.req.query('q') ?? '', Number(c.req.query('page') ?? 1)) });
    } catch (e) {
      return sourceError(c, e);
    }
  });
  app.post('/api/unsplash/:id', async (c) => {
    try {
      return await added(c, await sources.unsplash.use(me(c).id, c.req.param('id')));
    } catch (e) {
      return sourceError(c, e);
    }
  });

  app.delete('/api/wallpapers/:id', async (c) => {
    const u = me(c);
    const id = c.req.param('id');
    if (!(await wallpapers.remove(u.id, id))) return apiError(c, 404, 'not_found', '壁纸不存在');
    if ((await repo.snapshot(u.id)).config.settings.look.wallpaper === id) {
      const r = await repo.apply(u.id, `server-${now()}`, 'server', [{ type: 'settings.patch', section: 'look', patch: { wallpaper: 'fallingwater' } }], { admin: u.isAdmin });
      repo.emit(u.id, r.snapshot.revision);
    } else await repo.touch(u.id);
    return c.json(await configResponse(u.id));
  });

  // ── App icons (the account's own uploads) ───────────────────────────────
  app.post(
    '/api/icons',
    bodyLimit({ maxSize: MAX_ICON_BYTES + 16 * 1024, onError: (c) => apiError(c, 413, 'too_large', '文件超过 1 MB 上限') }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) return apiError(c, 400, 'invalid', '没有收到图片文件');
      try {
        const owner = me(c).id;
        // At the icon limit, icons that no app uses any more make room (see IconStore.add).
        const inUse = async () => new Set((await repo.snapshot(owner)).config.apps.filter((a) => a.icon.source === 'upload').map((a) => a.icon.ref));
        return c.json({ id: await icons.add(owner, Buffer.from(await file.arrayBuffer()), file.type, inUse) }, 201);
      } catch (e) {
        if (e instanceof IconError) return apiError(c, e.code === 'too_large' ? 413 : e.code === 'unsafe' ? 422 : 415, e.code, e.message);
        throw e;
      }
    },
  );

  app.get('/api/icons/:file', async (c) => read.icon(c, me(c).id));

  app.get('/api/icon-cache/:source/:key', (c) => read.iconCache(c));

  app.all('/api/*', (c) => apiError(c, 404, 'not_found', '接口不存在'));

  // ── Web app ─────────────────────────────────────────────────────────────
  if (env.webDist) {
    const root = env.webDist;
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    // The Service Worker and manifest must be re-checked on every load, or updates never arrive.
    app.use('/sw.js', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
    app.use('/manifest.webmanifest', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
      c.header('Content-Type', 'application/manifest+json');
    });
    // The HTML shell names the current hashed assets: always revalidate it, or an upgrade only
    // shows up after the browser's heuristic cache expires.
    app.use('*', async (c, next) => {
      await next();
      if (c.res.headers.get('content-type')?.startsWith('text/html') && !c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-cache');
    });
    app.use('*', serveStatic({ root, rewriteRequestPath: (p) => p }));
    const indexHtml = readFile(join(root, 'index.html'), 'utf8');
    app.get('*', async (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(await indexHtml);
    });
  }

  app.onError((err, c) => {
    // Storage limits are reached deep inside the stores; every route answers them the same way.
    if (err instanceof QuotaExceededError) return quotaExceeded(c, err.status, err.details, err.message);
    console.error('[nexus]', err);
    return apiError(c, 500, 'internal', '服务器内部错误');
  });

  return app;
}

/** A sealed value written with another key (NEXUS_SECRET changed) reads as absent. */
function safeOpen(box: SecretBox, sealed: string): string | null {
  try {
    return box.open(sealed);
  } catch {
    return null;
  }
}

export { safeReturnTo };
