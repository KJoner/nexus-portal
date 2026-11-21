// 本机冒烟：通过 Keycloak 管理 API 读回导入后的 realm，逐项核对模板承诺的安全设置（只用于一次性
// 的本机实例，使用临时管理员）。用法：node scripts/smoke/verify-realm.mjs <含 .env 的 identity 目录>
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
check('realm.registrationEmailAsUsername', realm.registrationEmailAsUsername === true, realm.registrationEmailAsUsername);
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
  check(`${clientId}.flows`, c.standardFlowEnabled && !c.implicitFlowEnabled && !c.directAccessGrantsEnabled && !c.serviceAccountsEnabled && !c.publicClient, { std: c.standardFlowEnabled, implicit: c.implicitFlowEnabled, direct: c.directAccessGrantsEnabled, sa: c.serviceAccountsEnabled, public: c.publicClient });
  check(`${clientId}.redirectUris`, JSON.stringify(c.redirectUris) === JSON.stringify([`${base}/auth/callback`]), c.redirectUris);
  check(`${clientId}.pkce`, c.attributes['pkce.code.challenge.method'] === 'S256', c.attributes['pkce.code.challenge.method']);
  check(`${clientId}.backchannel`, c.attributes['backchannel.logout.url'] === `${base}/auth/backchannel-logout` && c.attributes['backchannel.logout.session.required'] === 'true', [c.attributes['backchannel.logout.url'], c.attributes['backchannel.logout.session.required']]);
  check(`${clientId}.frontchannel off`, c.frontchannelLogout === false, c.frontchannelLogout);
  check(`${clientId}.fullScopeAllowed off`, c.fullScopeAllowed === false, c.fullScopeAllowed);
  const s = await api(`/clients/${c.id}/client-secret`).then((r) => r.json());
  check(`${clientId}.secret from .env`, s.value === secret, s.value ? '(differs)' : '(empty)');
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
