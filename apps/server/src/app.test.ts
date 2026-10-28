import { CLIENT_HEADER, type ConfigResponse } from '@nexus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { LoginLimiter } from './auth/rate-limit';
import { Auth } from './auth/sessions';
import { ConfigRepo } from './config/repo';
import { openDb, type DB } from './db';
import type { Env } from './env';
import { IconStore } from './icons/store';
import { WallpaperStore } from './wallpapers/store';

const PASSWORD = 'correct horse battery';
let dir: string;
let db: DB;
let auth: Auth;
let app: ReturnType<typeof createApp>;

const env: Env = { production: false, host: '127.0.0.1', port: 0, dataDir: '', password: PASSWORD, generatedPassword: false, cookieSecure: 'auto', trustProxy: false, allowedOrigins: ['https://home.example.com'], sessionDays: 30, webDist: null };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-test-'));
  db = openDb(':memory:');
  auth = new Auth(db, 30);
  await auth.ensurePassword(PASSWORD);
  app = createApp({ env, repo: new ConfigRepo(db), auth, limiter: new LoginLimiter(), wallpapers: new WallpaperStore(db, dir), icons: new IconStore(join(dir, 'icons')) });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const write = { [CLIENT_HEADER]: '1', 'content-type': 'application/json' };

async function login(): Promise<string> {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: write, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Lax/i);
  return cookie.split(';')[0]!;
}

const ops = (cookie: string, body: unknown, extra: Record<string, string> = {}) => app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie, ...extra }, body: JSON.stringify(body) });

describe('access protection', () => {
  it('health check is public and leaks nothing', async () => {
    const res = await app.request('/api/healthz');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('configuration requires a session', async () => {
    expect((await app.request('/api/config')).status).toBe(401);
    expect((await app.request('/api/events')).status).toBe(401);
    expect(await (await app.request('/api/auth/session')).json()).toEqual({ authenticated: false });
  });

  it('wrong passwords are rejected and rate limited', async () => {
    const bad = () => app.request('/api/auth/login', { method: 'POST', headers: write, body: JSON.stringify({ password: 'nope' }) });
    for (let i = 0; i < 5; i++) expect((await bad()).status).toBe(401);
    const limited = await bad();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a session grants access and logout revokes it', async () => {
    const cookie = await login();
    const res = await app.request('/api/config', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as ConfigResponse).revision).toBe(1);
    await app.request('/api/auth/logout', { method: 'POST', headers: { ...write, cookie } });
    expect((await app.request('/api/config', { headers: { cookie } })).status).toBe(401);
  });

  it('changing the configured password revokes every session', async () => {
    const cookie = await login();
    expect(await auth.ensurePassword('another long password')).toBe('set');
    expect((await app.request('/api/config', { headers: { cookie } })).status).toBe(401);
  });

  it('writes need the client header and a same-origin Origin', async () => {
    const cookie = await login();
    const body = { clientId: 'c', batchId: 'b1', ops: [{ type: 'pin.remove', appId: 'github' }] };
    const noHeader = await app.request('/api/config/ops', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(noHeader.status).toBe(403);
    const foreign = await ops(cookie, body, { origin: 'https://evil.example', host: 'nexus.home' });
    expect(foreign.status).toBe(403);
    const same = await ops(cookie, body, { origin: 'http://nexus.home', host: 'nexus.home' });
    expect(same.status).toBe(200);
    // A proxy that rewrites Host to the upstream address needs the public origin allow-listed.
    const proxied = await ops(cookie, { ...body, batchId: 'b2' }, { origin: 'https://home.example.com', host: '127.0.0.1:8787' });
    expect(proxied.status).toBe(200);
  });

  it('sends security headers', async () => {
    const res = await app.request('/api/healthz');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('config ops', () => {
  it('applies a batch, bumps the revision and is idempotent on retry', async () => {
    const cookie = await login();
    const body = { clientId: 'c', batchId: 'b1', ops: [{ type: 'pin.remove', appId: 'github' }] };
    const first = (await (await ops(cookie, body)).json()) as ConfigResponse;
    expect(first.revision).toBe(2);
    expect(first.config.pins).not.toContain('github');
    const retry = (await (await ops(cookie, body)).json()) as ConfigResponse;
    expect(retry.revision).toBe(2);
  });

  it('merges concurrent intents from two devices', async () => {
    const cookie = await login();
    await ops(cookie, { clientId: 'phone', batchId: 'p1', ops: [{ type: 'pin.add', appId: 'figma' }] });
    const r = (await (await ops(cookie, { clientId: 'pc', batchId: 'c1', ops: [{ type: 'pin.move', appId: 'notion', toIndex: 0 }] })).json()) as ConfigResponse;
    expect(r.config.pins).toEqual(['notion', 'github', 'gmail', 'youtube', 'bilibili', 'figma']);
  });

  it('rejects invalid ops atomically', async () => {
    const cookie = await login();
    const res = await ops(cookie, { clientId: 'c', batchId: 'b2', ops: [{ type: 'pin.remove', appId: 'github' }, { type: 'pin.add', appId: 'litebox' }] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_pinnable');
    const cfg = (await (await app.request('/api/config', { headers: { cookie } })).json()) as ConfigResponse;
    expect(cfg.revision).toBe(1);
    expect(cfg.config.pins).toContain('github');
  });

  it('rejects malformed bodies and unsafe app urls', async () => {
    const cookie = await login();
    expect((await ops(cookie, { clientId: 'c', batchId: 'b', ops: [{ type: 'nope' }] })).status).toBe(400);
    const cfg = (await (await app.request('/api/config', { headers: { cookie } })).json()) as ConfigResponse;
    const gh = cfg.config.apps.find((a) => a.id === 'github')!;
    const res = await ops(cookie, { clientId: 'c', batchId: 'b3', ops: [{ type: 'app.upsert', app: { ...gh, url: 'javascript:alert(1)' } }] });
    expect(res.status).toBe(422);
  });
});

describe('wallpapers', () => {
  const image = (w: number, h: number, format: 'jpeg' | 'png' = 'jpeg') => sharp({ create: { width: w, height: h, channels: 3, background: '#7a6a55' } })[format]().toBuffer();
  const upload = async (cookie: string, data: Buffer, name: string, type: string) => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(data)], name, { type }));
    return app.request('/api/wallpapers', { method: 'POST', headers: { [CLIENT_HEADER]: '1', cookie }, body: form });
  };

  it('re-encodes uploads into responsive variants with a placeholder', async () => {
    const cookie = await login();
    const res = await upload(cookie, await image(2000, 1200), 'cabin.jpg', 'image/jpeg');
    expect(res.status).toBe(201);
    const w = (await res.json()) as { id: string; widths: number[]; placeholder: string; name: string };
    expect(w.widths).toEqual([1280, 1920]);
    expect(w.name).toBe('cabin');
    expect(w.placeholder).toMatch(/^data:image\/webp;base64,/);
    const file = await app.request(`/api/wallpapers/${w.id}/1920.avif`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/avif');
    expect((await app.request(`/api/wallpapers/${w.id}/2560.avif`, { headers: { cookie } })).status).toBe(404);
    expect((await app.request(`/api/wallpapers/${w.id}/..%2F..%2Fnexus.db`, { headers: { cookie } })).status).toBe(404);
  });

  it('rejects non-images whatever their declared type', async () => {
    const cookie = await login();
    const res = await upload(cookie, Buffer.from('<svg onload=alert(1)>'), 'x.png', 'image/png');
    expect(res.status).toBe(415);
  });

  it('deleting the active wallpaper falls back to the default', async () => {
    const cookie = await login();
    const w = (await (await upload(cookie, await image(1400, 900, 'png'), 'a.png', 'image/png')).json()) as { id: string };
    await ops(cookie, { clientId: 'c', batchId: 'w1', ops: [{ type: 'settings.patch', section: 'look', patch: { wallpaper: w.id } }] });
    const res = await app.request(`/api/wallpapers/${w.id}`, { method: 'DELETE', headers: { [CLIENT_HEADER]: '1', cookie } });
    const cfg = (await res.json()) as ConfigResponse;
    expect(cfg.config.settings.look.wallpaper).toBe('fallingwater');
    expect(cfg.wallpapers).toEqual([]);
  });
});

describe('app icons', () => {
  const post = async (cookie: string, body: string | Buffer, name: string, type: string) => {
    const form = new FormData();
    form.append('file', new File([typeof body === 'string' ? body : new Uint8Array(body)], name, { type }));
    return app.request('/api/icons', { method: 'POST', headers: { [CLIENT_HEADER]: '1', cookie }, body: form });
  };

  it('rasterises a clean SVG to PNG', async () => {
    const cookie = await login();
    const res = await post(cookie, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#e6c08a"/></svg>', 'a.svg', 'image/svg+xml');
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const file = await app.request(`/api/icons/${id}.png`, { headers: { cookie } });
    expect(file.headers.get('content-type')).toBe('image/png');
    const meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([256, 256]);
  });

  it('refuses SVGs that reference local files or entities', async () => {
    const cookie = await login();
    const file = await post(cookie, '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///etc/passwd"/></svg>', 'x.svg', 'image/svg+xml');
    expect(file.status).toBe(422);
    const xxe = await post(cookie, '<?xml version="1.0"?><!DOCTYPE s [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>', 'x.svg', 'image/svg+xml');
    expect(xxe.status).toBe(422);
  });
});
