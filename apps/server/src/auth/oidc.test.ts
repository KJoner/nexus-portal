import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_ID } from '../db';
import { buildTestApp, cookieOf, write, type TestApp } from '../testing/app';
import { fakeIdp, type FakeIdp } from '../testing/fake-idp';
import { safeReturnTo } from './intents';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(opts: Parameters<typeof buildTestApp>[0] = {}) {
  const idp = await fakeIdp();
  t = await buildTestApp({ idp, ...opts });
  return { t, idp };
}

/** Starts a sign-in and lets the provider issue a code, without calling back yet. */
async function begin(app: TestApp['app'], idp: FakeIdp, sub: string, returnTo?: string) {
  const start = await app.request(`/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
  expect(start.status).toBe(302);
  const authUrl = new URL(start.headers.get('location')!);
  return { intent: cookieOf(start, 'nexus_oidc')!, state: authUrl.searchParams.get('state')!, code: idp.authorize(authUrl, { sub, email: `${sub}@example.org`, name: sub }), authUrl };
}
const callback = (app: TestApp['app'], code: string, state: string, cookie: string) => app.request(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { cookie } });
const me = async (app: TestApp['app'], cookie: string) => app.request('/api/v2/me', { headers: { cookie } });

describe('unified sign-in (OIDC, ADR-011)', () => {
  it('a new identity gets its own empty account and lands where it was going', async () => {
    const { t } = await setup();
    const { cookie, location } = await t.loginOidc({ sub: 'alice', email: 'alice@example.org', name: 'Alice' }, { returnTo: '/catalog' });
    expect(location).toBe('/catalog');
    const res = await me(t.app, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: { displayName: 'Alice', email: 'alice@example.org', emailVerified: true }, role: 'user', onboarding: { state: 'empty_collection' }, session: 'oidc', identityLinked: true });
    const cfg = (await (await t.app.request('/api/config', { headers: { cookie } })).json()) as { config: { apps: unknown[]; pins: unknown[] } };
    expect(cfg.config.apps).toEqual([]);
    expect(cfg.config.pins).toEqual([]);
  });

  it('the authorization request uses PKCE S256, a fresh state and nonce, and the exact callback', async () => {
    const { t, idp } = await setup();
    const a = await begin(t.app, idp, 'x');
    const b = await begin(t.app, idp, 'x');
    const p = a.authUrl.searchParams;
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('redirect_uri')).toBe('https://home.example.test/auth/callback');
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('state')).not.toBe(b.state);
    expect(p.get('nonce')).not.toBe(b.authUrl.searchParams.get('nonce'));
    // The token request carried the verifier and the registered redirect URI.
    const r = await callback(t.app, a.code, a.state, a.intent);
    expect(r.status).toBe(302);
    expect(idp.tokenRequests.at(-1)?.get('redirect_uri')).toBe('https://home.example.test/auth/callback');
    expect(idp.tokenRequests.at(-1)?.get('code_verifier')).toBeTruthy();
  });

  describe('rejects, without a session or an account', () => {
    const rejected = async (res: Response, reason: string, t: TestApp) => {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/?auth_error=${reason}`);
      expect(cookieOf(res, 'nexus_session')).toBeUndefined();
      expect(await t.db.get("select count(*) as n from users where id <> 'legacy-admin'")).toEqual({ n: 0 });
    };

    it('a wrong or missing state, and a callback without this browser’s intent cookie', async () => {
      const { t, idp } = await setup();
      const a = await begin(t.app, idp, 'mallory');
      await rejected(await callback(t.app, a.code, 'forged-state', a.intent), 'state', t);
      const b = await begin(t.app, idp, 'mallory');
      // The attacker's callback URL opened in the victim's browser: no intent cookie there.
      await rejected(await callback(t.app, b.code, b.state, ''), 'state', t);
    });

    it('a replayed callback (the intent is single-use)', async () => {
      const { t, idp } = await setup();
      const a = await begin(t.app, idp, 'alice');
      expect(cookieOf(await callback(t.app, a.code, a.state, a.intent), 'nexus_session')).toBeTruthy();
      const again = await callback(t.app, a.code, a.state, a.intent);
      expect(again.headers.get('location')).toBe('/?auth_error=state');
    });

    it('an ID token with a wrong nonce, issuer, audience, expiry, signature or algorithm', async () => {
      const { t, idp } = await setup();
      const attacks: [string, (p: Record<string, unknown>, h: { alg: string }) => void][] = [
        ['nonce', (p) => (p.nonce = 'other')],
        ['issuer', (p) => (p.iss = 'https://evil.example/realms/accounts')],
        ['audience', (p) => ((p.aud = 'other-client'), (p.azp = 'other-client'))],
        ['expired', (p) => (p.exp = Math.floor(Date.now() / 1000) - 3600)],
        ['alg none', (_p, h) => (h.alg = 'none')],
      ];
      for (const [, tamper] of attacks) {
        const a = await begin(t.app, idp, 'mallory');
        idp.tamper = tamper as FakeIdp['tamper'];
        await rejected(await callback(t.app, a.code, a.state, a.intent), 'rejected', t);
      }
      const a = await begin(t.app, idp, 'mallory');
      idp.signWithForeignKey = true;
      await rejected(await callback(t.app, a.code, a.state, a.intent), 'rejected', t);
    });

    it('an error returned by the provider', async () => {
      const { t, idp } = await setup();
      const a = await begin(t.app, idp, 'x');
      const res = await t.app.request(`/auth/callback?error=access_denied&state=${a.state}`, { headers: { cookie: a.intent } });
      await rejected(res, 'access_denied', t);
    });
  });

  it('never redirects off this site after sign-in', async () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/%2F%2Fevil.example', '/%5Cevil.example', ' /x', '/a\nb', 'javascript:alert(1)']) expect(safeReturnTo(bad)).toBe('/');
    expect(safeReturnTo('/settings/apps?new=x#y')).toBe('/settings/apps?new=x#y');
    const { t } = await setup();
    expect((await t.loginOidc({ sub: 'r' }, { returnTo: '//evil.example/steal' })).location).toBe('/');
  });

  it('same e-mail, different identity: two separate accounts, never merged', async () => {
    const { t } = await setup();
    const a = await t.loginOidc({ sub: 'sub-1', email: 'same@example.org' });
    const b = await t.loginOidc({ sub: 'sub-2', email: 'same@example.org' });
    const ida = ((await (await me(t.app, a.cookie)).json()) as { account: { id: string } }).account.id;
    const idb = ((await (await me(t.app, b.cookie)).json()) as { account: { id: string } }).account.id;
    expect(ida).not.toBe(idb);
    // Signing in again maps to the same account.
    const again = await t.loginOidc({ sub: 'sub-1', email: 'new-address@example.org' });
    expect(((await (await me(t.app, again.cookie)).json()) as { account: { id: string; email: string } }).account).toEqual(expect.objectContaining({ id: ida, email: 'new-address@example.org' }));
  });

  it('registration modes are enforced by the server', async () => {
    const closed = await setup({ registration: 'closed' });
    expect((await closed.t.loginOidc({ sub: 'new' })).location).toBe('/?auth_error=registration_closed');
    await closed.t.close();

    const inv = await setup({ registration: 'invite' });
    t = inv.t;
    expect((await inv.t.loginOidc({ sub: 'new' })).location).toBe('/?auth_error=invite_required');
    expect((await inv.t.loginOidc({ sub: 'new' }, { invite: 'nxi_bogus' })).location).toBe('/?auth_error=invite_invalid');
    const admin = await inv.t.loginLegacy();
    const { code } = (await (await inv.t.app.request('/api/v2/admin/invites', { method: 'POST', headers: { ...write, cookie: admin }, body: '{}' })).json()) as { code: string };
    const ok = await inv.t.loginOidc({ sub: 'new' }, { invite: code });
    expect(ok.location).toBe('/');
    expect((await me(inv.t.app, ok.cookie)).status).toBe(200);
    // One use only.
    expect((await inv.t.loginOidc({ sub: 'another' }, { invite: code })).location).toBe('/?auth_error=invite_invalid');
  });

  it('the first account to register gets nothing special', async () => {
    const { t } = await setup();
    const { cookie } = await t.loginOidc({ sub: 'first' });
    expect(((await (await me(t.app, cookie)).json()) as { role: string }).role).toBe('user');
    expect((await t.app.request('/api/v2/admin/users', { headers: { cookie } })).status).toBe(403);
    expect((await t.app.request('/api/integrations/linkwarden', { headers: { cookie } })).status).toBe(403);
  });
});

describe('旧管理员认领 (claiming the legacy administrator)', () => {
  it('binds the identity to the existing account from a password session only, then closes the old way in', async () => {
    const { t, idp } = await setup();
    // Not from a fresh browser: the claim starts from a session opened with the old password.
    expect((await t.app.request('/auth/link/start')).headers.get('location')).toBe('/?auth_error=link_requires_password');
    const legacy = await t.loginLegacy();
    const start = await t.app.request('/auth/link/start', { headers: { cookie: legacy } });
    const authUrl = new URL(start.headers.get('location')!);
    expect(authUrl.searchParams.get('prompt')).toBe('login');
    const code = idp.authorize(authUrl, { sub: 'owner', email: 'owner@example.org' });
    const cb = await t.app.request(`/auth/callback?code=${code}&state=${authUrl.searchParams.get('state')}`, { headers: { cookie: [legacy, cookieOf(start, 'nexus_oidc')].join('; ') } });
    expect(cb.headers.get('location')).toBe('/settings/data?linked=1');
    const cookie = cookieOf(cb, 'nexus_session')!;
    expect(await (await me(t.app, cookie)).json()).toMatchObject({ account: { id: LEGACY_ADMIN_ID }, role: 'admin', session: 'oidc', identityLinked: true });
    // The old password closes once the account is claimed (legacy login `auto`).
    expect((await t.app.request('/api/auth/login', { method: 'POST', headers: write, body: JSON.stringify({ password: 'correct horse battery' }) })).status).toBe(403);
    // Signing in later with the same identity is the administrator.
    const later = await t.loginOidc({ sub: 'owner' });
    expect(((await (await me(t.app, later.cookie)).json()) as { account: { id: string } }).account.id).toBe(LEGACY_ADMIN_ID);
  });

  it('an identity that already has an account cannot claim the administrator', async () => {
    const { t, idp } = await setup({ legacyPasswordLogin: 'on' });
    await t.loginOidc({ sub: 'mallory', email: 'owner@example.org' });
    const legacy = await t.loginLegacy();
    const start = await t.app.request('/auth/link/start', { headers: { cookie: legacy } });
    const authUrl = new URL(start.headers.get('location')!);
    const code = idp.authorize(authUrl, { sub: 'mallory' });
    const cb = await t.app.request(`/auth/callback?code=${code}&state=${authUrl.searchParams.get('state')}`, { headers: { cookie: [legacy, cookieOf(start, 'nexus_oidc')].join('; ') } });
    expect(cb.headers.get('location')).toBe('/settings/data?auth_error=identity_taken');
    expect(await t.db.get('select issuer from users where id = ?', [LEGACY_ADMIN_ID])).toEqual({ issuer: null });
  });
});

describe('ending sessions (ID-07)', () => {
  it('the provider ending a session (refresh refused) ends ours at the next re-check', async () => {
    const { t, idp } = await setup();
    const { cookie } = await t.loginOidc({ sub: 'bob' });
    expect((await me(t.app, cookie)).status).toBe(200);
    idp.revokeRefresh('bob');
    expect((await me(t.app, cookie)).status).toBe(200); // not due yet
    t.clock.now += 6 * 60_000;
    const res = await me(t.app, cookie);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('session_ended');
  });

  it('back-channel logout ends exactly the session it names, and only with a valid token', async () => {
    const { t, idp } = await setup();
    const a = await t.loginOidc({ sub: 'carol', sid: 'sid-a' });
    const b = await t.loginOidc({ sub: 'carol', sid: 'sid-b' });
    const post = (body: string) => t.app.request('/auth/backchannel-logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    expect((await post(`logout_token=${await idp.logoutToken({ sid: 'sid-a', events: {} })}`)).status).toBe(400);
    expect((await post(`logout_token=${await idp.logoutToken({ sid: 'sid-a', nonce: 'x' })}`)).status).toBe(400);
    expect((await post('logout_token=not-a-jwt')).status).toBe(400);
    expect((await post(`logout_token=${await idp.logoutToken({ sid: 'sid-a' })}`)).status).toBe(200);
    expect((await me(t.app, a.cookie)).status).toBe(401);
    expect((await me(t.app, b.cookie)).status).toBe(200);
    expect((await post(`logout_token=${await idp.logoutToken({ sub: 'carol' })}`)).status).toBe(200);
    expect((await me(t.app, b.cookie)).status).toBe(401);
  });

  // 复审 NEX-02 指出：这条用例原来只建了两个网页会话，却声称「设备也全部结束」。现在真的建一台扩展
  // 设备和一个已批准未领取的配对，逐项断言动作 B 的范围（ADR-019）。
  it('退出 Nexus 的全部设备 (动作 B) ends every session, device and approved pairing of the account, says so by mail, and leaves the identity service alone', async () => {
    const { t, idp } = await setup();
    const a = await t.loginOidc({ sub: 'dave', email: 'dave@example.org' });
    const b = await t.loginOidc({ sub: 'dave', email: 'dave@example.org' });
    const id = ((await (await me(t.app, a.cookie)).json()) as { account: { id: string } }).account.id;
    const device = await t.deps.devices.create(id, 'Chrome 扩展', '', ['config:read', 'items:read', 'items:write']);
    const bearer = { ...write, authorization: `Bearer ${device.token}` };
    expect((await t.app.request('/api/sync/config', { headers: bearer })).status).toBe(200);
    const pending = t.deps.pairings.start('Edge 扩展', 'ip', '', ['config:read']);
    expect((await t.app.request(`/api/devices/pairing/${pending.code}`, { method: 'POST', headers: { ...write, cookie: a.cookie }, body: JSON.stringify({ approve: true }) })).status).toBe(200);

    const res = await t.app.request('/api/v2/account/logout-all', { method: 'POST', headers: { ...write, cookie: a.cookie } });
    expect(await res.json()).toEqual({ sessions: 2, devices: 1, grants: 1, endSessionUrl: null });
    expect((await me(t.app, a.cookie)).status).toBe(401);
    expect((await me(t.app, b.cookie)).status).toBe(401);
    expect((await t.app.request('/api/sync/config', { headers: bearer })).status).toBe(401);
    expect((await t.app.request('/api/v2/items', { method: 'POST', headers: bearer, body: JSON.stringify({ opId: 'after-b', item: { title: 'x', url: 'https://after.example.org/' } }) })).status).toBe(401);
    expect(await t.deps.pairings.poll(pending.pairId, pending.secret)).toEqual({ status: 'denied' });
    // Not 动作 C: the identity service was not asked to end anything.
    expect(idp.accountLogouts).toEqual([]);
    await t.deps.mail!.runDue();
    expect(t.mail.sent.map((m) => [m.to, m.subject])).toEqual([
      ['dave@example.org', '新的浏览器扩展已连接到你的 Nexus 账号'],
      ['dave@example.org', '你的 Nexus 账号已在所有设备上退出'],
    ]);
  });

  it('an administrator disabling an account is 动作 B: sessions, devices and approved pairings end; enabling again revives none of them', async () => {
    const { t } = await setup();
    const user = await t.loginOidc({ sub: 'erin' });
    const id = ((await (await me(t.app, user.cookie)).json()) as { account: { id: string } }).account.id;
    const device = await t.deps.devices.create(id, 'Chrome 扩展', '');
    const pending = t.deps.pairings.start('Edge 扩展', 'ip', '');
    expect((await t.app.request(`/api/devices/pairing/${pending.code}`, { method: 'POST', headers: { ...write, cookie: user.cookie }, body: JSON.stringify({ approve: true }) })).status).toBe(200);
    const admin = await t.loginLegacy();
    expect((await t.app.request(`/api/v2/admin/users/${LEGACY_ADMIN_ID}/disable`, { method: 'POST', headers: { ...write, cookie: admin } })).status).toBe(409);
    expect((await t.app.request(`/api/v2/admin/users/${id}/disable`, { method: 'POST', headers: { ...write, cookie: admin } })).status).toBe(200);
    expect((await me(t.app, user.cookie)).status).toBe(401);
    expect((await t.app.request('/api/sync/config', { headers: { authorization: `Bearer ${device.token}` } })).status).toBe(401);
    expect((await t.loginOidc({ sub: 'erin' })).location).toBe('/?auth_error=disabled');
    // Enabled again: signing in works; nothing issued before does (the epoch never goes down).
    expect((await t.app.request(`/api/v2/admin/users/${id}/enable`, { method: 'POST', headers: { ...write, cookie: admin } })).status).toBe(200);
    expect((await me(t.app, user.cookie)).status).toBe(401);
    expect((await t.app.request('/api/sync/config', { headers: { authorization: `Bearer ${device.token}` } })).status).toBe(401);
    expect(await t.deps.pairings.poll(pending.pairId, pending.secret)).toEqual({ status: 'denied' });
    const again = await t.loginOidc({ sub: 'erin' });
    expect((await me(t.app, again.cookie)).status).toBe(200);
  });
});
