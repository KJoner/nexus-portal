// 本机冒烟（合成数据，不连生产）：ADR-019 账号撤销在真实 Keycloak 上的 Nexus 一侧——动作 C（用户本人
// 令牌经 Account REST 结束所有浏览器的会话 + 签名的跨产品事件）与动作 D（只读服务账号发现中心停用）。
// 前置：npm run build；一个一次性 Keycloak（infra/identity 的 compose，或 start-dev --import-realm
// 导入 realm 模板），其 .env 里 NEXUS_PUBLIC_URL=http://127.0.0.1:39410。另一个产品用本脚本内的收信器
// 代替（127.0.0.1:39413，用同一密钥验签并按协议回答），不需要 LiteSync。
// 用法：node scripts/smoke/revocation-smoke.mjs <含 .env 的 identity 目录> <输出目录>
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NEXUS_DIR = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const require = createRequire(`${NEXUS_DIR}/package.json`);
const { chromium } = require('playwright');

const [idDir, work] = process.argv.slice(2);
const env = Object.fromEntries(readFileSync(join(idDir, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const KC = env.ACCOUNTS_PUBLIC_URL;
const PUBLIC = 'http://127.0.0.1:39410';
if (env.NEXUS_PUBLIC_URL !== PUBLIC) throw new Error(`realm 的 NEXUS_PUBLIC_URL 必须是 ${PUBLIC}（回调地址要完全一致）`);
const PEER_SECRET = randomBytes(32).toString('hex');
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function createUser(email) {
  const password = `Pw-${randomBytes(9).toString('base64url')}`;
  const r = await kc('/users', { method: 'POST', body: JSON.stringify({ username: email, email, emailVerified: true, enabled: true, firstName: '合成', lastName: '用户', credentials: [{ type: 'password', value: password, temporary: false }] }) });
  if (r.status !== 201) throw new Error(`create user ${r.status} ${JSON.stringify(r.body)}`);
  return { email, password, id: r.location.split('/').pop() };
}

// ── The other product, played by a receiver that checks the signature like LiteSync must ──────
const received = [];
const peer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const ts = String(req.headers['x-revocation-timestamp'] ?? '');
    const sig = String(req.headers['x-revocation-signature'] ?? '');
    const expected = `v1=${createHmac('sha256', Buffer.from(PEER_SECRET, 'utf8')).update(`${ts}.`).update(raw).digest('hex')}`;
    const signed = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    received.push({ path: req.url, signed, fresh, body: JSON.parse(raw.toString('utf8') || '{}'), keys: Object.keys(JSON.parse(raw.toString('utf8') || '{}')) });
    if (!signed || !fresh) return void res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ applied: false, reason: 'unknown-identity' }));
  });
});
await new Promise((r) => peer.listen(39413, '127.0.0.1', r));

// ── Nexus (production bundle, SQLite in a temp dir) with C and D configured ───────────────────
const logs = [];
const server = spawn(process.execPath, [`${NEXUS_DIR}/apps/server/dist/index.mjs`], {
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NEXUS_'))),
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '39410',
    NEXUS_DATA_DIR: join(work, 'nexus-data'),
    NEXUS_PUBLIC_URL: PUBLIC,
    NEXUS_OIDC_ISSUER: `${KC}/realms/accounts`,
    NEXUS_OIDC_CLIENT_ID: 'nexus-web',
    NEXUS_OIDC_CLIENT_SECRET: env.NEXUS_OIDC_CLIENT_SECRET,
    NEXUS_REGISTRATION_MODE: 'open',
    NEXUS_PASSWORD: randomBytes(12).toString('hex'),
    NEXUS_SECRET: randomBytes(24).toString('hex'),
    NEXUS_PEER_REVOCATION_URL: 'http://127.0.0.1:39413',
    NEXUS_PEER_REVOCATION_SECRET: PEER_SECRET,
    NEXUS_IDENTITY_STATUS_CHECK: 'on',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => logs.push(String(d)));
server.stderr.on('data', (d) => logs.push(String(d)));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${PUBLIC}/api/v2/auth/options`)).ok) break;
  } catch {}
  await sleep(200);
}

const browser = await chromium.launch();
const api = (page, path, method = 'GET') =>
  page.evaluate(
    async ([p, m]) => {
      const r = await fetch(p, { method: m, headers: { 'X-Nexus-Client': '1' } });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, method],
  );
/** Through Keycloak's own login page — or straight back, when this browser still has an SSO session. */
async function signIn(page, user) {
  await page.goto(`${PUBLIC}/`);
  await page.getByRole('button', { name: '使用统一账号登录' }).click();
  for (let i = 0; i < 40; i++) {
    if (page.url().startsWith(`${KC}/`) && (await page.locator('#password').isVisible().catch(() => false))) {
      await page.locator('#username').fill(user.email);
      await page.locator('#password').fill(user.password);
      await page.locator('#kc-login').click();
      await page.waitForURL((u) => u.href.startsWith(PUBLIC) && !u.pathname.startsWith('/auth/'), { timeout: 20_000 });
      return;
    }
    if (page.url().startsWith(PUBLIC) && (await api(page, '/api/v2/me').catch(() => ({ status: 0 }))).status === 200) return;
    await sleep(500);
  }
  throw new Error(`没有完成登录：停在 ${new URL(page.url()).pathname}`);
}
async function pairDevice(page) {
  const start = await (await fetch(`${PUBLIC}/api/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexus-client': '1' }, body: JSON.stringify({ name: '合成扩展', scopes: ['config:read', 'items:read', 'items:write'] }) })).json();
  const ok = await page.evaluate(async (code) => (await fetch(`/api/devices/pairing/${code}`, { method: 'POST', headers: { 'X-Nexus-Client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ approve: true }) })).status, start.code);
  if (ok !== 200) throw new Error(`approve ${ok}`);
  const polled = await (await fetch(`${PUBLIC}/api/pair/poll`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexus-client': '1' }, body: JSON.stringify({ pairId: start.pairId, secret: start.secret }) })).json();
  return polled.token;
}
const deviceRead = async (token) => (await fetch(`${PUBLIC}/api/sync/config`, { headers: { authorization: `Bearer ${token}` } })).status;

try {
  const user = await createUser(`adr019-${randomBytes(4).toString('hex')}@example.invalid`);
  // Two browsers, two identity-service sessions.
  const ctx1 = await browser.newContext({ locale: 'zh-CN' });
  const p1 = await ctx1.newPage();
  await signIn(p1, user);
  const ctx2 = await browser.newContext({ locale: 'zh-CN' });
  const p2 = await ctx2.newPage();
  await signIn(p2, user);
  const before = (await kc(`/users/${user.id}/sessions`)).body.length;
  step('two browsers signed in: two identity-service sessions', before === 2, before);
  const device = await pairDevice(p1);
  step('a paired extension reads with its token', (await deviceRead(device)) === 200);

  // 动作 C from browser 1, through the real page.
  await p1.goto(`${PUBLIC}/settings/data`);
  await p1.getByRole('button', { name: /退出所有产品/ }).click();
  await p1.getByRole('dialog').getByRole('button', { name: '退出所有产品' }).click();
  await p1.getByRole('region', { name: '退出所有产品与设备的结果' }).waitFor({ timeout: 30_000 });
  const panel = (await p1.getByRole('region', { name: '退出所有产品与设备的结果' }).innerText()).replace(/\s+/g, ' ');
  step('C: the login page shows each part (Nexus done, identity service done, other product delivered)', /Nexus：已完成/.test(panel) && /账号中心：已结束你在所有浏览器的登录/.test(panel) && /LiteSync：已送达/.test(panel), panel.slice(0, 200));
  await sleep(1500);
  const after = (await kc(`/users/${user.id}/sessions`)).body.length;
  step('C: every identity-service session of the user ended (both browsers) — via the user’s own token', after === 0, { before, after });
  step('C: the other browser’s Nexus session ended', (await api(p2, '/api/v2/me')).status === 401);
  step('C: the extension’s token is refused', (await deviceRead(device)) === 401);
  const ev = received[0];
  step('C: one signed event reached the other product, ADR-019 §2.4 fields in order', received.length === 1 && ev.signed && ev.fresh && ev.path === '/api/internal/v1/account-revocations' && JSON.stringify(ev.keys) === JSON.stringify(['v', 'eventId', 'issuer', 'subject', 'scope', 'reason', 'origin', 'occurredAt']) && ev.body.issuer === `${KC}/realms/accounts` && ev.body.subject === user.id && ev.body.scope === 'all-products-all-devices' && ev.body.origin === 'nexus', { count: received.length, signed: ev?.signed, keys: ev?.keys, subjectIsKeycloakId: ev?.body?.subject === user.id });
  // Browser 2 must enter the password again: its identity-service session is gone too.
  await p2.goto(`${PUBLIC}/`);
  await p2.getByRole('button', { name: '使用统一账号登录' }).click();
  await p2.waitForURL((u) => u.href.startsWith(`${KC}/`));
  step('C: the other browser must sign in to the identity service again', await p2.locator('#password').isVisible(), new URL(p2.url()).pathname);

  // 动作 D: disabled in Keycloak → refused within 60 s (+ one check) by the read-only service account.
  await signIn(p1, user);
  const device2 = await pairDevice(p1);
  step('D: a new extension after signing in again works', (await deviceRead(device2)) === 200);
  const u = (await kc(`/users/${user.id}`)).body;
  await kc(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ ...u, enabled: false }) });
  const disabledAt = Date.now();
  let refusedAfter = null;
  for (let i = 0; i < 80 && refusedAfter === null; i++) {
    await sleep(1000);
    if ((await deviceRead(device2)) === 401) refusedAfter = Date.now() - disabledAt;
  }
  step('D: the extension is refused within 60 s of disabling (plus one check)', refusedAfter !== null && refusedAfter <= 63_000, { refusedAfterMs: refusedAfter });
  step('D: the web session is refused too', (await api(p1, '/api/v2/me')).status === 401);
  step('D: Nexus logged 动作 B with reason central-disabled', logs.join('').includes('central-disabled'));
  await kc(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ ...u, enabled: true }) });
  await signIn(p1, user);
  step('enabled again: signing in works, the old extension stays revoked (R-2)', (await api(p1, '/api/v2/me')).status === 200 && (await deviceRead(device2)) === 401);
  await kc(`/users/${user.id}`, { method: 'DELETE' });
} catch (e) {
  step('smoke run', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser.close();
  server.kill();
  peer.close();
  await new Promise((r) => server.once('exit', r));
  const text = logs.join('');
  writeFileSync(join(work, 'nexus-server.log'), text);
  const secrets = [env.NEXUS_OIDC_CLIENT_SECRET, PEER_SECRET].filter((s) => text.includes(s));
  const patterns = text.match(/eyJ[A-Za-z0-9_-]{10,}\.|[?&]code=[A-Za-z0-9.-]{8}|nxs_[A-Za-z0-9]|nxd_[A-Za-z0-9]/g);
  step('server log contains no secrets, tokens or codes', !secrets.length && !patterns, { secrets: secrets.length, patterns });
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(work, 'results.json'), JSON.stringify({ keycloak: '26.8.1', total: results.length, failed, results }, null, 2));
  console.log(JSON.stringify({ total: results.length, failed }));
  process.exitCode = failed ? 1 : 0;
}
