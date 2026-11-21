import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALECTS } from '../db/testing';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp } from '../testing/fake-idp';

/**
 * ADR-019 §2.5 · 动作 D（中心停用 / 删除）与 §2.6（事件流复核）。模拟身份服务按 Keycloak 26.8 的实测
 * 行为建模：停用 → enabled:false，删除 → 404，服务账号缺角色 → 403（配置错误，不是停用）。
 */
vi.setConfig({ testTimeout: 30_000 });

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(dialect: 'sqlite' | 'pg', opts: Parameters<typeof buildTestApp>[0] = {}) {
  const idp = await fakeIdp();
  t = await buildTestApp({ dialect, idp, centralCheck: true, ...opts });
  return { t, idp };
}
const me = (t: TestApp, cookie: string) => t.app.request('/api/v2/me', { headers: { cookie } });
const accountId = async (t: TestApp, cookie: string) => ((await (await me(t, cookie)).json()) as { account: { id: string } }).account.id;
const readConfig = (t: TestApp, token: string) => t.app.request('/api/sync/config', { headers: { authorization: `Bearer ${token}` } });
const readItems = (t: TestApp, token: string) => t.app.request('/api/v2/items', { headers: { authorization: `Bearer ${token}` } });
const userLookups = (idp: { adminRequests: string[] }) => idp.adminRequests.filter((r) => r.startsWith('GET ')).length;
const SECOND = 1_000;

describe.each(DIALECTS)('中心停用检查 (%s)', (dialect) => {
  it('stopped in the identity service: within 60 s (plus one check) devices and web sessions are refused, and 动作 B ran here (R-7)', async () => {
    const { t, idp } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'ivy' });
    const id = await accountId(t, s.cookie);
    const device = await t.deps.devices.create(id, 'Chrome', '', ['config:read', 'items:read']);
    const pending = t.deps.pairings.start('待领取', 'ip', '');
    expect((await t.app.request(`/api/devices/pairing/${pending.code}`, { method: 'POST', headers: { ...write, cookie: s.cookie }, body: JSON.stringify({ approve: true }) })).status).toBe(200);
    // Signing in just confirmed the account: no lookup is needed for a minute.
    expect((await readConfig(t, device.token)).status).toBe(200);
    expect(userLookups(idp)).toBe(0);
    idp.setUser('ivy', 'disabled');
    t.clock.now += 30 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(200); // inside the window
    t.clock.now += 31 * SECOND;
    const refused = await readConfig(t, device.token);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('device_unauthorized');
    expect(userLookups(idp)).toBe(1);
    expect((await me(t, s.cookie)).status).toBe(401);
    expect(await t.deps.pairings.poll(pending.pairId, pending.secret)).toEqual({ status: 'denied' });
    expect(await t.db.get('select auth_epoch from users where id = ?', [id])).toEqual({ auth_epoch: 1 });
    const devices = await t.db.all<{ revoked_reason: string }>('select revoked_reason from devices where owner_id = ?', [id]);
    expect(devices).toEqual([{ revoked_reason: 'central-disabled' }]);
    // Enabled again at the identity service: signing in works, the old device does not (R-2).
    idp.setUser('ivy', 'enabled');
    const again = await t.loginOidc({ sub: 'ivy' });
    expect((await me(t, again.cookie)).status).toBe(200);
    t.clock.now += 61 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(401);
  });

  it('deleted in the identity service (404): 动作 B with reason account-deleted; v2 device requests too', async () => {
    const { t, idp } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'jo' });
    const id = await accountId(t, s.cookie);
    const device = await t.deps.devices.create(id, 'Chrome', '', ['config:read', 'items:read']);
    idp.setUser('jo', 'deleted');
    t.clock.now += 61 * SECOND;
    const r = await readItems(t, device.token);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: string }).code).toBe('DEVICE_REVOKED');
    expect(await t.db.all('select revoked_reason from devices where owner_id = ?', [id])).toEqual([{ revoked_reason: 'account-deleted' }]);
  });

  it('one lookup per account per minute, however many requests arrive at once', async () => {
    const { t, idp } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'kai' });
    const device = await t.deps.devices.create(await accountId(t, s.cookie), 'Chrome', '');
    t.clock.now += 61 * SECOND;
    const all = await Promise.all(Array.from({ length: 6 }, () => readConfig(t, device.token)));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(userLookups(idp)).toBe(1);
    t.clock.now += 59 * SECOND;
    await readConfig(t, device.token);
    expect(userLookups(idp)).toBe(1);
    t.clock.now += 2 * SECOND;
    await readConfig(t, device.token);
    expect(userLookups(idp)).toBe(2);
  });

  it('identity service unreachable: let through for 15 minutes, retried once a minute; then devices get 503 IDENTITY_UNAVAILABLE, web sessions stay', async () => {
    const { t, idp } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'lee' });
    const id = await accountId(t, s.cookie);
    const device = await t.deps.devices.create(id, 'Chrome', '');
    idp.adminApi = 'down';
    t.clock.now += 61 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(200);
    expect(userLookups(idp)).toBe(1);
    t.clock.now += 30 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(200);
    expect(userLookups(idp)).toBe(1); // not before 60 s
    t.clock.now += 14 * 60 * SECOND;
    const late = await readConfig(t, device.token);
    expect(late.status).toBe(503);
    expect(await late.json()).toMatchObject({ code: 'IDENTITY_UNAVAILABLE', retryable: true });
    expect(late.headers.get('retry-after')).toBe('60');
    // Not a revocation: nothing was revoked, the web session goes on (ADR-011 refresh grace applies).
    expect(await t.db.get('select auth_epoch from users where id = ?', [id])).toEqual({ auth_epoch: 0 });
    expect((await me(t, s.cookie)).status).toBe(200);
    idp.adminApi = 'ok';
    t.clock.now += 61 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(200);
  });

  it.each(['none', 'refused'] as const)('service account %s (configuration error): never treated as disabled; past the grace, 503 for devices', async (mode) => {
    const { t, idp } = await setup(dialect);
    const s = await t.loginOidc({ sub: 'max' });
    const id = await accountId(t, s.cookie);
    const device = await t.deps.devices.create(id, 'Chrome', '');
    idp.serviceAccount = mode;
    idp.setUser('max', 'disabled');
    t.clock.now += 61 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(200);
    t.clock.now += 15 * 60 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(503);
    expect(await t.db.get('select auth_epoch from users where id = ?', [id])).toEqual({ auth_epoch: 0 });
    const admin = await t.loginLegacy();
    expect(await (await t.app.request('/api/v2/admin/revocation-status', { headers: { cookie: admin } })).json()).toMatchObject({ centralCheck: { configured: true, lastError: mode === 'none' ? 'forbidden' : 'token' } });
  });

  it('the legacy administrator without a unified identity is never looked up', async () => {
    const { t, idp } = await setup(dialect, { legacyPasswordLogin: 'on' });
    const admin = await t.loginLegacy();
    const device = await t.deps.devices.create('legacy-admin', 'Chrome', '');
    t.clock.now += 3_600 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(200);
    expect((await me(t, admin)).status).toBe(200);
    expect(idp.adminRequests).toEqual([]);
  });

  it('not configured: no lookups at all (stopping someone centrally then needs B or disabling here)', async () => {
    const idp = await fakeIdp();
    t = await buildTestApp({ dialect, idp });
    const s = await t.loginOidc({ sub: 'ned' });
    const device = await t.deps.devices.create(await accountId(t, s.cookie), 'Chrome', '');
    idp.setUser('ned', 'disabled');
    t.clock.now += 61 * SECOND;
    expect((await readConfig(t, device.token)).status).toBe(200);
    expect(idp.adminRequests).toEqual([]);
    const status = (await (await t.app.request('/api/v2/account/revocations', { headers: { cookie: s.cookie } })).json()) as { centralCheck: { configured: boolean }; peer: { configured: boolean } };
    expect(status).toMatchObject({ centralCheck: { configured: false }, peer: { configured: false } });
  });
});

describe('/api/events re-checks its session every 15 s (ADR-019 §2.6)', () => {
  const opened = async (t: TestApp, cookie: string) => {
    const res = await t.app.request('/api/events', { headers: { cookie } });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: revision');
    /** True once the server ends the stream; false when it is still open (pinging) a second later. */
    return async () => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const r = await Promise.race([reader.read(), new Promise<'quiet'>((ok) => setTimeout(() => ok('quiet'), 250))]);
        if (r !== 'quiet' && r.done) return true;
      }
      await reader.cancel();
      return false;
    };
  };

  it('B elsewhere closes the open stream; a stream of another account stays', async () => {
    const idp = await fakeIdp();
    t = await buildTestApp({ idp, sseRecheckMs: 30 });
    const a = await t.loginOidc({ sub: 'olga' });
    const other = await t.loginOidc({ sub: 'pia' });
    const endedA = await opened(t, a.cookie);
    const endedOther = await opened(t, other.cookie);
    await t.deps.revocations!.revokeProduct(await accountId(t, a.cookie), 'logout-all');
    expect(await endedA()).toBe(true);
    expect(await endedOther()).toBe(false);
  });

  it('stopped in the identity service: the stream closes at its next re-check', async () => {
    const idp = await fakeIdp();
    t = await buildTestApp({ idp, centralCheck: true, sseRecheckMs: 30 });
    const a = await t.loginOidc({ sub: 'quill' });
    const ended = await opened(t, a.cookie);
    idp.setUser('quill', 'disabled');
    t.clock.now += 61 * SECOND;
    expect(await ended()).toBe(true);
  });
});
