// Smoke test for a running Nexus container: web shell, API, login, a real write.
//   SMOKE_PASSWORD=… node scripts/smoke.mjs http://127.0.0.1:8787 [--persisted]
// --persisted: expect a write from an earlier run to have survived a restart.
const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const persisted = process.argv.includes('--persisted');
const password = process.env.SMOKE_PASSWORD;
if (!password) throw new Error('SMOKE_PASSWORD is required');

const write = { 'X-Nexus-Client': '1', 'content-type': 'application/json', origin: new URL(base).origin };
let failed = 0;
async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`ok   ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${e.message}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

await check('healthz', async () => {
  const r = await fetch(`${base}/api/healthz`);
  expect(r.ok, `HTTP ${r.status}`);
  expect((await r.json()).ok === true, 'body is not { ok: true }');
});

let asset;
await check('web shell', async () => {
  const r = await fetch(`${base}/`);
  const html = await r.text();
  expect(r.ok && html.includes('id="root"'), `HTTP ${r.status}, no app root`);
  expect(r.headers.get('content-security-policy'), 'no Content-Security-Policy');
  expect(r.headers.get('cache-control') === 'no-cache', `HTML cache-control: ${r.headers.get('cache-control')}`);
  asset = html.match(/\/assets\/[\w.-]+\.js/)?.[0];
  expect(asset, 'no script asset referenced');
});

await check('hashed assets are immutable', async () => {
  const r = await fetch(`${base}${asset}`);
  expect(r.ok, `HTTP ${r.status}`);
  expect(r.headers.get('cache-control')?.includes('immutable'), `cache-control: ${r.headers.get('cache-control')}`);
});

await check('service worker is revalidated', async () => {
  const r = await fetch(`${base}/sw.js`);
  expect(r.ok && r.headers.get('cache-control') === 'no-cache', `HTTP ${r.status}, cache-control: ${r.headers.get('cache-control')}`);
});

await check('config needs a session', async () => {
  const r = await fetch(`${base}/api/config`);
  expect(r.status === 401, `HTTP ${r.status}`);
});

await check('writes need the client header', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(r.status === 403, `HTTP ${r.status}`);
});

let cookie;
await check('login', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: write, body: JSON.stringify({ password }) });
  expect(r.ok, `HTTP ${r.status}`);
  cookie = r.headers.get('set-cookie')?.split(';')[0];
  expect(cookie?.startsWith('nexus_session='), 'no session cookie');
  expect(/httponly/i.test(r.headers.get('set-cookie')), 'session cookie is not HttpOnly');
});

await check('config read + write', async () => {
  const r = await fetch(`${base}/api/config`, { headers: { cookie } });
  expect(r.ok, `GET HTTP ${r.status}`);
  const before = await r.json();
  if (persisted) expect(before.revision > 1, `revision ${before.revision}: earlier write was lost`);
  // Toggle one app's visibility and toggle it back, so running this against a real instance
  // leaves the configuration as it was (only the revision moves).
  const app = before.config.apps[0];
  const send = (hidden, n) =>
    fetch(`${base}/api/config/ops`, { method: 'POST', headers: { ...write, cookie }, body: JSON.stringify({ clientId: 'smoke', batchId: `smoke-${Date.now()}-${n}`, ops: [{ type: 'app.setHidden', appId: app.id, hidden }] }) });
  const w = await send(!app.hidden, 1);
  expect(w.ok, `POST HTTP ${w.status}`);
  const after = await w.json();
  expect(after.revision === before.revision + 1, `revision ${before.revision} → ${after.revision}`);
  const undo = await send(Boolean(app.hidden), 2);
  expect(undo.ok, `restore POST HTTP ${undo.status}`);
  return `revision ${before.revision} → ${after.revision}, restored`;
});

await check('service status endpoint', async () => {
  const r = await fetch(`${base}/api/status`, { headers: { cookie } });
  expect(r.ok, `HTTP ${r.status}`);
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
