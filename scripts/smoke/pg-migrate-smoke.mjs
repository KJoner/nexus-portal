// 本机冒烟（合成数据）：自托管（SQLite）Nexus 写入合成数据 → migrate-to-pg（演练、正式、重复）→
// 同一部署切到 PostgreSQL 后逐项核对。前置：npm run build；一个一次性的 PostgreSQL（容器）。
// 在仓库根目录运行：node scripts/smoke/pg-migrate-smoke.mjs <输出目录> <postgres 管理连接串> <新库名>
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';

const [work, adminUrl, dbName] = process.argv.slice(2);
const root = process.cwd();
const dataDir = resolve(work, 'data');
rmSync(work, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const PORT = 28787;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = randomBytes(12).toString('hex');
const SECRET = randomBytes(24).toString('hex');
const targetUrl = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);
const log = [];
const note = (k, v) => {
  log.push([k, v]);
  console.log(k, typeof v === 'string' ? v : JSON.stringify(v));
};
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

function baseEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NEXUS_')));
  return { ...env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(PORT), NEXUS_DATA_DIR: dataDir, NEXUS_PASSWORD: PASSWORD, NEXUS_SECRET: SECRET, ...extra };
}

async function startServer(extra) {
  const out = [];
  const p = spawn(process.execPath, [join(root, 'apps/server/dist/index.mjs')], { env: baseEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => out.push(String(d)));
  p.stderr.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/session`);
      if (r.ok) return { p, out };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  throw new Error('server did not start:\n' + out.join(''));
}
async function stopServer(s) {
  s.p.kill();
  await new Promise((r) => s.p.once('exit', r));
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexus-client': '1' }, body: JSON.stringify({ password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}
const json = async (path, cookie, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie, 'x-nexus-client': '1', ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};
const upload = (path, cookie, bytes, name, type) => {
  const f = new FormData();
  f.append('file', new Blob([bytes], { type }), name);
  return json(path, cookie, { method: 'POST', body: f });
};

// ── 1. self-hosted on SQLite, synthetic data ───────────────────────────────────
let s = await startServer({});
let cookie = await login();
const before = await json('/api/config', cookie);
await json('/api/config/ops', cookie, { method: 'POST', body: JSON.stringify({ batchId: 'smoke-1', clientId: 'smoke', ops: [{ type: 'pin.remove', appId: 'youtube' }, { type: 'settings.patch', section: 'look', patch: { blur: 18 } }] }) });
const icon = await sharp({ create: { width: 96, height: 96, channels: 4, background: '#3a6ea5' } }).png().toBuffer();
const iconRes = await upload('/api/icons', cookie, icon, 'synthetic-icon.png', 'image/png');
const wall = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#20303f' } }).jpeg({ quality: 80 }).toBuffer();
const wallRes = await upload('/api/wallpapers', cookie, wall, 'synthetic-wallpaper.jpg', 'image/jpeg');
// A paired browser extension (device token) — must keep working after the move.
const start = await json('/api/pair/start', '', { method: 'POST', body: JSON.stringify({ name: 'Smoke 扩展' }) });
await json(`/api/devices/pairing/${encodeURIComponent(start.code)}`, cookie, { method: 'POST', body: JSON.stringify({ approve: true }) });
const polled = await json('/api/pair/poll', '', { method: 'POST', body: JSON.stringify({ pairId: start.pairId, secret: start.secret }) });
const src = await json('/api/config', cookie);
const wallList = await json('/api/wallpapers', cookie);
note('sqlite.revision', `${before.revision} → ${src.revision}`);
note('sqlite.pins', src.config.pins);
note('sqlite.icon', iconRes.id);
note('sqlite.wallpapers', wallList.map((w) => w.id));
note('sqlite.device', polled.status);
const fetchSha = async (path, headers) => { const r = await fetch(`${BASE}${path}`, { headers }); return `${r.status} ${sha(Buffer.from(await r.arrayBuffer()))}`; };
const iconPath = `/api/icons/${iconRes.id}`;
const wallPath = `/api/wallpapers/${wallList[0].id}/1920.jpg`;
const iconBefore = await fetchSha(iconPath, { cookie });
const wallBefore = await fetchSha(wallPath, { cookie });
note('sqlite.files', { icon: iconBefore, wallpaper: wallBefore });
await stopServer(s);

// ── 2. target database ─────────────────────────────────────────────────────────
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`drop database if exists ${dbName}`);
await admin.query(`create database ${dbName}`);
await admin.end();

const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(root, 'apps/server/dist/cli.mjs'), 'migrate-to-pg', '--sqlite', join(dataDir, 'nexus.db'), '--data', dataDir, ...args], { env: baseEnv({ NEXUS_DATABASE_URL: targetUrl }), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
const dry = cli('--dry-run');
note('cli.dry-run.exit', dry.code);
writeFileSync(join(work, 'dry-run.txt'), dry.out);
const real = cli();
note('cli.migrate.exit', real.code);
writeFileSync(join(work, 'migrate.txt'), real.out);
const again = cli();
note('cli.repeat.exit', again.code);
writeFileSync(join(work, 'repeat.txt'), again.out);
const counts = new pg.Client({ connectionString: targetUrl });
await counts.connect();
const rows = {};
for (const t of ['users', 'user_config', 'op_log', 'auth', 'wallpapers', 'icons', 'devices', 'migration_source']) rows[t] = (await counts.query(`select count(*)::int as n from ${t}`)).rows[0].n;
note('pg.rows', rows);
await counts.end();

// ── 3. the same deployment on PostgreSQL ──────────────────────────────────────
s = await startServer({ NEXUS_DATABASE_URL: targetUrl });
cookie = await login();
const dst = await json('/api/config', cookie);
note('pg.revision', dst.revision);
note('pg.same-config', JSON.stringify(dst.config) === JSON.stringify(src.config));
const wallAfter = await json('/api/wallpapers', cookie);
note('pg.wallpapers', wallAfter.map((w) => w.id));
const iconAfter = await fetchSha(iconPath, { cookie });
const wallFileAfter = await fetchSha(wallPath, { cookie });
note('pg.files', { icon: iconAfter, wallpaper: wallFileAfter, identical: iconAfter === iconBefore && wallFileAfter === wallBefore });
note('pg.device-files', { icon: await fetchSha(`/api/sync/icons/${iconRes.id}`, { authorization: `Bearer ${polled.token}` }), wallpaper: await fetchSha(`/api/sync/wallpapers/${wallList[0].id}/1920.jpg`, { authorization: `Bearer ${polled.token}` }) });
const dev = await fetch(`${BASE}/api/sync/config`, { headers: { authorization: `Bearer ${polled.token}` } });
note('pg.device-token', dev.status);
// A write on PostgreSQL continues the same revision history.
const after = await json('/api/config/ops', cookie, { method: 'POST', body: JSON.stringify({ batchId: 'smoke-2', clientId: 'smoke', ops: [{ type: 'pin.remove', appId: 'notion' }] }) });
note('pg.write', `${dst.revision} → ${after.revision}`);
// The batch sent before the move is still known: a late retry is not applied twice.
const retry = await json('/api/config/ops', cookie, { method: 'POST', body: JSON.stringify({ batchId: 'smoke-1', clientId: 'smoke', ops: [{ type: 'pin.remove', appId: 'youtube' }, { type: 'settings.patch', section: 'look', patch: { blur: 18 } }] }) });
note('pg.retry-old-batch', retry.revision === after.revision ? 'not applied again' : `APPLIED AGAIN (${retry.revision})`);
await stopServer(s);
const leaked = s.out.join('').match(/nxs_|nxd_|Bearer |password=/gi);
note('pg.server-log-secrets', leaked ? leaked : 'none');
writeFileSync(join(work, 'summary.json'), JSON.stringify(Object.fromEntries(log), null, 2));
