import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALECTS, PG_TARGET } from '../db/testing';
import { DEFAULT_LIMITS } from '../http/limits';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp, type FakeIdp } from '../testing/fake-idp';
import { ENDPOINT, signature } from './revocation';

/**
 * ADR-019 §2.4：产品之间的撤销事件。两个 Nexus 实例互为「另一个产品」——发送方与接收方用的是同一份
 * 协议实现（签名串、字段、返回码与 LiteSync 一侧约定一致），身份服务共用一个模拟实例，所以同一个
 * (issuer, subject) 在两边各有一个本地账号，本地 user_id 不同。
 */
vi.setConfig({ testTimeout: 30_000 });

const SECRET = 'synthetic-peer-secret-0123456789abcdef';
const apps: TestApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** `a` is configured with `b` as its peer (and the other way round, when `both`). `down` cuts the link. */
async function pair(dialect: 'sqlite' | 'pg', opts: { secretB?: string; both?: boolean } = {}) {
  const idp = await fakeIdp();
  const link = { down: false, calls: 0 };
  let a: TestApp;
  let b: TestApp;
  const via = (target: () => TestApp): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      link.calls++;
      if (link.down) throw new TypeError('fetch failed');
      const url = new URL(input instanceof Request ? input.url : String(input));
      return target().app.request(url.pathname, init);
    }) as typeof fetch;
  a = await buildTestApp({ dialect, idp, peer: { product: 'litesync', url: 'http://peer.internal:8080', secret: SECRET }, peerFetch: via(() => b) });
  b = await buildTestApp({ dialect, idp, peer: opts.both === false ? null : { product: 'litesync', url: 'http://peer.internal:8080', secret: opts.secretB ?? SECRET }, peerFetch: via(() => a) });
  apps.push(a, b);
  return { a, b, idp, link };
}

const accountId = async (t: TestApp, cookie: string) => ((await (await t.app.request('/api/v2/me', { headers: { cookie } })).json()) as { account: { id: string } }).account.id;
const readConfig = (t: TestApp, token: string) => t.app.request('/api/sync/config', { headers: { authorization: `Bearer ${token}` } });
const everywhere = (t: TestApp, cookie: string) => t.app.request('/api/v2/account/revoke-everywhere', { method: 'POST', headers: { ...write, cookie } });
type Everywhere = { ok: boolean; peers: { eventId: string; state: string; nextAttemptAt: string }[] };
const epoch = async (t: TestApp, id: string) => Number((await t.db.get<{ auth_epoch: number }>('select auth_epoch from users where id = ?', [id]))!.auth_epoch);
const event = (o: Partial<Record<string, unknown>> = {}) => JSON.stringify({ v: 1, eventId: 'ab'.repeat(16), issuer: 'https://id.example.test/realms/accounts', subject: 'pat', scope: 'all-products-all-devices', reason: 'user-request', origin: 'litesync', occurredAt: '2026-11-21T07:00:00Z', ...o });
const post = (t: TestApp, body: string, o: { secret?: string; ts?: number; sig?: string | null } = {}) => {
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-revocation-timestamp': ts };
  if (o.sig !== null) headers['x-revocation-signature'] = o.sig ?? signature(o.secret ?? SECRET, ts, body);
  return t.app.request(ENDPOINT, { method: 'POST', headers, body });
};

describe('the signature string (shared with LiteSync, ADR-019 §2.4)', () => {
  // Fixed vector, computed independently with `openssl dgst -sha256 -hmac <secret>` over
  // "<timestamp>.<body>": the other product's implementation must produce the same string.
  it('is v1=hex(HMAC-SHA256(secret as UTF-8 bytes, timestamp + "." + raw body))', () => {
    const body = '{"v":1,"eventId":"00112233445566778899aabbccddeeff","issuer":"https://accounts.example.com/realms/accounts","subject":"6d767bc8-2754-47d1-a6b8-f58b6587ec7b","scope":"all-products-all-devices","reason":"user-request","origin":"litesync","occurredAt":"2026-11-21T07:00:00Z"}';
    expect(signature('0123456789abcdef0123456789abcdef', '1795244400', body)).toBe('v1=2a1be7920f41d24348685b4e28ca00c26edf5da13a2440e5d8030d8f85d2417c');
    expect(signature('0123456789abcdef0123456789abcdef', '1795244400', new TextEncoder().encode(body))).toBe('v1=2a1be7920f41d24348685b4e28ca00c26edf5da13a2440e5d8030d8f85d2417c');
  });
});

describe.each(DIALECTS)('cross-product revocation events (%s)', (dialect) => {
  it('C in one product revokes the same identity in the other: its sessions, devices and approved pairings; delivered and reported', async () => {
    const { a, b, idp } = await pair(dialect);
    const inA = await a.loginOidc({ sub: 'pat', email: 'pat@example.org' });
    const inB = await b.loginOidc({ sub: 'pat', email: 'pat@example.org' });
    const idB = await accountId(b, inB.cookie);
    expect(idB).not.toBe(await accountId(a, inA.cookie)); // never the other product's local id
    const deviceB = await b.deps.devices.create(idB, 'Obsidian 设备（另一产品）', '', ['config:read', 'items:write']);
    const pendingB = b.deps.pairings.start('待领取', 'ip', '');
    expect((await b.app.request(`/api/devices/pairing/${pendingB.code}`, { method: 'POST', headers: { ...write, cookie: inB.cookie }, body: JSON.stringify({ approve: true }) })).status).toBe(200);
    // Someone else in the other product is not touched.
    const other = await b.loginOidc({ sub: 'quinn' });

    const res = (await (await everywhere(a, inA.cookie)).json()) as Everywhere;
    expect(res).toMatchObject({ ok: true, identityCenter: { state: 'done' }, peers: [{ product: 'litesync', state: 'delivered', attempts: 1, result: 'applied', error: null, nextAttemptAt: null }] });
    expect(res.peers[0]!.eventId).toMatch(/^[0-9a-f]{32}$/);
    expect((await b.app.request('/api/v2/me', { headers: { cookie: inB.cookie } })).status).toBe(401);
    expect((await readConfig(b, deviceB.token)).status).toBe(401);
    expect(await b.deps.pairings.poll(pendingB.pairId, pendingB.secret)).toEqual({ status: 'denied' });
    expect((await b.app.request('/api/v2/me', { headers: { cookie: other.cookie } })).status).toBe(200);
    // B records it as received (the audit), and does not forward it anywhere.
    const again = await b.loginOidc({ sub: 'pat' });
    const status = (await (await b.app.request('/api/v2/account/revocations', { headers: { cookie: again.cookie } })).json()) as { events: { direction: string; product: string; state: string }[] };
    expect(status.events).toEqual([expect.objectContaining({ direction: 'incoming', product: 'nexus', state: 'applied' })]);
    expect(await b.db.all('select id from revocation_outbox')).toEqual([]);
    expect(idp.accountLogouts).toEqual(['pat']);
  });

  it('the other product unreachable: pending with the real attempt count, retried in the background 5 s, 15 s, 30 s, 30 s …, then delivered', async () => {
    const { a, b, link } = await pair(dialect);
    const inA = await a.loginOidc({ sub: 'pat' });
    const inB = await b.loginOidc({ sub: 'pat' });
    const deviceB = await b.deps.devices.create(await accountId(b, inB.cookie), 'Obsidian', '');
    link.down = true;
    const res = (await (await everywhere(a, inA.cookie)).json()) as Everywhere;
    expect(res).toMatchObject({ ok: false, identityCenter: { state: 'done' }, peers: [{ state: 'pending', attempts: 1, error: 'network' }] });
    expect(Date.parse(res.peers[0]!.nextAttemptAt) - a.clock.now).toBe(5_000);
    expect((await readConfig(b, deviceB.token)).status).toBe(200);
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const row = (await a.db.get<{ next_attempt_at: number }>('select next_attempt_at from revocation_outbox'))!;
      delays.push(Number(row.next_attempt_at) - a.clock.now);
      a.clock.now = Number(row.next_attempt_at);
      expect(await a.deps.revocations!.deliverDue()).toBe(1);
    }
    expect(delays).toEqual([5_000, 15_000, 30_000, 30_000]);
    link.down = false;
    a.clock.now += 30_000;
    await a.deps.revocations!.deliverDue();
    expect(await a.db.get('select state, attempts, result from revocation_outbox')).toEqual({ state: 'delivered', attempts: 6, result: 'applied' });
    expect((await readConfig(b, deviceB.token)).status).toBe(401);
  });

  it('a wrong secret is 401 at the receiver: failed at once, not retried, and the administrator sees why', async () => {
    const { a, b, link } = await pair(dialect, { secretB: 'another-secret-0123456789abcdefghij' });
    const inA = await a.loginOidc({ sub: 'pat' });
    const inB = await b.loginOidc({ sub: 'pat' });
    const res = (await (await everywhere(a, inA.cookie)).json()) as Everywhere;
    expect(res.peers).toEqual([expect.objectContaining({ state: 'failed', error: 'signature_rejected', attempts: 1, nextAttemptAt: null })]);
    const calls = link.calls;
    a.clock.now += 3_600_000;
    expect(await a.deps.revocations!.deliverDue()).toBe(0);
    expect(link.calls).toBe(calls);
    expect((await b.app.request('/api/v2/me', { headers: { cookie: inB.cookie } })).status).toBe(200);
    const admin = await a.loginLegacy();
    expect(await (await a.app.request('/api/v2/admin/revocation-status', { headers: { cookie: admin } })).json()).toMatchObject({ peer: { configured: true, failed: 1, lastError: 'signature_rejected' } });
  });

  it('after 7 days without delivery it is failed (expired); resending by hand starts a new window and delivers', async () => {
    const { a, b, link } = await pair(dialect);
    const inA = await a.loginOidc({ sub: 'pat' });
    const inB = await b.loginOidc({ sub: 'pat' });
    link.down = true;
    const id = ((await (await everywhere(a, inA.cookie)).json()) as { peers: { eventId: string }[] }).peers[0]!.eventId;
    a.clock.now += 7 * 86_400_000 + 1;
    await a.deps.revocations!.deliverDue();
    expect(await a.db.get('select state, last_error from revocation_outbox')).toEqual({ state: 'failed', last_error: 'expired' });
    const back = await a.loginOidc({ sub: 'pat' });
    const listed = (await (await a.app.request('/api/v2/account/revocations', { headers: { cookie: back.cookie } })).json()) as { peer: unknown; events: { eventId: string; state: string; error: string }[] };
    expect(listed.peer).toEqual({ product: 'litesync', configured: true });
    expect(listed.events).toEqual([expect.objectContaining({ eventId: id, direction: 'outgoing', state: 'failed', error: 'expired' })]);
    link.down = false;
    const retried = await a.app.request(`/api/v2/account/revocations/${id}/retry`, { method: 'POST', headers: { ...write, cookie: back.cookie } });
    expect(await retried.json()).toMatchObject({ eventId: id, state: 'delivered', result: 'applied' });
    expect((await b.app.request('/api/v2/me', { headers: { cookie: inB.cookie } })).status).toBe(401);
    // Nobody else can resend it; an unknown id is not found.
    const intruder = await a.loginOidc({ sub: 'mallory' });
    expect((await a.app.request(`/api/v2/account/revocations/${id}/retry`, { method: 'POST', headers: { ...write, cookie: intruder.cookie } })).status).toBe(404);
  });

  it('receiver: a repeated event is applied once and answered the same; an unknown identity is 200 unknown-identity', async () => {
    const { b } = await pair(dialect);
    const s = await b.loginOidc({ sub: 'pat' });
    const id = await accountId(b, s.cookie);
    const body = event();
    const first = await post(b, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ applied: true });
    const replay = await post(b, body);
    expect(await replay.json()).toEqual({ applied: true });
    expect(await epoch(b, id)).toBe(1);
    const unknown = await post(b, event({ eventId: 'cd'.repeat(16), subject: 'nobody-here' }));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ applied: false, reason: 'unknown-identity' });
  });

  it('receiver: signature, timestamp window and format are enforced before anything happens', async () => {
    const { b } = await pair(dialect);
    const s = await b.loginOidc({ sub: 'pat' });
    const id = await accountId(b, s.cookie);
    const body = event();
    const now = Math.floor(Date.now() / 1000);
    expect((await post(b, body, { secret: 'not-the-shared-secret-0123456789abcdef' })).status).toBe(401);
    expect((await post(b, body, { sig: null })).status).toBe(401);
    expect((await post(b, body, { sig: 'v1=zz' })).status).toBe(401);
    expect((await post(b, body, { ts: now - 301 })).status).toBe(401);
    expect((await post(b, body, { ts: now + 301 })).status).toBe(401);
    // The signature covers the raw bytes: any change to the body breaks it.
    const ts = String(now);
    expect((await b.app.request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-revocation-timestamp': ts, 'x-revocation-signature': signature(SECRET, ts, body) }, body: body.replace('pat', 'paz') })).status).toBe(401);
    for (const bad of ['not json', event({ v: 2 }), event({ eventId: 'short' }), event({ scope: 'grant-everything' }), event({ subject: '' }), event({ occurredAt: 'yesterday' })]) expect((await post(b, bad)).status, bad).toBe(400);
    expect(await epoch(b, id)).toBe(0);
    expect((await b.app.request('/api/v2/me', { headers: { cookie: s.cookie } })).status).toBe(200);
  });

  it('receiver without cross-product revocation configured refuses every event (401)', async () => {
    const { b } = await pair(dialect, { both: false });
    await b.loginOidc({ sub: 'pat' });
    expect((await post(b, event())).status).toBe(401);
  });

  it('two deliveries of the same event at once: applied exactly once', async () => {
    const { b } = await pair(dialect);
    const s = await b.loginOidc({ sub: 'pat' });
    const id = await accountId(b, s.cookie);
    const body = event({ eventId: 'ef'.repeat(16) });
    const answers = await Promise.all([post(b, body), post(b, body), post(b, body)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await Promise.all(answers.map((r) => r.json()))).toEqual([{ applied: true }, { applied: true }, { applied: true }]);
    expect(await epoch(b, id)).toBe(1);
  });

  it('the internal endpoint has its own per-address limit', async () => {
    const idp = await fakeIdp();
    const t = await buildTestApp({ dialect, idp, peer: { product: 'litesync', url: 'http://peer.internal', secret: SECRET }, limits: { ...DEFAULT_LIMITS, internal: { rate: 0.0001, burst: 2 } } });
    apps.push(t);
    expect((await post(t, event({ eventId: '01'.repeat(16) }))).status).toBe(200);
    expect((await post(t, event({ eventId: '02'.repeat(16) }))).status).toBe(200);
    expect((await post(t, event({ eventId: '03'.repeat(16) }))).status).toBe(429);
  });
});

describe.runIf(PG_TARGET === 'postgresql')('cross-product events on real PostgreSQL', () => {
  it('the same event delivered five times concurrently on a connection pool: one revocation', async () => {
    const { b } = await pair('pg');
    const s = await b.loginOidc({ sub: 'pat' });
    const id = await accountId(b, s.cookie);
    const body = event({ eventId: '9a'.repeat(16) });
    const answers = await Promise.all(Array.from({ length: 5 }, () => post(b, body)));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await epoch(b, id)).toBe(1);
    expect(await b.db.get('select count(*) as n from revocation_inbox')).toEqual({ n: 1 });
  });
});

export type { FakeIdp };
