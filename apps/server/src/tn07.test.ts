import { CLIENT_HEADER, defaultConfig } from '@nexus/shared';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_ID, type DB } from './db';
import { DIALECTS, lockStep, PG_TARGET, testDb } from './db/testing';
import { getBytes, UpstreamError } from './net/http';
import { classifyIp } from './net/ip';
import { guardedLookup, type Resolver } from './net/probe';
import { Quota } from './quota';
import { buildTestApp, write, type TestApp } from './testing/app';
import { fakeIdp } from './testing/fake-idp';
import { Users } from './users/users';
import { WallpaperStore } from './wallpapers/store';

/**
 * TN-07 (P0) — quotas, request limits and server-side fetching.
 *  - Limits are checked in the account's transaction: concurrent requests cannot go over.
 *  - Going over is QUOTA_EXCEEDED (permanent: retryable=false, details kind/limit/used); being too
 *    fast is RATE_LIMITED (429 + Retry-After). Same codes as LiteSync.
 *  - One account's flood never slows another account.
 *  - The server never fetches private, loopback, link-local/metadata or reserved addresses for
 *    anyone it should not, re-checks every redirect and every DNS answer at connect time; a private
 *    address may be saved as a bookmark but makes the server contact nothing.
 */
const jpeg = (w: number, h: number, color = '#335577') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer();
const upload = async (t: TestApp, cookie: string, path: '/api/wallpapers' | '/api/icons', bytes: Buffer, name: string, type: string) => {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return t.app.request(path, { method: 'POST', headers: { [CLIENT_HEADER]: '1', cookie }, body: form });
};
const json = async (res: Response) => ({ status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as Record<string, unknown> & { details?: Record<string, unknown> } });

describe('QUOTA_EXCEEDED on the configuration (TN-07)', () => {
  let t: TestApp;
  let a: string;
  beforeAll(async () => {
    t = await buildTestApp();
    a = await t.loginLegacy();
  });
  afterAll(() => t.close());

  it('the 501st app is refused as QUOTA_EXCEEDED and the 500 stay (no fallback to the template)', async () => {
    const base = (await (await t.app.request('/api/config', { headers: { cookie: a } })).json()) as { config: { apps: { id: string }[] } };
    const template = defaultConfig().apps.find((x) => x.kind === 'site')!;
    const missing = 500 - base.config.apps.length;
    // Fill up to exactly 500 in batches of 100 ops.
    for (let i = 0; i < missing; i += 100) {
      const ops = Array.from({ length: Math.min(100, missing - i) }, (_, k) => ({ type: 'app.upsert', app: { ...template, id: `fill-${i + k}`, name: `填充 ${i + k}`, url: `https://f${i + k}.example.org/` } }));
      expect((await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: a }, body: JSON.stringify({ clientId: 'c', batchId: `fill-${i}`, ops }) })).status).toBe(200);
    }
    const over = await json(await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: a }, body: JSON.stringify({ clientId: 'c', batchId: 'one-too-many', ops: [{ type: 'app.upsert', app: { ...template, id: 'one-too-many', name: '多一个', url: 'https://more.example.org/' } }] }) }));
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false, details: { kind: 'apps', limit: 500, used: 500 }, error: { code: 'quota_exceeded' } });
    const after = (await (await t.app.request('/api/config', { headers: { cookie: a } })).json()) as { config: { apps: { id: string }[] } };
    expect(after.config.apps).toHaveLength(500);
    expect(after.config.apps.some((x) => x.id === 'fill-0')).toBe(true);
  });
});

describe('storage quotas of a member account (TN-07)', () => {
  let t: TestApp;
  let member: string;
  let admin: string;
  beforeAll(async () => {
    t = await buildTestApp({ idp: await fakeIdp(), legacyPasswordLogin: 'on', quotas: { wallpapers: 2, icons: 2, storageBytes: 5 * 1024 * 1024 } });
    member = (await t.loginOidc({ sub: 'member-1', email: 'm@example.org' })).cookie;
    admin = await t.loginLegacy();
  });
  afterAll(() => t.close());

  it('the third wallpaper is QUOTA_EXCEEDED (409, kind/limit/used) and leaves no files behind', async () => {
    const img = await jpeg(1300, 800);
    expect((await upload(t, member, '/api/wallpapers', img, 'a.jpg', 'image/jpeg')).status).toBe(201);
    expect((await upload(t, member, '/api/wallpapers', img, 'b.jpg', 'image/jpeg')).status).toBe(201);
    const before = readdirSync(join(t.dir, 'wallpapers')).length;
    const third = await json(await upload(t, member, '/api/wallpapers', img, 'c.jpg', 'image/jpeg'));
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false, details: { kind: 'wallpapers', limit: 2, used: 2 } });
    expect(readdirSync(join(t.dir, 'wallpapers'))).toHaveLength(before);
  });

  it('the administrator (whose server it is) has no such limit', async () => {
    const img = await jpeg(1300, 800, '#553311');
    for (const n of ['1', '2', '3']) expect((await upload(t, admin, '/api/wallpapers', img, `${n}.jpg`, 'image/jpeg')).status).toBe(201);
  });

  it('icons at the limit: unused old ones make room, icons in use are never removed', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#22aa66' } }).png().toBuffer();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push(((await (await upload(t, member, '/api/icons', png, 'i.png', 'image/png')).json()) as { id: string }).id);
    // Both in use by apps: the third is refused.
    const site = defaultConfig().apps.find((x) => x.kind === 'site')!;
    const ops = ids.map((id, i) => ({ type: 'app.upsert', app: { ...site, id: `with-icon-${i}`, name: `图标 ${i}`, url: `https://i${i}.example.org/`, icon: { source: 'upload', ref: id, letter: '', tone: 0 } } }));
    expect((await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: member }, body: JSON.stringify({ clientId: 'm', batchId: 'icons', ops }) })).status).toBe(200);
    t.clock.now += 2 * 86_400_000;
    const refused = await json(await upload(t, member, '/api/icons', png, 'i.png', 'image/png'));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { kind: 'icons', limit: 2, used: 2 } });
    // One app drops its icon: that icon, now unused and old, is reclaimed for the next upload.
    expect((await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: member }, body: JSON.stringify({ clientId: 'm', batchId: 'drop', ops: [{ type: 'app.delete', appId: 'with-icon-0' }] }) })).status).toBe(200);
    expect((await upload(t, member, '/api/icons', png, 'i.png', 'image/png')).status).toBe(201);
    expect((await t.app.request(`/api/icons/${ids[1]}`, { headers: { cookie: member } })).status).toBe(200);
  });
});

describe('the storage limit in bytes (413)', () => {
  it('a picture that would not fit is QUOTA_EXCEEDED with kind storage', async () => {
    const t = await buildTestApp({ idp: await fakeIdp(), quotas: { wallpapers: 10, icons: 10, storageBytes: 1 } });
    try {
      const member = (await t.loginOidc({ sub: 'small' })).cookie;
      const res = await json(await upload(t, member, '/api/wallpapers', await jpeg(1300, 800), 'big.jpg', 'image/jpeg'));
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false, details: { kind: 'storage', limit: 1, used: 0 } });
    } finally {
      await t.close();
    }
  });
});

describe.each(DIALECTS)('quotas hold under concurrency (%s)', (dialect) => {
  let db: DB | null = null;
  let dir = '';
  afterEach(async () => {
    await db?.close();
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    db = await testDb(dialect);
    dir = mkdtempSync(join(tmpdir(), 'nexus-quota-'));
    const users = new Users(db);
    const r = await users.signIn({ issuer: 'https://id.example.test', subject: 'member' }, 'open');
    if (!r.ok) throw new Error('sign-in');
    const quota = new Quota(db, { wallpapers: join(dir, 'w'), icons: join(dir, 'i') }, async (id) => (id === LEGACY_ADMIN_ID ? null : { wallpapers: 3, icons: 10, storageBytes: 1 << 30 }));
    const store = new WallpaperStore(db, join(dir, 'w'), quota);
    const add = (n: number) => store.addRemote(r.user.id, `https://images.example.org/${n}.jpg`, `图 ${n}`, { width: 1920, height: 1080 }, '#334455', { source: 'unsplash', ref: `p${n}` });
    return { db, owner: r.user.id, add };
  }

  it('four uploads at once with room for one: exactly one lands', async () => {
    const { db, owner, add } = await setup();
    await add(1);
    await add(2);
    const results = await Promise.allSettled([3, 4, 5, 6].map(add));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as { kind: string }).kind)).toEqual(['wallpapers', 'wallpapers', 'wallpapers']);
    expect(await db.all('select id from wallpapers where owner_id = ?', [owner])).toHaveLength(3);
  });

  it.runIf(dialect === 'pg' && PG_TARGET === 'postgresql')('forced: two uploads that both counted 2 of 3 cannot both insert', async () => {
    const { db, owner, add } = await setup();
    await add(1);
    await add(2);
    const r = await lockStep(db, 'lock table wallpapers in share row exclusive mode', [], [() => add(3), () => add(4)]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await db.all('select id from wallpapers where owner_id = ?', [owner])).toHaveLength(3);
  });
});

describe('RATE_LIMITED, per account (TN-07)', () => {
  it('429 + Retry-After when one account writes too fast; another account is not affected', async () => {
    const t = await buildTestApp({ idp: await fakeIdp(), limits: { write: { rate: 0.01, burst: 3 } } });
    try {
      const a = (await t.loginOidc({ sub: 'fast' })).cookie;
      const b = (await t.loginOidc({ sub: 'calm' })).cookie;
      const op = (cookie: string, n: number) => t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie }, body: JSON.stringify({ clientId: 'c', batchId: `b-${cookie.slice(-6)}-${n}`, ops: [{ type: 'settings.patch', section: 'look', patch: { blur: n } }] }) });
      for (let i = 1; i <= 3; i++) expect((await op(a, i)).status).toBe(200);
      const limited = await json(await op(a, 4));
      expect(limited.status).toBe(429);
      expect(Number(limited.retryAfter)).toBeGreaterThanOrEqual(1);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true, details: { kind: 'write' }, error: { code: 'rate_limited' } });
      expect((await op(b, 1)).status).toBe(200);
      // Time refills the bucket.
      t.clock.now += 200_000;
      expect((await op(a, 5)).status).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('slow upstream fetches of one account cap at two in flight; the other account stays fast', async () => {
    const pending: (() => void)[] = [];
    const hang = () => new Promise<never>((_, reject) => pending.push(() => reject(new UpstreamError('timeout', '测试结束'))));
    const t = await buildTestApp({ idp: await fakeIdp(), importFetch: hang });
    try {
      const a = (await t.loginOidc({ sub: 'importer' })).cookie;
      const b = (await t.loginOidc({ sub: 'neighbour' })).cookie;
      const imp = (cookie: string) => t.app.request('/api/wallpapers/import', { method: 'POST', headers: { ...write, cookie }, body: JSON.stringify({ url: 'https://images.example.org/huge.jpg' }) });
      const inFlight = [imp(a), imp(a)];
      await new Promise((r) => setTimeout(r, 20));
      const third = await json(await imp(a));
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ code: 'RATE_LIMITED', details: { kind: 'concurrent' } });
      const started = performance.now();
      expect((await t.app.request('/api/config', { headers: { cookie: b } })).status).toBe(200);
      expect((await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: b }, body: JSON.stringify({ clientId: 'b', batchId: 'b1', ops: [{ type: 'settings.patch', section: 'look', patch: { blur: 3 } }] }) })).status).toBe(200);
      expect(performance.now() - started).toBeLessThan(1000);
      // B has its own slots.
      const bImport = imp(b);
      await new Promise((r) => setTimeout(r, 20));
      expect(pending).toHaveLength(3);
      pending.forEach((fail) => fail());
      await Promise.all([...inFlight, bImport]);
    } finally {
      await t.close();
    }
  });

  it('anonymous callers are limited per address: the public catalog, and sign-in starts', async () => {
    const t = await buildTestApp({ idp: await fakeIdp(), limits: { public: { rate: 0.01, burst: 2 }, auth: { rate: 0.01, burst: 1 } } });
    try {
      expect((await t.app.request('/api/v2/catalog')).status).toBe(200);
      expect((await t.app.request('/api/v2/catalog')).status).toBe(200);
      const third = await json(await t.app.request('/api/v2/catalog'));
      expect(third.status).toBe(429);
      expect(third.retryAfter).not.toBeNull();
      expect((await t.app.request('/auth/login')).status).toBe(302);
      const again = await t.app.request('/auth/login');
      expect(again.status).toBe(302);
      expect(again.headers.get('location')).toBe('/?auth_error=rate_limited');
    } finally {
      await t.close();
    }
  });

  it('failed password logins answer RATE_LIMITED with Retry-After', async () => {
    const t = await buildTestApp();
    try {
      const attempt = () => t.app.request('/api/auth/login', { method: 'POST', headers: write, body: JSON.stringify({ password: 'wrong password' }) });
      let last: Response | null = null;
      for (let i = 0; i < 8; i++) last = await attempt();
      const r = await json(last!);
      expect(r.status).toBe(429);
      expect(Number(r.retryAfter)).toBeGreaterThan(0);
      expect(r.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true, details: { kind: 'login' } });
    } finally {
      await t.close();
    }
  });
});

describe('server-side fetching never reaches what it must not (TN-07 · SSRF)', () => {
  it.each([
    ['100.100.100.200', 'linklocal'], // Alibaba Cloud metadata, inside CGNAT space
    ['::127.0.0.1', 'loopback'], // IPv4-compatible
    ['::a9fe:a9fe', 'linklocal'], // IPv4-compatible 169.254.169.254
    ['2002:7f00:1::', 'loopback'], // 6to4 of 127.0.0.1
    ['2002:c0a8:101::1', 'private'], // 6to4 of 192.168.1.1
    ['2002:808:808::1', 'public'], // 6to4 of 8.8.8.8
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'], // Teredo
    ['fec0::1', 'private'], // deprecated site-local
  ])('%s → %s', (ip, cls) => expect(classifyIp(ip)).toBe(cls));

  it('IPv4 written as one number, hex or octal is normalised and refused', async () => {
    for (const raw of ['http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://127.1/']) {
      expect(new URL(raw).hostname).toBe('127.0.0.1');
      await expect(getBytes(new URL(raw), { allowPrivate: false, allowLoopback: false })).rejects.toMatchObject({ kind: 'blocked' });
    }
  });

  it('every DNS answer is checked at connect time: a mixed answer, a rebinding name, a metadata name', async () => {
    const policy = { allowPrivate: false, allowLoopback: false };
    const answers: Record<string, string[][]> = {
      'mixed.example.org': [['93.184.216.34', '10.0.0.7']],
      'rebind.example.org': [['93.184.216.34'], ['127.0.0.1']],
      'metadata.google.internal': [['169.254.169.254']],
      'public.example.org': [['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']],
    };
    const resolver: Resolver = (host, _o, cb) => {
      const next = answers[host]!.length > 1 ? answers[host]!.shift()! : answers[host]![0]!;
      cb(null, next.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    };
    const lookup = guardedLookup(policy, resolver);
    const ask = (host: string) => new Promise<string>((resolve) => (lookup as unknown as (h: string, o: object, cb: (e: NodeJS.ErrnoException | null, a: unknown) => void) => void)(host, { all: true }, (e) => resolve(e ? (e.code ?? 'error') : 'ok')));
    expect(await ask('mixed.example.org')).toBe('EBLOCKED');
    expect(await ask('rebind.example.org')).toBe('ok');
    expect(await ask('rebind.example.org')).toBe('EBLOCKED'); // the same name, now pointing inside
    expect(await ask('metadata.google.internal')).toBe('EBLOCKED');
    expect(await ask('public.example.org')).toBe('ok');
  });

  describe('redirects are judged hop by hop', () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      server = createServer((req, res) => {
        const to: Record<string, string> = { '/to-metadata': 'http://169.254.169.254/latest/meta-data/', '/to-lan': 'http://10.0.0.1/admin', '/to-file': 'file:///etc/passwd', '/to-v6-mapped': 'http://[::ffff:a9fe:a9fe]/' };
        if (to[req.url!]) return res.writeHead(302, { location: to[req.url!] }).end();
        res.writeHead(200, { 'content-type': 'image/png' }).end('png');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    // The test server itself is on loopback, so loopback is allowed for the first hop only here.
    const policy = { allowPrivate: false, allowLoopback: true };
    it.each(['/to-metadata', '/to-lan', '/to-v6-mapped'])('%s is refused', async (path) => {
      await expect(getBytes(new URL(`${base}${path}`), policy)).rejects.toMatchObject({ kind: 'blocked' });
    });
    it('a redirect to another scheme is refused', async () => {
      await expect(getBytes(new URL(`${base}/to-file`), policy)).rejects.toMatchObject({ kind: 'invalid' });
    });
  });

  describe('a private address may be a bookmark, but makes the server contact nothing', () => {
    let t: TestApp;
    let member: string;
    const probes: string[] = [];
    const cdn: string[] = [];
    beforeAll(async () => {
      t = await buildTestApp({ idp: await fakeIdp() });
      member = (await t.loginOidc({ sub: 'lan-user' })).cookie;
      // Watch the two places that could reach out on the member's behalf.
      const health = t.deps.health as unknown as { probe: (u: URL) => Promise<unknown> };
      const original = health.probe;
      health.probe = async (u: URL) => {
        probes.push(String(u));
        return original(u);
      };
      const proxy = t.deps.iconProxy as unknown as { fetchFn: (u: string) => Promise<Response> };
      proxy.fetchFn = async (u: string) => {
        cdn.push(String(u));
        return new Response(null, { status: 404 });
      };
    });
    afterAll(() => t.close());

    it('saved as data, health checks off, no probe, no icon lookup about the private name', async () => {
      const site = defaultConfig().apps.find((x) => x.kind === 'service')!;
      const res = await t.app.request('/api/config/ops', { method: 'POST', headers: { ...write, cookie: member }, body: JSON.stringify({ clientId: 'm', batchId: 'lan', ops: [{ type: 'app.upsert', app: { ...site, id: 'nas', name: 'NAS', url: 'http://192.168.1.10:5000/', health: { enabled: true, target: '/', intervalSec: 60 } } }] }) });
      expect(res.status).toBe(200);
      const saved = ((await res.json()) as { config: { apps: { id: string; url: string; health: { enabled: boolean } }[] } }).config.apps.find((x) => x.id === 'nas')!;
      expect(saved.url).toBe('http://192.168.1.10:5000/');
      expect(saved.health.enabled).toBe(false);
      expect((await t.app.request('/api/health/test', { method: 'POST', headers: { ...write, cookie: member }, body: JSON.stringify({ url: 'http://192.168.1.10:5000/' }) })).status).toBe(403);
      for (const key of ['nas.lan', 'printer.local', 'router.home.arpa', 'files.internal']) expect((await t.app.request(`/api/icon-cache/fav/${key}`, { headers: { cookie: member } })).status).toBe(400);
      expect(probes).toEqual([]);
      expect(cdn).toEqual([]);
      // Controls: the watchers do see what is allowed — a public name, and the operator's own check.
      await t.app.request('/api/icon-cache/fav/github.com', { headers: { cookie: member } });
      expect(cdn).toEqual(['https://icons.duckduckgo.com/ip3/github.com.ico']);
      const admin = await t.loginLegacy();
      expect((await t.app.request('/api/health/test', { method: 'POST', headers: { ...write, cookie: admin }, body: JSON.stringify({ app: { ...site, id: 'nas', name: 'NAS', url: 'https://nas.example.org/' } }) })).status).toBe(200);
      expect(probes).toEqual(['https://nas.example.org/']);
    });

    it('importing a wallpaper from a private or loopback address is refused before any connection', async () => {
      for (const url of ['http://192.168.1.10/a.jpg', 'http://127.0.0.1:8787/api/config', 'http://[::1]/x.jpg', 'http://169.254.169.254/latest/meta-data/']) {
        const res = await t.app.request('/api/wallpapers/import', { method: 'POST', headers: { ...write, cookie: member }, body: JSON.stringify({ url }) });
        expect(res.status, url).toBeGreaterThanOrEqual(400);
        expect(res.status, url).toBeLessThan(500);
      }
    });
  });
});
