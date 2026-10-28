import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { OpBatchSchema, OpError, type ConfigResponse } from '@nexus/shared';
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
import { apiError, csrf, headers, isHttps } from './http/security';
import { IconError, MAX_ICON_BYTES, type IconStore } from './icons/store';
import { MAX_UPLOAD_BYTES, WallpaperError, type WallpaperStore } from './wallpapers/store';

export interface Deps {
  env: Env;
  repo: ConfigRepo;
  auth: Auth;
  limiter: LoginLimiter;
  wallpapers: WallpaperStore;
  icons: IconStore;
}

const COOKIE = 'nexus_session';
const LoginSchema = z.object({ password: z.string().min(1).max(256) });

export function createApp({ env, repo, auth, limiter, wallpapers, icons }: Deps) {
  const app = new Hono();

  const clientKey = (c: Context) => {
    if (env.trustProxy) {
      const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const configResponse = (): ConfigResponse => ({ ...repo.snapshot(), wallpapers: wallpapers.list() });

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
      stream.onAbort(() => {
        open = false;
        off();
      });
      await stream.writeSSE({ event: 'revision', data: JSON.stringify({ revision: repo.snapshot().revision }), retry: 3000 });
      while (open) {
        await stream.sleep(25_000);
        if (open) await stream.write(': ping\n\n');
      }
    });
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

  app.all('/api/*', (c) => apiError(c, 404, 'not_found', '接口不存在'));

  // ── Web app ─────────────────────────────────────────────────────────────
  if (env.webDist) {
    const root = env.webDist;
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
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
