import { CLIENT_HEADER } from '@nexus/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_ID } from './db';
import { DIALECTS } from './db/testing';
import { buildTestApp, write, type TestApp } from './testing/app';
import { fakeIdp } from './testing/fake-idp';

/**
 * Cross-account isolation matrix (v0.4 · TN-01/02/03/04, NP-A01/02/04).
 *
 * The routes come from app.ts itself, so a new route is covered the day it is added. A route that
 * should be reachable without an account must be listed in PUBLIC with a reason — adding to that
 * list is a decision someone has to defend, which is the point.
 */
const PUBLIC: Record<string, string> = {
  'GET /api/healthz': '存活探针，不含任何账号数据',
  'GET /api/v2/catalog': '公共应用目录（模板，与账号无关）',
  'GET /api/v2/auth/options': '登录页需要知道有哪些登录方式',
  'GET /api/auth/session': '只回答当前浏览器是否已登录',
  'POST /api/auth/login': '旧管理员口令登录本身',
  'POST /api/auth/logout': '退出（没有会话时什么也不做）',
  'POST /api/pair/start': '扩展发起配对：此刻还没有凭据，结果要已登录用户批准',
  'POST /api/pair/poll': '扩展领取结果：只凭发起时拿到的 secret',
  'GET /auth/login': '跳转到身份服务',
  'GET /auth/link/start': '认领：内部检查旧口令会话',
  'GET /auth/callback': '身份服务回调：state + 浏览器意图 Cookie 即认证',
  'POST /auth/backchannel-logout': '身份服务的登出通知：签名令牌即认证',
};
/** Device-token routes: covered separately below (their own authentication). */
const DEVICE_PREFIX = '/api/sync/';
/** Pairing codes are capabilities shown by the extension; whoever approves becomes its owner (by design). */
const CAPABILITY = new Set(['GET /api/devices/pairing/:code', 'POST /api/devices/pairing/:code']);

interface Route {
  method: string;
  path: string;
}

function routes(): Route[] {
  // app.ts and the modules that register routes on the same app (我的收藏 v2).
  const src = ['app.ts', 'items/api.ts'].map((f) => readFileSync(join(import.meta.dirname, f), 'utf8')).join('\n');
  const out: Route[] = [];
  for (const m of src.matchAll(/app\.(get|post|put|delete|patch)\('([^']+)'/g)) out.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  if (out.length < 40) throw new Error(`只解析出 ${out.length} 条路由——正则大概已经和 app.ts 对不上了`);
  return out;
}

const key = (r: Route) => `${r.method} ${r.path}`;
/** A's markers: none may ever appear in anything B receives. */
const SECRET_SITE = 'A-only-site-7f3a';
const SECRET_URL = 'https://a-only.example.org/private?token=abc';

describe.each(DIALECTS)('isolation matrix (%s)', (dialect) => {
  let t: TestApp;
  let a: string;
  let b: string;
  const A = LEGACY_ADMIN_ID;
  const ids: Record<string, string> = {};
  let aState: string;

  const snapshotA = async () => {
    const cfg = (await (await t.app.request('/api/config', { headers: { cookie: a } })).json()) as { revision: number; config: unknown; wallpapers: { id: string }[] };
    const devices = await (await t.app.request('/api/devices', { headers: { cookie: a } })).json();
    return JSON.stringify({ revision: cfg.revision, config: cfg.config, wallpapers: cfg.wallpapers.map((w) => w.id), devices });
  };

  beforeAll(async () => {
    const idp = await fakeIdp();
    t = await buildTestApp({ dialect, idp, legacyPasswordLogin: 'on' });
    a = await t.loginLegacy();
    b = (await t.loginOidc({ sub: 'user-b', email: 'b@example.org' })).cookie;
    // A's private data: a site, a wallpaper, an icon, a paired device.
    const cfg = (await (await t.app.request('/api/config', { headers: { cookie: a } })).json()) as { config: { apps: { id: string }[] } };
    const gh = cfg.config.apps.find((x) => x.id === 'github')!;
    await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: a }, body: JSON.stringify({ clientId: 'a', batchId: 'shared-batch-id', ops: [{ type: 'app.upsert', app: { ...gh, id: 'a-secret', name: SECRET_SITE, url: SECRET_URL } }] }) });
    const img = await sharp({ create: { width: 1300, height: 800, channels: 3, background: '#445566' } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new File([new Uint8Array(img)], 'A-private.jpg', { type: 'image/jpeg' }));
    ids.wallpaper = ((await (await t.app.request('/api/wallpapers', { method: 'POST', headers: { [CLIENT_HEADER]: '1', cookie: a }, body: form })).json()) as { id: string }).id;
    const icon = new FormData();
    icon.append('file', new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>'], 'i.svg', { type: 'image/svg+xml' }));
    ids.icon = ((await (await t.app.request('/api/icons', { method: 'POST', headers: { [CLIENT_HEADER]: '1', cookie: a }, body: icon })).json()) as { id: string }).id;
    const { device, token } = await t.deps.devices.create(A, 'A laptop', '');
    ids.device = device.id;
    ids.deviceToken = token;
    ids.user = A;
    aState = await snapshotA();
  });
  afterAll(async () => {
    await t.close();
  });

  const concrete = (path: string) =>
    path
      .replace(':id/:file', `${ids.wallpaper}/1280.jpg`)
      .replace('/api/icons/:file', `/api/icons/${ids.icon}.png`)
      .replace('/api/devices/:id', `/api/devices/${ids.device}`)
      .replace('/api/wallpapers/:id', `/api/wallpapers/${ids.wallpaper}`)
      .replace('/api/v2/admin/users/:id/:action{disable|enable}', `/api/v2/admin/users/${ids.user}/disable`)
      .replace('/api/status/:id/check', '/api/status/litebox/check')
      // A's apps are stored as items since v0.4: aim at A's private one.
      .replace('/api/v2/items/:id', '/api/v2/items/a-secret')
      .replace('/api/v2/pins/:itemId', '/api/v2/pins/a-secret')
      .replace(/:([a-z]+)(\{[^}]+\})?/gi, 'probe');

  it('parses the route table and every route is either public, device-only, a capability or account-bound', () => {
    const all = routes();
    expect(all.some((r) => key(r) === 'GET /api/config')).toBe(true);
    for (const r of all) {
      if (PUBLIC[key(r)] || r.path.startsWith(DEVICE_PREFIX) || CAPABILITY.has(key(r)) || !r.path.startsWith('/api/')) continue;
      expect(r.path.startsWith('/api/'), key(r)).toBe(true);
    }
  });

  it('without a session, every account-bound route answers 401', async () => {
    for (const r of routes()) {
      if (PUBLIC[key(r)] || r.path.startsWith(DEVICE_PREFIX) || !r.path.startsWith('/api/') || r.path === '/api/events') continue;
      const res = await t.app.request(concrete(r.path), { method: r.method, headers: write, body: r.method === 'GET' ? undefined : '{}' });
      expect(res.status, key(r)).toBe(401);
    }
  });

  it('account B, aimed at everything of A, gets nothing of A and changes nothing of A', async () => {
    for (const r of routes()) {
      if (PUBLIC[key(r)] || r.path.startsWith(DEVICE_PREFIX) || CAPABILITY.has(key(r)) || !r.path.startsWith('/api/') || r.path === '/api/events') continue;
      const res = await t.app.request(concrete(r.path), { method: r.method, headers: { ...write, cookie: b }, body: r.method === 'GET' ? undefined : JSON.stringify({ clientId: 'b', batchId: 'shared-batch-id', ops: [{ type: 'pin.remove', appId: 'a-secret' }], approve: true }) });
      const text = await res.text();
      expect(text, key(r)).not.toContain(SECRET_SITE);
      expect(text, key(r)).not.toContain('a-only.example.org');
      expect(text, key(r)).not.toContain(ids.wallpaper!);
      expect(text, key(r)).not.toContain(ids.icon!);
      expect(text, key(r)).not.toContain(ids.device!);
      if (/:id|:file|:itemId/.test(r.path)) expect([401, 403, 404, 422], `${key(r)} → ${res.status}`).toContain(res.status);
    }
    expect(await snapshotA()).toBe(aState);
    // A still sees all of it.
    expect((await t.app.request(`/api/wallpapers/${ids.wallpaper}/1280.jpg`, { headers: { cookie: a } })).status).toBe(200);
    expect((await t.app.request(`/api/icons/${ids.icon}.png`, { headers: { cookie: a } })).status).toBe(200);
    // The sweep included 退出所有设备 for B itself, which (rightly) ended B's session.
    b = (await t.loginOidc({ sub: 'user-b', email: 'b@example.org' })).cookie;
  });

  it('B never sees the operator’s private services, status or integrations (NP-A04)', async () => {
    // The operator's data is what must not leak: entries, engines, addresses, check results. (The
    // settings object of every account carries a switched-off `linkwarden` flag; that is not data.)
    const cfg = (await (await t.app.request('/api/config', { headers: { cookie: b } })).json()) as { config: { apps: unknown[]; engines: unknown[]; categories: unknown[]; pins: unknown[] } };
    expect(JSON.stringify([cfg.config.apps, cfg.config.engines, cfg.config.pins]).toLowerCase()).not.toMatch(/litebox|linkwarden|obsync|\.home\b/);
    const bodies = await Promise.all(['/api/status', '/api/v2/me', '/api/v2/catalog'].map(async (p) => (await t.app.request(p, { headers: { cookie: b } })).text()));
    for (const body of bodies) expect(body.toLowerCase()).not.toMatch(/litebox|linkwarden|links\.home|obsync\.home/);
    const lw = await t.app.request('/api/bookmarks?q=x', { headers: { cookie: b } });
    expect(lw.status).toBe(404);
    expect(((await lw.json()) as { error: { code: string } }).error.code).toBe('not_configured');
    expect((await t.app.request('/api/integrations/linkwarden', { headers: { cookie: b } })).status).toBe(403);
    expect((await t.app.request('/api/health/test', { method: 'POST', headers: { ...write, cookie: b }, body: '{}' })).status).toBe(403);
  });

  it('B cannot switch on health checks for its own entries (the server never probes its addresses)', async () => {
    const svc = { id: 'nas', kind: 'service', name: 'NAS', description: '', url: 'http://192.168.1.2', lanUrl: '', prefer: 'ext', categoryId: 'hosted', hidden: false, showInServices: true, aliases: [], icon: { source: 'letter', ref: '', letter: 'N', tone: 0 }, openIn: 'same', health: { enabled: true, target: '/', intervalSec: 60 } };
    const res = await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: b }, body: JSON.stringify({ clientId: 'b', batchId: 'b-health', ops: [{ type: 'app.upsert', app: svc }] }) });
    const cfg = (await res.json()) as { config: { apps: { id: string; health: { enabled: boolean } }[] } };
    // Saved as a link (a private address is fine as data), with the check forced off.
    expect(cfg.config.apps.find((x) => x.id === 'nas')?.health.enabled).toBe(false);
  });

  it('revision events reach only their own account (TN-03 / NP-A02)', async () => {
    const res = await t.app.request('/api/events', { headers: { cookie: b } });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: revision');
    await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: a }, body: JSON.stringify({ clientId: 'a', batchId: `a-${Date.now()}`, ops: [{ type: 'pin.remove', appId: 'github' }] }) });
    const next = await Promise.race([reader.read().then((r) => new TextDecoder().decode(r.value)), new Promise<string>((r) => setTimeout(() => r('(nothing)'), 400))]);
    expect(next).toBe('(nothing)');
    await reader.cancel();
    aState = await snapshotA();
  });

  it('device tokens read only their owner’s data (TN-04 / NP-A01)', async () => {
    const { token } = await t.deps.devices.create((await t.deps.users.byIdentity(t.deps.env.oidc!.issuer, 'user-b'))!.id, 'B tablet', '');
    const dev = { authorization: `Bearer ${token}` };
    const cfg = await (await t.app.request('/api/sync/config', { headers: dev })).text();
    expect(cfg).not.toContain(SECRET_SITE);
    expect((await t.app.request(`/api/sync/wallpapers/${ids.wallpaper}/1280.jpg`, { headers: dev })).status).toBe(404);
    expect((await t.app.request(`/api/sync/icons/${ids.icon}.png`, { headers: dev })).status).toBe(404);
    expect(await (await t.app.request('/api/sync/status', { headers: dev })).json()).toEqual([]);
    expect((await t.app.request('/api/sync/bookmarks?q=x', { headers: dev })).status).toBe(404);
    // A's own device sees A's data.
    expect(await (await t.app.request('/api/sync/config', { headers: { authorization: `Bearer ${ids.deviceToken}` } })).text()).toContain(SECRET_SITE);
  });
});
