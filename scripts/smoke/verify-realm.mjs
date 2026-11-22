// 本机冒烟：通过 Keycloak 管理 API 读回导入后的 realm，逐项核对模板承诺的安全设置（只用于一次性
// 的本机实例，使用临时管理员）。用法：node scripts/smoke/verify-realm.mjs <含 .env 的 identity 目录>
// ADR-019 部分会建一个合成用户（adr019-probe-…@example.invalid）并在结束时删除；用户令牌的内容用
// 管理 API 的 generate-example-access-token 生成（两个 client 都关闭了密码直授），Account REST 的
// 「结束全部会话」需要真实浏览器登录，由 identity-smoke 与联合验收覆盖。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const env = Object.fromEntries(readFileSync(join(dir, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KC = env.ACCOUNTS_PUBLIC_URL;
const out = {};
const check = (name, ok, detail) => (out[name] = ok ? 'OK' : `FAIL ${JSON.stringify(detail)}`);

const tok = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_BOOTSTRAP_ADMIN, password: env.KEYCLOAK_BOOTSTRAP_PASSWORD }) }).then((r) => r.json());
const api = (p, init = {}) => fetch(`${KC}/admin/realms/accounts${p}`, { ...init, headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

const realm = await api('').then((r) => r.json());
check('realm.verifyEmail', realm.verifyEmail === true, realm.verifyEmail);
check('realm.registrationAllowed (template default)', realm.registrationAllowed === true, realm.registrationAllowed);
// v12.0.3 I1: new accounts choose a username; the e-mail still signs in (after ./configure.sh profile apply).
check('realm.registrationEmailAsUsername', realm.registrationEmailAsUsername === false, realm.registrationEmailAsUsername);
check('realm.loginWithEmailAllowed', realm.loginWithEmailAllowed === true, realm.loginWithEmailAllowed);
check('realm.editUsernameAllowed', realm.editUsernameAllowed === false, realm.editUsernameAllowed);
const profile = await api('/users/profile').then((r) => r.json());
const attrs = Object.fromEntries((profile.attributes ?? []).map((a) => [a.name, a]));
check('profile: username, nickname, email first', JSON.stringify((profile.attributes ?? []).slice(0, 3).map((a) => a.name)) === '["username","nickname","email"]', (profile.attributes ?? []).map((a) => a.name));
check('profile: nickname optional, 1-32', !attrs.nickname?.required && attrs.nickname?.validations?.length?.max === 32, attrs.nickname);
check('profile: 姓/名 admin-only, not required', ['firstName', 'lastName'].every((n) => !attrs[n]?.required && JSON.stringify(attrs[n]?.permissions?.view) === '["admin"]'), [attrs.firstName?.permissions, attrs.lastName?.permissions]);
check('realm.resetPasswordAllowed', realm.resetPasswordAllowed === true, realm.resetPasswordAllowed);
check('realm.bruteForceProtected', realm.bruteForceProtected === true, realm.bruteForceProtected);
check('realm.sslRequired', realm.sslRequired === 'external', realm.sslRequired);
check('realm.passwordPolicy', /length\(10\)/.test(realm.passwordPolicy ?? ''), realm.passwordPolicy);
check('realm.defaultLocale', realm.defaultLocale === 'zh-CN', realm.defaultLocale);
check('realm.actionTokens', realm.attributes?.['actionTokenGeneratedByUserLifespan.verify-email'] === '1800' && realm.attributes?.['actionTokenGeneratedByUserLifespan.reset-credentials'] === '900', realm.attributes);
check('realm.smtp.from', realm.smtpServer?.from === env.SMTP_FROM, realm.smtpServer?.from);

for (const [clientId, base, secret] of [
  ['nexus-web', env.NEXUS_PUBLIC_URL, env.NEXUS_OIDC_CLIENT_SECRET],
  ['litesync-web', env.LITESYNC_PUBLIC_URL, env.LITESYNC_OIDC_CLIENT_SECRET],
]) {
  const [c] = await api(`/clients?clientId=${clientId}`).then((r) => r.json());
  // ADR-019: the service account is on (read-only, see below); password grant, implicit and public stay off.
  check(`${clientId}.flows`, c.standardFlowEnabled && !c.implicitFlowEnabled && !c.directAccessGrantsEnabled && c.serviceAccountsEnabled && !c.publicClient, { std: c.standardFlowEnabled, implicit: c.implicitFlowEnabled, direct: c.directAccessGrantsEnabled, sa: c.serviceAccountsEnabled, public: c.publicClient });
  check(`${clientId}.redirectUris`, JSON.stringify(c.redirectUris) === JSON.stringify([`${base}/auth/callback`]), c.redirectUris);
  check(`${clientId}.pkce`, c.attributes['pkce.code.challenge.method'] === 'S256', c.attributes['pkce.code.challenge.method']);
  check(`${clientId}.backchannel`, c.attributes['backchannel.logout.url'] === `${base}/auth/backchannel-logout` && c.attributes['backchannel.logout.session.required'] === 'true', [c.attributes['backchannel.logout.url'], c.attributes['backchannel.logout.session.required']]);
  check(`${clientId}.frontchannel off`, c.frontchannelLogout === false, c.frontchannelLogout);
  check(`${clientId}.fullScopeAllowed off`, c.fullScopeAllowed === false, c.fullScopeAllowed);
  const s = await api(`/clients/${c.id}/client-secret`).then((r) => r.json());
  check(`${clientId}.secret from .env`, s.value === secret, s.value ? '(differs)' : '(empty)');

  // ── ADR-019 · 账号撤销 ──────────────────────────────────────────────────
  // fullScopeAllowed=false: tokens carry only scope-mapped roles. Exactly two mappings, nothing else.
  check(`${clientId}.default scope roles`, (c.defaultClientScopes ?? []).includes('roles'), c.defaultClientScopes);
  const sm = await api(`/clients/${c.id}/scope-mappings`).then((r) => r.json());
  const mapped = Object.fromEntries(Object.entries(sm.clientMappings ?? {}).map(([k, v]) => [k, v.mappings.map((m) => m.name).sort()]).sort(([a], [b]) => a.localeCompare(b)));
  check(`${clientId}.scope mappings = account/manage-account + realm-management/view-users`, JSON.stringify(mapped) === JSON.stringify({ account: ['manage-account'], 'realm-management': ['view-users'] }) && !(sm.realmMappings ?? []).length, { client: mapped, realm: (sm.realmMappings ?? []).map((m) => m.name) });
  const sa = await api(`/clients/${c.id}/service-account-user`).then((r) => r.json());
  const saRoles = await api(`/users/${sa.id}/role-mappings`).then((r) => r.json());
  const saClient = Object.fromEntries(Object.entries(saRoles.clientMappings ?? {}).map(([k, v]) => [k, v.mappings.map((m) => m.name).sort()]));
  check(`${clientId}.service account holds realm-management/view-users only`, JSON.stringify(saClient['realm-management']) === JSON.stringify(['view-users']) && Object.keys(saClient).every((k) => k === 'realm-management'), saClient);

  // A normal user's access token for this client: aud account + account/manage-account, never view-users.
  const probe = `adr019-probe-${clientId}-${Date.now()}@example.invalid`;
  const created = await api('/users', { method: 'POST', body: JSON.stringify({ username: probe, email: probe, enabled: true, emailVerified: true }) });
  const userId = (created.headers.get('location') ?? '').split('/').pop();
  try {
    const example = await api(`/clients/${c.id}/evaluate-scopes/generate-example-access-token?scope=openid&userId=${userId}`).then((r) => r.json());
    const aud = [].concat(example.aud ?? []);
    const ra = example.resource_access ?? {};
    check(`${clientId}.user token has aud account`, aud.includes('account'), example.aud);
    check(`${clientId}.user token has account/manage-account`, (ra.account?.roles ?? []).includes('manage-account'), ra);
    check(`${clientId}.user token has no admin role`, !JSON.stringify(ra).includes('view-users') && !ra['realm-management'], ra);

    // The service account (client credentials) reads a user, and can change nothing.
    const satok = await fetch(`${KC}/realms/accounts/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }) }).then((r) => r.json());
    const sat = JSON.parse(Buffer.from(String(satok.access_token).split('.')[1] ?? '', 'base64url').toString() || '{}');
    check(`${clientId}.service token carries realm-management/view-users`, (sat.resource_access?.['realm-management']?.roles ?? []).includes('view-users') && !(sat.resource_access?.['realm-management']?.roles ?? []).includes('manage-users'), sat.resource_access);
    const asSa = (p, init = {}) => fetch(`${KC}/admin/realms/accounts${p}`, { ...init, headers: { authorization: `Bearer ${satok.access_token}`, 'content-type': 'application/json', accept: 'application/json' } });
    const read = await asSa(`/users/${userId}`);
    const readBody = await read.json().catch(() => null);
    check(`${clientId}.service account reads enabled`, read.status === 200 && readBody?.enabled === true, read.status);
    check(`${clientId}.service account cannot modify a user (403)`, (await asSa(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ ...readBody, firstName: 'changed' }) })).status === 403, 'PUT');
    check(`${clientId}.service account cannot end a user's sessions (403)`, (await asSa(`/users/${userId}/logout`, { method: 'POST' })).status === 403, 'logout');
    await api(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ ...readBody, enabled: false }) });
    check(`${clientId}.service account sees a disabled user`, (await asSa(`/users/${userId}`).then((r) => r.json())).enabled === false, 'disabled');
    await api(`/users/${userId}`, { method: 'DELETE' });
    check(`${clientId}.service account gets 404 for a deleted user`, (await asSa(`/users/${userId}`)).status === 404, 'deleted');
  } finally {
    await api(`/users/${userId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

// Password grant must be refused for the product clients (direct access grants are off).
const direct = await fetch(`${KC}/realms/accounts/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'nexus-web', client_secret: env.NEXUS_OIDC_CLIENT_SECRET, username: 'nobody@example.test', password: 'x' }) });
const directBody = await direct.json();
check('nexus-web refuses password grant', direct.status >= 400 && /unauthorized_client|invalid_grant|not allowed/i.test(JSON.stringify(directBody)), { status: direct.status, body: directBody });

// Implicit flow request must be refused.
const implicit = await fetch(`${KC}/realms/accounts/protocol/openid-connect/auth?client_id=nexus-web&response_type=token&redirect_uri=${encodeURIComponent(`${env.NEXUS_PUBLIC_URL}/auth/callback`)}&scope=openid`, { redirect: 'manual' });
const loc = implicit.headers.get('location') ?? '';
check('nexus-web refuses implicit flow', /error=unauthorized_client|error=unsupported_response_type/.test(loc) || implicit.status === 400, { status: implicit.status, loc: loc.slice(0, 160) });

// A redirect URI that is not exactly registered must be refused.
const foreign = await fetch(`${KC}/realms/accounts/protocol/openid-connect/auth?client_id=nexus-web&response_type=code&redirect_uri=${encodeURIComponent(`${env.NEXUS_PUBLIC_URL}/auth/callback/../evil`)}&scope=openid&code_challenge=abc&code_challenge_method=S256`, { redirect: 'manual' });
check('nexus-web refuses unregistered redirect_uri', foreign.status === 400, foreign.status);

// PKCE is required: a code request without a challenge is refused.
const nopkce = await fetch(`${KC}/realms/accounts/protocol/openid-connect/auth?client_id=nexus-web&response_type=code&redirect_uri=${encodeURIComponent(`${env.NEXUS_PUBLIC_URL}/auth/callback`)}&scope=openid&state=s`, { redirect: 'manual' });
const nopkceLoc = nopkce.headers.get('location') ?? '';
check('nexus-web requires PKCE', /error=invalid_request/.test(nopkceLoc) && /code_challenge/i.test(decodeURIComponent(nopkceLoc)), { status: nopkce.status, loc: nopkceLoc.slice(0, 200) });

console.log(JSON.stringify(out, null, 2));
const failed = Object.values(out).filter((v) => v !== 'OK').length;
console.log(JSON.stringify({ total: Object.keys(out).length, failed }));
process.exitCode = failed ? 1 : 0;
