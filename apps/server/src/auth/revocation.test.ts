import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ADMIN_ID, type DB } from '../db';
import { DIALECTS, lockStep, PG_TARGET, testDb } from '../db/testing';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp, type FakeIdp } from '../testing/fake-idp';
import { SecretBox } from '../integrations/secret';
import { Users } from '../users/users';
import { Devices, Pairings } from './devices';
import { Revocations } from './revocation';

/**
 * ADR-019 §10：账号撤销的三种范围（A / B / C）与管理员停用，逐项断言 R-1…R-5。合成账号、临时数据库、
 * 模拟身份服务；真实 Keycloak 的结果另见交付说明，不以这里代替。
 */
vi.setConfig({ testTimeout: 30_000 });

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(dialect: 'sqlite' | 'pg' = 'sqlite', opts: Parameters<typeof buildTestApp>[0] = {}) {
  const idp = await fakeIdp();
  t = await buildTestApp({ dialect, idp, ...opts });
  return { t, idp };
}
const me = (t: TestApp, cookie: string) => t.app.request('/api/v2/me', { headers: { cookie } });
const accountId = async (t: TestApp, cookie: string) => ((await (await me(t, cookie)).json()) as { account: { id: string } }).account.id;
const bearer = (token: string) => ({ ...write, authorization: `Bearer ${token}` });
const readConfig = (t: TestApp, token: string) => t.app.request('/api/sync/config', { headers: bearer(token) });
const writeItem = (t: TestApp, token: string, opId: string) => t.app.request('/api/v2/items', { method: 'POST', headers: bearer(token), body: JSON.stringify({ opId, source: 'extension', item: { title: opId, url: `https://synthetic.example.org/${opId}` } }) });
const backchannel = async (t: TestApp, idp: FakeIdp, claims: { sub?: string; sid?: string }) => t.app.request('/auth/backchannel-logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ logout_token: await idp.logoutToken(claims) }) });
const approve = (t: TestApp, cookie: string, code: string) => t.app.request(`/api/devices/pairing/${code}`, { method: 'POST', headers: { ...write, cookie }, body: JSON.stringify({ approve: true }) });
const epoch = async (db: DB, id: string) => Number((await db.get<{ auth_epoch: number }>('select auth_epoch from users where id = ?', [id]))!.auth_epoch);
const ALL = ['config:read', 'items:read', 'items:write', 'pins:write'] as const;

describe.each(DIALECTS)('ADR-019 account revocation (%s)', (dialect) => {
  it('A · back-channel logout (sid, or only sub) ends web sessions only: devices and approved pairings keep working (R-3)', async () => {
    const { t, idp } = await setup(dialect);
    const a = await t.loginOidc({ sub: 'alice', sid: 'sid-a' });
    const b = await t.loginOidc({ sub: 'alice', sid: 'sid-b' });
    const id = await accountId(t, a.cookie);
    const device = await t.deps.devices.create(id, 'Chrome', '', [...ALL]);
    const pending = t.deps.pairings.start('Edge', 'ip', '');
    expect((await approve(t, b.cookie, pending.code)).status).toBe(200);
    const before = await epoch(t.db, id);

    expect((await backchannel(t, idp, { sid: 'sid-a' })).status).toBe(200);
    expect((await me(t, a.cookie)).status).toBe(401);
    expect((await me(t, b.cookie)).status).toBe(200);
    expect((await backchannel(t, idp, { sub: 'alice' })).status).toBe(200);
    expect((await me(t, b.cookie)).status).toBe(401);
    // By design (ADR-019 §2.1): ending identity-service sessions is not 退出全部设备.
    expect((await readConfig(t, device.token)).status).toBe(200);
    expect((await writeItem(t, device.token, 'after-a-logout')).status).toBe(201);
    expect((await t.deps.pairings.poll(pending.pairId, pending.secret)).status).toBe('approved');
    expect(await epoch(t.db, id)).toBe(before);
  });

  it('A · a refresh the identity service refuses ends that web session, not the devices (central disabling is 动作 D)', async () => {
    const { t, idp } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'bob' });
    const device = await t.deps.devices.create(await accountId(t, s.cookie), 'Chrome', '');
    idp.revokeRefresh('bob');
    t.clock.now += 6 * 60_000;
    expect((await me(t, s.cookie)).status).toBe(401);
    expect((await readConfig(t, device.token)).status).toBe(200);
  });

  it('B · 退出 Nexus 的全部设备: old sessions, devices (read and write), approved and in-flight grants all fail; a new sign-in and a new grant work (R-1, R-4)', async () => {
    const { t, idp } = await setup(dialect);
    const s1 = await t.loginOidc({ sub: 'carol', sid: 'c1' });
    const s2 = await t.loginOidc({ sub: 'carol', sid: 'c2' });
    const id = await accountId(t, s1.cookie);
    const old = await t.deps.devices.create(id, '旧扩展', '', [...ALL]);
    const approved = t.deps.pairings.start('已批准未领取', 'ip', '', [...ALL]);
    expect((await approve(t, s2.cookie, approved.code)).status).toBe(200);
    const asked = t.deps.pairings.start('还没批准', 'ip', '');
    const consumed = t.deps.pairings.start('已领取', 'ip', '');
    expect((await approve(t, s2.cookie, consumed.code)).status).toBe(200);
    const picked = (await t.deps.pairings.poll(consumed.pairId, consumed.secret)) as { status: string; token: string };
    expect(picked.status).toBe('approved');

    const res = await t.app.request('/api/v2/account/logout-all', { method: 'POST', headers: { ...write, cookie: s1.cookie } });
    expect(await res.json()).toEqual({ sessions: 2, devices: 2, grants: 1, endSessionUrl: null });
    for (const c of [s1.cookie, s2.cookie]) expect((await me(t, c)).status).toBe(401);
    for (const token of [old.token, picked.token]) {
      expect((await readConfig(t, token)).status).toBe(401);
      expect((await writeItem(t, token, `after-b-${token.slice(-4)}`)).status).toBe(401);
    }
    expect(await t.deps.pairings.poll(approved.pairId, approved.secret)).toEqual({ status: 'denied' });
    // A lost answer is never replayed: the consumed request is gone.
    expect(await t.deps.pairings.poll(consumed.pairId, consumed.secret)).toEqual({ status: 'expired' });
    // Nothing of the identity service was touched (B is this product only).
    expect(idp.accountLogouts).toEqual([]);

    // The list shows what happened; devices revoked by B have no token any more, even for old code.
    const s3 = await t.loginOidc({ sub: 'carol' });
    const list = (await (await t.app.request('/api/devices', { headers: { cookie: s3.cookie } })).json()) as { name: string; revokedAt?: string | null; revokedReason?: string | null }[];
    expect(list.map((d) => [d.name, !!d.revokedAt, d.revokedReason ?? null])).toEqual([
      ['旧扩展', true, 'logout-all'],
      ['已领取', true, 'logout-all'],
    ]);
    expect(await t.db.all("select id from devices where owner_id = ? and token_hash not like 'revoked:%'", [id])).toEqual([]);
    // A request asked before B and approved after it is a new grant: it works.
    expect((await approve(t, s3.cookie, asked.code)).status).toBe(200);
    const fresh = (await t.deps.pairings.poll(asked.pairId, asked.secret)) as { status: string; token: string };
    expect(fresh.status).toBe('approved');
    expect((await readConfig(t, fresh.token)).status).toBe(200);
    expect((await me(t, s3.cookie)).status).toBe(200);
  });

  it('B · a session or device carrying the previous epoch is refused, whenever it was written (the race R-4 is about)', async () => {
    const { t } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'dan' });
    const id = await accountId(t, s.cookie);
    const device = await t.deps.devices.create(id, 'Chrome', '');
    // Rows written by a sign-in / pick-up that read the epoch just before a revocation committed.
    await t.db.run('update users set auth_epoch = auth_epoch + 1 where id = ?', [id]);
    expect((await me(t, s.cookie)).status).toBe(401);
    expect((await readConfig(t, device.token)).status).toBe(401);
  });

  it('R-2 · the epoch only grows: B, admin disable and enable never bring an older one back', async () => {
    const { t } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'eve' });
    const id = await accountId(t, s.cookie);
    const seen = [await epoch(t.db, id)];
    await t.deps.revocations!.revokeProduct(id, 'logout-all');
    seen.push(await epoch(t.db, id));
    await t.deps.revocations!.disable(id);
    seen.push(await epoch(t.db, id));
    await t.deps.users.setDisabled(id, false);
    seen.push(await epoch(t.db, id));
    expect(seen).toEqual([0, 1, 2, 2]);
  });

  it('C · 退出所有产品与设备: B here, every identity-service session via the user’s own token, the back-channel that follows is plain A, and the answer reports each part', async () => {
    const { t, idp } = await setup(dialect);
    const web = await t.loginOidc({ sub: 'frank', sid: 'f-browser-1' });
    await t.loginOidc({ sub: 'frank', sid: 'f-browser-2' });
    const id = await accountId(t, web.cookie);
    const device = await t.deps.devices.create(id, 'Chrome', '', [...ALL]);
    const ended: number[] = [];
    // Keycloak then sends a back-channel logout for each session it ended: handled as A, no error, no second B.
    idp.onSessionsEnded = async (_sub, sids) => {
      for (const sid of sids) ended.push((await backchannel(t, idp, { sid })).status);
    };
    const res = await t.app.request('/api/v2/account/revoke-everywhere', { method: 'POST', headers: { ...write, cookie: web.cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, local: { state: 'done', revokedSessions: 2, revokedDevices: 1, revokedGrants: 0 }, identityCenter: { state: 'done' }, peers: [{ product: 'litesync', state: 'not_configured' }] });
    expect(idp.accountLogouts).toEqual(['frank']);
    expect(ended).toEqual([200, 200]);
    expect(await epoch(t.db, id)).toBe(1);
    expect((await readConfig(t, device.token)).status).toBe(401);
    expect(idp.sessionsOf('frank')).toEqual([]);
    // Signing in again is allowed (C is no disabling) and starts clean.
    const again = await t.loginOidc({ sub: 'frank' });
    expect((await me(t, again.cookie)).status).toBe(200);
  });

  it.each([
    ['forbidden', 'forbidden'],
    ['down', 'unavailable'],
  ] as const)('C · identity service %s: the local part is still done, the failure is reported with where to finish by hand (R-5)', async (mode, error) => {
    const { t, idp } = await setup(dialect);
    const web = await t.loginOidc({ sub: 'gina' });
    const device = await t.deps.devices.create(await accountId(t, web.cookie), 'Chrome', '');
    idp.accountApi = mode;
    const body = await (await t.app.request('/api/v2/account/revoke-everywhere', { method: 'POST', headers: { ...write, cookie: web.cookie } })).json();
    expect(body).toMatchObject({ ok: false, local: { state: 'done', revokedSessions: 1, revokedDevices: 1 }, identityCenter: { state: 'failed', error, accountUrl: `${idp.issuer}/account` } });
    expect((await readConfig(t, device.token)).status).toBe(401);
    expect(idp.sessionsOf('gina')).toHaveLength(1);
  });

  it('C · from a password session of a linked administrator, the identity-service step reports it cannot act; an account without unified identity is refused', async () => {
    const { t, idp } = await setup(dialect, { legacyPasswordLogin: 'on' });
    const legacy = await t.loginLegacy();
    expect((await t.app.request('/api/v2/account/revoke-everywhere', { method: 'POST', headers: { ...write, cookie: legacy } })).status).toBe(409);
    await t.deps.users.link(LEGACY_ADMIN_ID, { issuer: idp.issuer, subject: 'owner' });
    const again = await t.loginLegacy();
    const body = await (await t.app.request('/api/v2/account/revoke-everywhere', { method: 'POST', headers: { ...write, cookie: again } })).json();
    expect(body).toMatchObject({ ok: false, local: { state: 'done' }, identityCenter: { state: 'failed', error: 'no_identity_session' } });
    expect(idp.accountLogouts).toEqual([]);
  });

  it('revocation racing a pick-up never leaves a valid device (R-4), however the two interleave', async () => {
    const { t } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'hank' });
    const id = await accountId(t, s.cookie);
    for (let i = 0; i < 6; i++) {
      const cookie = (await t.loginOidc({ sub: 'hank' })).cookie;
      const p = t.deps.pairings.start(`race-${i}`, `10.1.0.${i}`, '');
      expect((await approve(t, cookie, p.code)).status).toBe(200);
      const [polled] = await Promise.all([t.deps.pairings.poll(p.pairId, p.secret), t.deps.revocations!.revokeProduct(id, 'logout-all')]);
      if (polled.status === 'approved') expect(await t.deps.devices.validate(polled.token)).toBeNull();
      else expect(polled.status).toBe('denied');
    }
  });
});

describe('复审反例转正（nexus-repro.mts 的 NEX-02 / NEX-03 段，期望正确行为）', () => {
  it('NEX-03 · approved before 退出全部设备, picked up after: denied, no token', async () => {
    const { t } = await setup('sqlite');
    const other = await t.loginOidc({ sub: 'audit-other' });
    const ownerId = await accountId(t, other.cookie);
    const localDevice = await t.deps.devices.create(ownerId, 'local logout check', 'review', ['config:read']);
    const pending = t.deps.pairings.start('approved before logout', 'synthetic-review', 'review', ['config:read', 'items:write']);
    // As in the repro: approved straight on the pairing store (no epoch given → 0, the account's epoch then).
    t.deps.pairings.decide(pending.code, true, ownerId);
    const all = await t.app.request('/api/v2/account/logout-all', { method: 'POST', headers: { ...write, cookie: other.cookie } });
    expect(await all.json()).toMatchObject({ sessions: 1, devices: 1, grants: 1, endSessionUrl: null });
    expect((await readConfig(t, localDevice.token)).status).toBe(401);
    // Old result: { grantStatus: 'approved', deviceRead: 200 }.
    expect(await t.deps.pairings.poll(pending.pairId, pending.secret)).toEqual({ status: 'denied' });
  });

  it('NEX-02 · after the unified identity signs out everywhere (动作 C) the old extension can neither read nor write', async () => {
    const { t, idp } = await setup('sqlite');
    const a = await t.loginOidc({ sub: 'audit-person', sid: 'audit-sid-a' });
    await t.loginOidc({ sub: 'audit-person', sid: 'audit-sid-b' });
    const device = await t.deps.devices.create(await accountId(t, a.cookie), 'Synthetic review extension', 'review', [...ALL]);
    idp.onSessionsEnded = async (_sub, sids) => {
      for (const sid of sids) await backchannel(t, idp, { sid });
    };
    expect((await t.app.request('/api/v2/account/revoke-everywhere', { method: 'POST', headers: { ...write, cookie: a.cookie } })).status).toBe(200);
    // Old result after the sub logout: deviceRead 200, deviceWrite 201.
    expect((await readConfig(t, device.token)).status).toBe(401);
    expect((await writeItem(t, device.token, 'audit-after-everywhere')).status).toBe(401);
  });
});

/**
 * Real PostgreSQL only: a separate session holds the account row until both the revocation and the
 * pick-up are queued on it, then lets them go together — both orders must end without a valid
 * device. Plus a burst of unforced races (transactions really interleave on a pool).
 */
describe.runIf(PG_TARGET === 'postgresql')('revocation × pick-up, forced interleavings (real PostgreSQL)', () => {
  let db: DB | null = null;
  afterEach(async () => {
    await db?.close();
    db = null;
  });

  const arrange = async () => {
    db = await testDb('pg');
    await db.run('insert into users (id, issuer, subject, created_via, created_at) values (?, ?, ?, ?, ?)', ['u-race', 'https://id.example.test/realms/accounts', 'race', 'oidc', Date.now()]);
    const devices = new Devices(db);
    const pairings = new Pairings(devices);
    const revocations = new Revocations({ db, users: new Users(db), devices, pairings, secrets: new SecretBox(randomBytes(32)) });
    return { db, devices, pairings, revocations };
  };

  for (const lock of ['select 1 from users where id = $1 for update', 'lock table devices in share row exclusive mode']) {
    it(`both queued behind \`${lock.split(' ').slice(0, 3).join(' ')}…\`: no valid device either way`, async () => {
      const { db, devices, pairings, revocations } = await arrange();
      const p = pairings.start('race', 'ip', '');
      pairings.decide(p.code, true, 'u-race', undefined, 0);
      const r = await lockStep<unknown>(db, lock, lock.includes('$1') ? ['u-race'] : [], [() => pairings.poll(p.pairId, p.secret), () => revocations.revokeProduct('u-race', 'logout-all')]);
      expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
      const polled = (r[0] as PromiseFulfilledResult<Awaited<ReturnType<Pairings['poll']>>>).value;
      if (polled.status === 'approved') expect(await devices.validate(polled.token)).toBeNull();
      else expect(polled.status).toBe('denied');
      expect(await epoch(db, 'u-race')).toBe(1);
    });
  }

  it('thirty unforced races on a connection pool: never a valid device', async () => {
    const { db, devices, pairings, revocations } = await arrange();
    let issued = 0;
    for (let i = 0; i < 30; i++) {
      const e = await epoch(db, 'u-race');
      const p = pairings.start(`burst-${i}`, `10.2.${i}.1`, '');
      pairings.decide(p.code, true, 'u-race', undefined, e);
      const [polled] = await Promise.all([pairings.poll(p.pairId, p.secret), revocations.revokeProduct('u-race', 'logout-all')]);
      if (polled.status === 'approved') {
        issued++;
        expect(await devices.validate(polled.token)).toBeNull();
      } else expect(polled.status).toBe('denied');
    }
    expect(await epoch(db, 'u-race')).toBe(30);
    // How often the pick-up landed first (it still produced nothing usable): for the record.
    console.log(`[revocation race] 30 次中领取先完成 ${issued} 次，全部在下一次校验时失效`);
  });
});
