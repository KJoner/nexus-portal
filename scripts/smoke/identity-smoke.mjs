// 本机冒烟（合成数据，不连生产）：Nexus ⇄ infra/identity 的真实 Keycloak + PostgreSQL，真实浏览器。
// 前置：npm run build；按 infra/identity/README.md「本机冒烟」起一套容器（.env 用随机值，
// NEXUS_PUBLIC_URL=http://host.docker.internal:28787，ACCOUNTS_PUBLIC_URL=http://localhost:28180），
// 本机收信器（mailpit）挂在同一 compose 网络并用 configure.sh smtp 指向它。
// 用法：node scripts/smoke/identity-smoke.mjs <含 .env 的 identity 目录> <输出目录>
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NEXUS = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const require = createRequire(`${NEXUS}/package.json`);
const { chromium } = require('playwright');

const [idDir, work] = process.argv.slice(2);
const env = Object.fromEntries(readFileSync(join(idDir, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'shots'), { recursive: true });
const KC = env.ACCOUNTS_PUBLIC_URL;
const PUBLIC = env.NEXUS_PUBLIC_URL; // http://host.docker.internal:28787 — the browser maps it to 127.0.0.1
const LEGACY_PASSWORD = randomBytes(12).toString('hex');
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

// ── Keycloak admin (bootstrap admin of the throwaway instance) ────────────────
async function adminToken() {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_BOOTSTRAP_ADMIN, password: env.KEYCLOAK_BOOTSTRAP_PASSWORD }) });
  return (await r.json()).access_token;
}
const kc = async (path, init = {}) => {
  const r = await fetch(`${KC}/admin/realms/accounts${path}`, { ...init, headers: { authorization: `Bearer ${await adminToken()}`, 'content-type': 'application/json' } });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null, location: r.headers.get('location') };
};
async function createUser(email, first) {
  const password = `Pw-${randomBytes(9).toString('base64url')}`;
  const r = await kc('/users', { method: 'POST', body: JSON.stringify({ username: email, email, emailVerified: true, enabled: true, firstName: first, lastName: '测试', credentials: [{ type: 'password', value: password, temporary: false }] }) });
  if (r.status !== 201) throw new Error(`create user ${r.status} ${JSON.stringify(r.body)}`);
  return { email, password, id: r.location.split('/').pop() };
}

// ── Nexus on PostgreSQL (the nexus database and nexus_app role created by postgres-init) ───
const logs = [];
const server = spawn(process.execPath, [`${NEXUS}/apps/server/dist/index.mjs`], {
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NEXUS_'))),
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '28787',
    NEXUS_DATA_DIR: join(work, 'nexus-data'),
    NEXUS_DATABASE_URL: `postgres://nexus_app:${env.NEXUS_DB_PASSWORD}@127.0.0.1:${env.POSTGRES_PORT}/nexus`,
    NEXUS_PUBLIC_URL: PUBLIC,
    NEXUS_OIDC_ISSUER: `${KC}/realms/accounts`,
    NEXUS_OIDC_CLIENT_ID: 'nexus-web',
    NEXUS_OIDC_CLIENT_SECRET: env.NEXUS_OIDC_CLIENT_SECRET,
    NEXUS_REGISTRATION_MODE: 'open',
    NEXUS_PASSWORD: LEGACY_PASSWORD,
    NEXUS_SECRET: randomBytes(24).toString('hex'),
    NEXUS_MAIL_PROVIDER: 'log',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => logs.push(String(d)));
server.stderr.on('data', (d) => logs.push(String(d)));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch('http://127.0.0.1:28787/api/v2/auth/options')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'] });
const shot = (page, name) => page.screenshot({ path: join(work, 'shots', `${name}.png`) });
const api = (page, path, method = 'GET') => page.evaluate(async ([p, m]) => {
  const r = await fetch(p, { method: m, headers: { 'X-Nexus-Client': '1' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [path, method]);

async function signInThroughKeycloak(page, user, startFrom = `${PUBLIC}/`) {
  await page.goto(startFrom);
  await page.getByRole('button', { name: '使用统一账号登录' }).click();
  await page.waitForURL((u) => u.href.startsWith(`${KC}/realms/accounts/protocol/openid-connect/auth`));
  await page.locator('#username').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
  await page.waitForURL((u) => u.href.startsWith(PUBLIC) && !u.pathname.startsWith('/auth/'), { timeout: 20_000 });
}

try {
  const opts = await (await fetch('http://127.0.0.1:28787/api/v2/auth/options')).json();
  step('auth options', opts.oidc === true && opts.legacyPassword === true && opts.registration === 'open', opts);

  const alice = await createUser('alice@example.test', '爱丽丝');
  const bob = await createUser('bob@example.test', '鲍勃');

  // 1. Sign in with the shared account.
  const ctxA = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  await a.goto(`${PUBLIC}/`);
  await a.getByRole('button', { name: '使用统一账号登录' }).waitFor();
  await shot(a, '01-nexus-login');
  await a.getByRole('button', { name: '使用统一账号登录' }).click();
  await a.waitForURL((u) => u.href.startsWith(`${KC}/realms/accounts/protocol/openid-connect/auth`));
  const authUrl = new URL(a.url());
  step('authorization request: code + PKCE S256 + state + nonce', authUrl.searchParams.get('response_type') === 'code' && authUrl.searchParams.get('code_challenge_method') === 'S256' && !!authUrl.searchParams.get('state') && !!authUrl.searchParams.get('nonce') && authUrl.searchParams.get('redirect_uri') === `${PUBLIC}/auth/callback`, Object.fromEntries([...authUrl.searchParams].filter(([k]) => !['code_challenge', 'state', 'nonce'].includes(k))));
  await a.locator('#username').waitFor();
  await shot(a, '02-keycloak-login');
  await a.locator('#username').fill(alice.email);
  await a.locator('#password').fill(alice.password);
  await a.locator('#kc-login').click();
  await a.waitForURL((u) => u.href.startsWith(PUBLIC) && !u.pathname.startsWith('/auth/'), { timeout: 20_000 });
  await a.waitForTimeout(1500);
  await shot(a, '03-nexus-home-alice');
  const meA = await api(a, '/api/v2/me');
  step('alice signed in through Keycloak', meA.status === 200 && meA.body.account.email === alice.email && meA.body.role === 'user' && meA.body.session === 'oidc', { status: meA.status, email: meA.body?.account?.email, role: meA.body?.role, session: meA.body?.session, onboarding: meA.body?.onboarding });
  const cfgA = await api(a, '/api/config');
  step('a new account starts with its own, empty collection', cfgA.status === 200 && cfgA.body.config.apps.length === 0, { apps: cfgA.body?.config?.apps?.length });
  const cookies = await ctxA.cookies(PUBLIC);
  step('session cookie: HttpOnly, SameSite=Lax; no sign-in cookie left behind', cookies.some((c) => c.httpOnly && c.sameSite === 'Lax') && !cookies.some((c) => c.name === 'nexus_oidc'), cookies.map((c) => `${c.name} httpOnly=${c.httpOnly} sameSite=${c.sameSite} path=${c.path}`));
  // The operator's tools are not shown to another account; an empty collection points to 应用目录.
  const hint = await a.getByRole('button', { name: /收藏库还是空的/ }).isVisible();
  const operatorUi = (await a.getByText('运行概览').count()) + (await a.getByText('尚未添加服务').count());
  step('member home: empty-collection hint, no service status or 运行概览', hint && operatorUi === 0, { hint, operatorUi });
  await a.goto(`${PUBLIC}/settings/data`);
  await a.getByRole('button', { name: /全部退出/ }).waitFor();
  await shot(a, '08-nexus-settings-member');
  const memberText = await a.locator('main, body').first().innerText();
  step('member settings: account and the three ways out (ADR-019), no claim, no administration', /退出此设备/.test(memberText) && /退出 Nexus 的全部设备/.test(memberText) && /退出所有产品与设备/.test(memberText) && /打开账号中心/.test(memberText) && !/绑定统一账号/.test(memberText) && !/账号与邀请/.test(memberText), memberText.match(/账号与登录[\s\S]{0,40}/)?.[0]);
  // An extension asking for more than reading: the approval page lists it and lets her trim it.
  const pairStart = await (await fetch('http://127.0.0.1:28787/api/pair/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexus-client': '1' }, body: JSON.stringify({ name: 'Chrome 扩展', scopes: ['config:read', 'items:read', 'items:write', 'pins:write'] }) })).json();
  await a.goto(`${PUBLIC}/settings/data?pair=${pairStart.code}`);
  await a.getByLabel('申请的权限').waitFor();
  await shot(a, '09-nexus-pairing-scopes');
  await a.getByRole('switch', { name: '添加、编辑和删除我的收藏' }).click();
  await a.getByRole('button', { name: '连接码一致，允许连接' }).click();
  await a.getByRole('dialog').waitFor({ state: 'detached' });
  const polledScopes = await (await fetch('http://127.0.0.1:28787/api/pair/poll', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexus-client': '1' }, body: JSON.stringify({ pairId: pairStart.pairId, secret: pairStart.secret }) })).json();
  step('pairing grants only what was left switched on', polledScopes.status === 'approved' && JSON.stringify(polledScopes.device?.scopes) === JSON.stringify(['config:read', 'items:read', 'pins:write']), { status: polledScopes.status, scopes: polledScopes.device?.scopes });
  await a.goto(`${PUBLIC}/`);

  // 2. Replaying the callback (same code and state) must not sign anyone in.
  const callbackHits = [];
  // (captured on the next sign-in)

  // 3. Bob in another browser: separate account, nothing of Alice's.
  const ctxB = await browser.newContext({ locale: 'zh-CN' });
  const b = await ctxB.newPage();
  let callbackUrl = '';
  b.on('request', (r) => {
    if (r.url().startsWith(`${PUBLIC}/auth/callback`)) callbackUrl = r.url();
  });
  await signInThroughKeycloak(b, bob);
  const meB = await api(b, '/api/v2/me');
  step('bob signed in as a different account', meB.status === 200 && meB.body.account.email === bob.email && meB.body.account.id !== meA.body.account.id, { email: meB.body?.account?.email });
  // Replay Bob's callback in a fresh browser (no sign-in cookie): refused.
  const ctxR = await browser.newContext();
  const rpage = await ctxR.newPage();
  await rpage.goto(callbackUrl);
  const replayMe = await api(rpage, '/api/v2/me');
  step('a replayed callback URL signs no one in', replayMe.status === 401 && rpage.url().includes('auth_error='), { status: replayMe.status, landed: new URL(rpage.url()).search });
  await ctxR.close();

  // 4. Keycloak ends Alice's sessions (admin sign-out) → back-channel logout ends Nexus's session.
  const lo = await kc(`/users/${alice.id}/logout`, { method: 'POST' });
  await a.waitForTimeout(1500);
  const afterBackchannel = await api(a, '/api/v2/me');
  step('back-channel logout from Keycloak ends the Nexus session', lo.status === 204 && afterBackchannel.status === 401, { admin: lo.status, me: afterBackchannel.status });
  const meBStill = await api(b, '/api/v2/me');
  step("…and only Alice's: Bob stays signed in", meBStill.status === 200, meBStill.status);

  // 5. 退出 Nexus 的全部设备（ADR-019 动作 B）: every Nexus session of Bob ends; the identity service is
  //    not touched (that is 动作 C, see revocation-smoke.mjs), so no end-session hop any more.
  const b2ctx = await browser.newContext({ locale: 'zh-CN' });
  const b2 = await b2ctx.newPage();
  await signInThroughKeycloak(b2, bob); // a second session of Bob, another browser
  const kcBefore = (await kc(`/users/${bob.id}/sessions`)).body.length;
  const all = await api(b, '/api/v2/account/logout-all', 'POST');
  step('动作 B ends every Nexus session of the account, without an end-session hop', all.status === 200 && all.body.sessions >= 2 && all.body.endSessionUrl === null, { status: all.status, sessions: all.body?.sessions, devices: all.body?.devices, grants: all.body?.grants, endSessionUrl: all.body?.endSessionUrl });
  const b2After = await api(b2, '/api/v2/me');
  step("…including Bob's other browser", b2After.status === 401, b2After.status);
  const kcSessions = await kc(`/users/${bob.id}/sessions`);
  step('…and leaves the identity service alone (B is this product only)', kcBefore === 2 && kcSessions.body.length === 2, { keycloakSessionsBefore: kcBefore, after: kcSessions.body?.length });
  // B's scope, by design: a browser still signed in at the identity service re-enters without a password.
  await b2.goto(`${PUBLIC}/`);
  await b2.getByRole('button', { name: '使用统一账号登录' }).click();
  await b2.waitForURL((u) => u.href.startsWith(PUBLIC) && !u.pathname.startsWith('/auth/') || u.href.startsWith(`${KC}/`), { timeout: 20_000 });
  await b2.waitForTimeout(1000);
  step('(by design) after B a browser with a live identity-service session re-enters without a password', new URL(b2.url()).host === new URL(PUBLIC).host, new URL(b2.url()).host);

  // 6. 旧管理员认领: the legacy administrator (password) binds a shared account.
  const admin = await createUser('owner@example.test', '站长');
  const ctxC = await browser.newContext({ locale: 'zh-CN' });
  const c = await ctxC.newPage();
  await c.goto(`${PUBLIC}/`);
  await c.getByRole('button', { name: '管理员访问密码登录' }).click();
  await c.getByLabel('访问密码').fill(LEGACY_PASSWORD);
  await c.getByLabel('进入').click();
  await c.waitForTimeout(1500);
  const meC = await api(c, '/api/v2/me');
  step('legacy administrator signs in with the access password', meC.status === 200 && meC.body.role === 'admin' && meC.body.session === 'password' && meC.body.canLinkIdentity === true, { role: meC.body?.role, session: meC.body?.session, canLinkIdentity: meC.body?.canLinkIdentity });
  await c.goto(`${PUBLIC}/auth/link/start`);
  await c.waitForURL((u) => u.href.startsWith(`${KC}/realms/accounts/protocol/openid-connect/auth`));
  const linkUrl = new URL(c.url());
  step('claim asks the identity service to authenticate again (prompt=login)', linkUrl.searchParams.get('prompt') === 'login', linkUrl.searchParams.get('prompt'));
  await c.locator('#username').fill(admin.email);
  await c.locator('#password').fill(admin.password);
  await c.locator('#kc-login').click();
  await c.waitForURL((u) => u.href.startsWith(PUBLIC) && !u.pathname.startsWith('/auth/'), { timeout: 20_000 });
  // Now sign in with the shared account in a fresh browser: it is the administrator.
  const ctxD = await browser.newContext({ locale: 'zh-CN' });
  const d = await ctxD.newPage();
  await signInThroughKeycloak(d, admin);
  const meD = await api(d, '/api/v2/me');
  step('after the claim, the shared account opens the administrator account', meD.status === 200 && meD.body.account.id === 'legacy-admin' && meD.body.role === 'admin' && meD.body.session === 'oidc' && meD.body.identityLinked === true, { id: meD.body?.account?.id, role: meD.body?.role, linked: meD.body?.identityLinked });
  // Administration: accounts, invitations; a code is shown once.
  await d.goto(`${PUBLIC}/settings/data`);
  await d.getByText('账号与邀请').waitFor();
  await shot(d, '10-nexus-settings-admin');
  const adminText = await d.locator('body').innerText();
  step('administrator settings list the accounts', ['alice@example.test', 'bob@example.test', 'owner@example.test'].every((e) => adminText.includes(e)), adminText.match(/账号与邀请[\s\S]{0,60}/)?.[0]);
  const lwAdmin = await api(d, '/api/integrations/linkwarden');
  const lwUser = await api(b2, '/api/integrations/linkwarden'); // b2 is Bob again (silent re-entry above)
  const meB2 = await api(b2, '/api/v2/me');
  step('operator integrations: administrator only', lwAdmin.status === 200 && lwUser.status === 403 && meB2.body?.role === 'user', { admin: lwAdmin.status, bob: lwUser.status });

  // 7. Self-registration through the real mail flow (local mail catcher). Keycloak 26.8 with
  //    Verify Email: the form asks for e-mail and name only; the password is set after the link.
  const MAIL = 'http://127.0.0.1:28025';
  const ctxE = await browser.newContext({ locale: 'zh-CN' });
  const e = await ctxE.newPage();
  await e.goto(`${PUBLIC}/`);
  await e.getByRole('button', { name: '使用统一账号登录' }).click();
  await e.waitForURL((u) => u.href.startsWith(`${KC}/`));
  await e.locator('#kc-registration a, a[href*="registrations"]').first().click();
  await e.locator('#email').waitFor();
  await shot(e, '04-keycloak-register');
  step('registration form: no password before the e-mail is proven (Keycloak 26.8 default)', (await e.locator('input[type=password]').count()) === 0, await e.locator('input').evaluateAll((xs) => xs.map((x) => x.name).filter(Boolean)));
  await e.locator('#email').fill('carol@example.test');
  // v12.0.3 I1: 用户名 + 昵称 + 邮箱 (after ./configure.sh profile apply); older realms still ask for 姓 / 名.
  if (await e.locator('#username').count()) await e.locator('#username').fill('carol');
  if (await e.locator('#nickname').count()) await e.locator('#nickname').fill('卡罗');
  if (await e.locator('#firstName').count()) await e.locator('#firstName').fill('卡罗');
  if (await e.locator('#lastName').count()) await e.locator('#lastName').fill('测试');
  await e.locator('[type=submit]').first().click();
  await e.waitForLoadState('networkidle');
  await shot(e, '05-keycloak-verify-email');
  const pageText = (await e.locator('body').innerText()).replace(/\s+/g, ' ');
  const [carol] = (await kc('/users?email=carol@example.test')).body;
  step('registration stops at e-mail verification; nothing in Nexus yet', e.url().startsWith(KC) && /验证|verify/i.test(pageText) && carol?.emailVerified === false, { at: new URL(e.url()).pathname, text: pageText.slice(0, 80), emailVerified: carol?.emailVerified });
  let mail = null;
  for (let i = 0; i < 30 && !mail; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/messages`)).json();
    mail = list.messages?.find((m) => m.To?.some((t) => t.Address === 'carol@example.test')) ?? null;
    if (!mail) await new Promise((r) => setTimeout(r, 500));
  }
  const full = mail && (await (await fetch(`${MAIL}/api/v1/message/${mail.ID}`)).json());
  const link = full?.Text?.match(/https?:\/\/\S+action-token\S+/)?.[0];
  step('verification mail sent (Chinese subject, link to the identity service)', !!link && link.startsWith(`${KC}/realms/accounts/`), { subject: full?.Subject, from: full?.From?.Address, link: link ? `${new URL(link).origin}${new URL(link).pathname}` : null });
  await e.goto(link);
  const carolPw = `Pw-${randomBytes(9).toString('base64url')}`;
  await e.locator('#password-new').waitFor({ timeout: 15_000 });
  await shot(e, '06-keycloak-set-password');
  await e.locator('#password-new').fill(carolPw);
  await e.locator('#password-confirm').fill(carolPw);
  await e.locator('[type=submit]').first().click();
  await e.waitForURL((u) => u.href.startsWith(PUBLIC) && !u.pathname.startsWith('/auth/'), { timeout: 20_000 }).catch(() => undefined);
  await e.waitForTimeout(1500);
  await shot(e, '07-nexus-after-registration');
  const meE = await api(e, '/api/v2/me').catch(() => ({ status: 'n/a' }));
  step('after the link and a password, carol lands in Nexus with her own new account', meE.status === 200 && meE.body.account.email === 'carol@example.test' && meE.body.account.emailVerified === true && meE.body.onboarding.state === 'empty_collection', { status: meE.status, url: e.url().slice(0, 60), verified: meE.body?.account?.emailVerified });
  const tooShort = await (async () => {
    const ctxG = await browser.newContext({ locale: 'zh-CN' });
    const g = await ctxG.newPage();
    await g.goto(`${KC}/realms/accounts/account`);
    await g.waitForURL((u) => u.pathname.includes('/protocol/openid-connect/auth'));
    await g.locator('#username').fill('carol@example.test');
    await g.locator('#password').fill('wrong-password');
    await g.locator('#kc-login').click();
    await g.waitForLoadState('networkidle');
    const text = (await g.locator('body').innerText()).replace(/\s+/g, ' ');
    await ctxG.close();
    return text;
  })();
  step('a wrong password is refused with a generic message', /无效|错误|不正确|invalid/i.test(tooShort), tooShort.slice(0, 80));
} catch (e) {
  step('smoke run', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser.close();
  server.kill();
  await new Promise((r) => server.once('exit', r));
  const text = logs.join('');
  writeFileSync(join(work, 'nexus-server.log'), text);
  const secrets = [env.NEXUS_OIDC_CLIENT_SECRET, env.NEXUS_DB_PASSWORD, LEGACY_PASSWORD].filter((s) => text.includes(s));
  const patterns = text.match(/eyJ[A-Za-z0-9_-]{10,}\.|[?&]code=[A-Za-z0-9.-]{8}|nxs_[A-Za-z0-9]|nxd_[A-Za-z0-9]/g);
  step('server log contains no secrets, tokens or codes', !secrets.length && !patterns, { secrets: secrets.length, patterns });
  writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2));
}
