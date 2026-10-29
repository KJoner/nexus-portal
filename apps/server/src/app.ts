import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { AppSchema, OpBatchSchema, OpError, validateApp, type ConfigResponse, type WallpaperSourcesResponse } from '@nexus/shared';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { LoginLimiter } from './auth/rate-limit';
import type { Auth } from './auth/sessions';
import type { ConfigRepo } from './config/repo';
import type { Env } from './env';
import type { HealthChecker } from './health/checker';
import { apiError, csrf, headers, isHttps } from './http/security';
import { isValidIconKey, type IconProxy, type IconSource } from './icons/proxy';
import { LinkwardenError, type Linkwarden } from './integrations/linkwarden';
import { fetchSuggestions } from './integrations/suggest';
import { IconError, MAX_ICON_BYTES, type IconStore } from './icons/store';
import type { getBytes } from './net/http';
import type { NetPolicy } from './net/ip';
import { importFromUrl, SourceError, type Daily, type Ensured, type Gallery, type Unsplash } from './wallpapers/sources';
import { MAX_UPLOAD_BYTES, WallpaperError, type WallpaperStore } from './wallpapers/store';

export interface Deps {
  env: Env;
  repo: ConfigRepo;
  auth: Auth;
  limiter: LoginLimiter;
  wallpapers: WallpaperStore;
  icons: IconStore;
  health: HealthChecker;
  iconProxy: IconProxy;
  linkwarden: Linkwarden;
  suggestFetch?: typeof fetch;
  sources: WallpaperSources;
}

/** v0.2 wallpaper sources. Remote imports use their own, stricter network policy (public only). */
export interface WallpaperSources {
  gallery: Gallery;
  daily: Daily;
  unsplash: Unsplash;
  importPolicy: NetPolicy;
  importFetch?: typeof getBytes;
}

const COOKIE = 'nexus_session';
const LoginSchema = z.object({ password: z.string().min(1).max(256) });

export function createApp({ env, repo, auth, limiter, wallpapers, icons, health, iconProxy, linkwarden, suggestFetch, sources }: Deps) {
  const app = new Hono();

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

  const configResponse = (): ConfigResponse => ({ ...repo.snapshot(), wallpapers: wallpapers.list() });

  // Registered before the global headers so this runs last and wins: an icon SVG opened
  // directly must not execute anything.
  app.use('/api/icon-cache/*', async (c, next) => {
    await next();
    c.res.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  });
  app.use('*', headers());
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store');
  });
  app.use('/api/*', csrf(env));

  app.get('/api/healthz', (c) => c.json({ ok: true }));

  // ── Auth ────────────────────────────────────────────────────────────────
  app.get('/api/auth/session', (c) => c.json({ authenticated: auth.validate(getCookie(c, COOKIE)).valid }));

  app.post('/api/auth/login', bodyLimit({ maxSize: 4096 }), async (c) => {
    const key = clientKey(c);
    const wait = limiter.retryAfter(key);
    if (wait) {
      c.header('Retry-After', String(wait));
      return apiError(c, 429, 'rate_limited', `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`);
    }
    const body = LoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid', '请输入密码');
    if (!(await auth.checkPassword(body.data.password))) {
      limiter.fail(key);
      return apiError(c, 401, 'bad_password', '密码不正确');
    }
    limiter.succeed(key);
    const { token, maxAgeSec } = auth.createSession(c.req.header('user-agent') ?? '');
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: env.cookieSecure === 'always' || (env.cookieSecure === 'auto' && isHttps(c, env)), path: '/', maxAge: maxAgeSec });
    return c.json({ authenticated: true });
  });

  app.post('/api/auth/logout', (c) => {
    auth.revoke(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ authenticated: false });
  });

  // Everything else under /api needs a session.
  app.use('/api/*', async (c, next) => {
    const token = getCookie(c, COOKIE);
    const v = auth.validate(token);
    if (!v.valid) return apiError(c, 401, 'unauthenticated', '需要登录');
    if (v.renewed && token) {
      setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: env.cookieSecure === 'always' || (env.cookieSecure === 'auto' && isHttps(c, env)), path: '/', maxAge: env.sessionDays * 86_400 });
    }
    return next();
  });

  // ── Configuration ───────────────────────────────────────────────────────
  app.get('/api/config', (c) => c.json(configResponse()));

  app.post('/api/config/ops', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    const body = OpBatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid', body.error.issues[0]?.message ?? '请求格式不正确');
    try {
      const r = repo.apply(body.data.batchId, body.data.clientId, body.data.ops as never);
      if (r.changed) repo.emit(r.snapshot.revision);
      return c.json({ ...r.snapshot, wallpapers: wallpapers.list() } satisfies ConfigResponse);
    } catch (e) {
      if (e instanceof OpError) return apiError(c, 422, e.code, e.message);
      throw e;
    }
  });

  /** Server-sent revision numbers; other devices fetch the snapshot when it moves. */
  app.get('/api/events', (c) => {
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      let open = true;
      const off = repo.onChange((revision) => void stream.writeSSE({ event: 'revision', data: JSON.stringify({ revision }) }));
      const offStatus = health.onStatus((s) => void stream.writeSSE({ event: 'status', data: JSON.stringify(s) }));
      stream.onAbort(() => {
        open = false;
        off();
        offStatus();
      });
      await stream.writeSSE({ event: 'revision', data: JSON.stringify({ revision: repo.snapshot().revision }), retry: 3000 });
      while (open) {
        await stream.sleep(25_000);
        if (open) await stream.write(': ping\n\n');
      }
    });
  });

  // ── Health checks ───────────────────────────────────────────────────────
  app.get('/api/status', (c) => c.json(health.list()));

  app.post('/api/status/:id/check', async (c) => {
    const s = await health.runNow(c.req.param('id'));
    return s ? c.json(s) : apiError(c, 404, 'not_found', '该服务没有开启健康检查');
  });

  /** 测试连接 for an unsaved draft. Same host rule and network policy as scheduled checks. */
  app.post('/api/health/test', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { app?: unknown } | null;
    const parsed = AppSchema.safeParse(body?.app);
    if (!parsed.success) return apiError(c, 400, 'invalid', '请先填写完整的地址');
    const app = { ...parsed.data, health: { ...parsed.data.health, enabled: true } };
    const err = validateApp(app, []).errors;
    if (err.url || err.lanUrl || err.health) return apiError(c, 422, 'invalid', err.health ?? err.lanUrl ?? err.url!);
    return c.json(await health.test(app));
  });

  // ── Linkwarden (read-only) ─────────────────────────────────────────────
  const lwError = (c: Context, e: unknown) => {
    if (!(e instanceof LinkwardenError)) throw e;
    const status = e.code === 'not_configured' ? 404 : e.code === 'invalid' ? 400 : 422;
    return apiError(c, status, e.code, e.message);
  };

  app.get('/api/integrations/linkwarden', (c) => c.json(linkwarden.status()));

  app.put('/api/integrations/linkwarden', bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { baseUrl?: unknown; token?: unknown } | null;
    if (typeof body?.baseUrl !== 'string' || (body.token !== undefined && typeof body.token !== 'string')) return apiError(c, 400, 'invalid', '请填写 Linkwarden 地址');
    try {
      return c.json(await linkwarden.connect(body.baseUrl, body.token as string | undefined));
    } catch (e) {
      if (e instanceof TypeError) return apiError(c, 400, 'invalid', '地址格式不正确');
      return lwError(c, e);
    }
  });

  app.delete('/api/integrations/linkwarden', (c) => {
    linkwarden.disconnect();
    return c.json(linkwarden.status());
  });

  app.get('/api/bookmarks', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ bookmarks: [] });
    try {
      return c.json({ bookmarks: await linkwarden.search(q) });
    } catch (e) {
      return lwError(c, e);
    }
  });

  /** 搜索建议 — off unless the user enabled it; failures just mean no suggestions. */
  app.get('/api/suggest', async (c) => {
    if (!repo.snapshot().config.settings.search.suggest) return apiError(c, 403, 'disabled', '搜索建议未开启');
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ suggestions: [] });
    try {
      return c.json({ suggestions: await fetchSuggestions(c.req.query('engine') ?? '', q, suggestFetch) });
    } catch {
      return c.json({ suggestions: [] });
    }
  });

  // ── Wallpapers ──────────────────────────────────────────────────────────
  app.get('/api/wallpapers', (c) => c.json(wallpapers.list()));

  app.post(
    '/api/wallpapers',
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (c) => apiError(c, 413, 'too_large', '文件超过 10 MB 上限') }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) return apiError(c, 400, 'invalid', '没有收到图片文件');
      try {
        const w = await wallpapers.add(Buffer.from(await file.arrayBuffer()), file.name);
        repo.touch();
        return c.json(w, 201);
      } catch (e) {
        if (e instanceof WallpaperError) return apiError(c, e.code === 'too_large' ? 413 : 415, e.code, e.message);
        throw e;
      }
    },
  );

  app.get('/api/wallpapers/:id/:file', (c) => {
    const path = wallpapers.filePath(c.req.param('id'), c.req.param('file'));
    if (!path) return apiError(c, 404, 'not_found', '壁纸不存在');
    const ext = path.slice(path.lastIndexOf('.') + 1);
    c.header('Content-Type', ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    // Ids are never reused, so variants are immutable — but private to this user.
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
  });

  // ── Wallpaper sources (精选图库 · 每日一图 · Unsplash · 网址导入) ──────────
  const SOURCE_STATUS = { not_found: 404, invalid: 400, blocked: 422, license: 422, not_configured: 404, unavailable: 502, too_large: 413 } as const;
  const sourceError = (c: Context, e: unknown) => {
    if (e instanceof SourceError) return apiError(c, SOURCE_STATUS[e.code], e.code, e.message);
    if (e instanceof WallpaperError) return apiError(c, e.code === 'too_large' ? 413 : 415, e.code, e.message);
    throw e;
  };
  /** A new library entry bumps the revision so every device fetches the updated wallpaper list. */
  const added = (c: Context, r: Ensured) => {
    if (r.created) repo.touch();
    return c.json(r.wallpaper, r.created ? 201 : 200);
  };
  app.get('/api/wallpaper-sources', (c) => c.json({ gallery: sources.gallery.list(), unsplash: sources.unsplash.configured } satisfies WallpaperSourcesResponse));
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
      return added(c, await sources.gallery.ensure(c.req.param('id')));
    } catch (e) {
      return sourceError(c, e);
    }
  });
  app.post('/api/daily', bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { date?: unknown } | null;
    if (typeof body?.date !== 'string') return apiError(c, 400, 'invalid', '缺少日期');
    try {
      const r = await sources.daily.ensure(body.date);
      if (r.created) {
        const look = repo.snapshot().config.settings.look;
        void sources.daily.prune(new Set([look.wallpaper, r.wallpaper.id, ...look.favorites])).catch(() => undefined);
      }
      return added(c, r);
    } catch (e) {
      return sourceError(c, e);
    }
  });
  app.post('/api/wallpapers/import', bodyLimit({ maxSize: 4096 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    if (typeof body?.url !== 'string' || body.url.length > 2048) return apiError(c, 400, 'invalid', '请输入图片地址');
    try {
      const w = await importFromUrl(wallpapers, body.url, sources.importPolicy, sources.importFetch);
      repo.touch();
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
      return added(c, await sources.unsplash.use(c.req.param('id')));
    } catch (e) {
      return sourceError(c, e);
    }
  });

  app.delete('/api/wallpapers/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await wallpapers.remove(id))) return apiError(c, 404, 'not_found', '壁纸不存在');
    if (repo.snapshot().config.settings.look.wallpaper === id) {
      const r = repo.apply(`server-${Date.now()}`, 'server', [{ type: 'settings.patch', section: 'look', patch: { wallpaper: 'fallingwater' } }]);
      repo.emit(r.snapshot.revision);
    } else repo.touch();
    return c.json(configResponse());
  });

  // ── App icons ───────────────────────────────────────────────────────────
  app.post(
    '/api/icons',
    bodyLimit({ maxSize: MAX_ICON_BYTES + 16 * 1024, onError: (c) => apiError(c, 413, 'too_large', '文件超过 1 MB 上限') }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) return apiError(c, 400, 'invalid', '没有收到图片文件');
      try {
        return c.json({ id: await icons.add(Buffer.from(await file.arrayBuffer()), file.type) }, 201);
      } catch (e) {
        if (e instanceof IconError) return apiError(c, e.code === 'too_large' ? 413 : e.code === 'unsafe' ? 422 : 415, e.code, e.message);
        throw e;
      }
    },
  );

  app.get('/api/icons/:file', (c) => {
    const path = icons.filePath(c.req.param('file').replace(/\.png$/, ''));
    if (!path || !existsSync(path)) return apiError(c, 404, 'not_found', '图标不存在');
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
  });

  /** Cached brand icons: /api/icon-cache/{di|si}/<slug>, /api/icon-cache/fav/<host>. */
  app.get('/api/icon-cache/:source/:key', async (c) => {
    const source = c.req.param('source') as IconSource;
    const key = c.req.param('key').toLowerCase();
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
  });

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
    console.error('[nexus]', err);
    return apiError(c, 500, 'internal', '服务器内部错误');
  });

  return app;
}
