import { defaultConfig, type AppEntry } from '@nexus/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepo } from '../config/repo';
import { openDb, type DB } from '../db';
import { classifyIp, isAllowed } from '../net/ip';
import { probe, type ProbeResult } from '../net/probe';
import { checkTarget, HealthChecker, judge } from './checker';

describe('classifyIp', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['192.168.1.20', 'private'],
    ['10.0.0.5', 'private'],
    ['172.20.1.1', 'private'],
    ['100.101.102.103', 'private'], // Tailscale
    ['198.18.0.250', 'private'], // Clash / Mihomo fake-ip
    ['2001:2::f6', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'linklocal'], // cloud metadata
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'linklocal'],
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'linklocal'], // AWS IPv6 metadata
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'linklocal'],
    ['64:ff9b::a9fe:a9fe', 'linklocal'], // NAT64 of 169.254.169.254
    ['2606:4700::1111', 'public'],
    ['not-an-ip', 'reserved'],
  ])('%s → %s', (ip, cls) => {
    expect(classifyIp(ip)).toBe(cls);
  });

  it('policy: private on by default, loopback and metadata never by default', () => {
    const policy = { allowPrivate: true, allowLoopback: false };
    expect(isAllowed('192.168.1.2', policy)).toBe(true);
    expect(isAllowed('127.0.0.1', policy)).toBe(false);
    expect(isAllowed('169.254.169.254', { allowPrivate: true, allowLoopback: true })).toBe(false);
    expect(isAllowed('10.1.1.1', { allowPrivate: false, allowLoopback: false })).toBe(false);
  });
});

describe('probe', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/slow') return setTimeout(() => res.end('late'), 400);
      if (req.url === '/missing') return res.writeHead(404).end();
      if (req.url === '/redirect') return res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => server.close());

  const loop = { allowPrivate: true, allowLoopback: true };

  it('reports status and latency', async () => {
    const r = await probe(new URL('/health', base), loop);
    expect(r).toMatchObject({ reached: true, status: 200 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('does not follow redirects (no hop to a forbidden address)', async () => {
    expect(await probe(new URL('/redirect', base), loop)).toMatchObject({ reached: true, status: 302 });
  });

  it('times out', async () => {
    expect(await probe(new URL('/slow', base), loop, 100)).toMatchObject({ reached: false, errorCode: 'TIMEOUT' });
  });

  it('blocks loopback by default, including names that resolve to it', async () => {
    const policy = { allowPrivate: true, allowLoopback: false };
    expect(await probe(new URL('/health', base), policy)).toMatchObject({ reached: false, errorCode: 'EBLOCKED' });
    const port = (server.address() as AddressInfo).port;
    expect(await probe(new URL(`http://localhost:${port}/`), policy)).toMatchObject({ reached: false, errorCode: 'EBLOCKED' });
  });

  it('refuses the cloud metadata address outright', async () => {
    expect(await probe(new URL('http://169.254.169.254/latest/meta-data/'), loop, 1000)).toMatchObject({ errorCode: 'EBLOCKED' });
  });

  it('reports refused connections', async () => {
    const r = await probe(new URL('http://127.0.0.1:1/'), loop, 2000);
    expect(r.reached).toBe(false);
    expect(r.message).toBe('连接被拒绝');
  });
});

const svc = (over: Partial<AppEntry> = {}): AppEntry => ({ ...defaultConfig().apps.find((a) => a.id === 'litebox')!, ...over });

describe('checkTarget / judge', () => {
  it('prefers the LAN address and keeps absolute targets on the app’s hosts', () => {
    const a = svc({ lanUrl: 'http://192.168.1.10:8008', health: { enabled: true, target: '/api/status', intervalSec: 60 } });
    expect(checkTarget(a)).toMatchObject({ via: 'lan' });
    expect(String((checkTarget(a) as { url: URL }).url)).toBe('http://192.168.1.10:8008/api/status');
    expect(checkTarget({ ...a, health: { ...a.health, target: 'http://169.254.169.254/' } })).toEqual({ error: '检查地址必须与外网或内网地址同一主机' });
  });

  const ok: ProbeResult = { reached: true, status: 200, latencyMs: 80, message: 'HTTP 200' };
  it('maps responses to the five states', () => {
    expect(judge(ok, 'lan', 0)).toEqual({ level: 'ok', message: 'HTTP 200 · 80 ms · 内网', fails: 0 });
    expect(judge({ ...ok, status: 404 }, 'ext', 0).level).toBe('warn');
    expect(judge({ ...ok, latencyMs: 4200 }, 'ext', 0).message).toBe('响应缓慢 · 4.2 s');
    expect(judge({ ...ok, certDaysLeft: 5 }, 'ext', 0).message).toBe('证书 5 天后到期');
    expect(judge({ ...ok, untrustedCert: 'SELF_SIGNED' }, 'lan', 0).level).toBe('ok');
    expect(judge({ ...ok, untrustedCert: 'SELF_SIGNED' }, 'ext', 0).level).toBe('warn');
  });

  it('one failure is unknown, two in a row is error', () => {
    const down: ProbeResult = { reached: false, errorCode: 'ECONNREFUSED', message: '连接被拒绝' };
    const first = judge(down, 'ext', 0);
    expect(first).toEqual({ level: 'unknown', message: '连接被拒绝，稍后重试', fails: 1 });
    expect(judge(down, 'ext', first.fails)).toEqual({ level: 'error', message: '连接被拒绝 · 连续 2 次失败', fails: 2 });
    expect(judge({ ...ok, status: 503 }, 'ext', 1).level).toBe('error');
  });
});

describe('HealthChecker', () => {
  let db: DB;
  let repo: ConfigRepo;
  let results: ProbeResult[];
  let checker: HealthChecker;
  beforeEach(() => {
    db = openDb(':memory:');
    repo = new ConfigRepo(db);
    results = [];
    checker = new HealthChecker(db, repo, { allowPrivate: true, allowLoopback: false }, async () => results.shift() ?? { reached: true, status: 200, latencyMs: 10, message: 'HTTP 200' });
  });
  afterEach(() => {
    checker.stop();
    db.close();
  });

  const enable = (id: string, hidden = false) => {
    const app = repo.snapshot().config.apps.find((a) => a.id === id)!;
    const r = repo.apply(`b-${Math.random()}`, 'test', [{ type: 'app.upsert', app: { ...app, hidden, health: { enabled: true, target: '/health', intervalSec: 60 } } }]);
    repo.emit(r.snapshot.revision);
  };

  it('checks enabled services only, persists results and escalates failures', async () => {
    checker.start();
    expect(await checker.runNow('litebox')).toBeNull();
    enable('litebox');
    results.push({ reached: false, errorCode: 'TIMEOUT', message: '请求超时' }, { reached: false, errorCode: 'TIMEOUT', message: '请求超时' });
    expect((await checker.runNow('litebox'))?.level).toBe('unknown');
    expect((await checker.runNow('litebox'))?.level).toBe('error');
    expect((await checker.runNow('litebox'))?.level).toBe('ok');
    const restarted = new HealthChecker(db, repo, { allowPrivate: true, allowLoopback: false });
    expect(restarted.list()).toMatchObject([{ appId: 'litebox', level: 'ok' }]);
  });

  it('drops a service’s status when its check is turned off or it is hidden', async () => {
    const events: unknown[] = [];
    checker.onStatus((s) => events.push(s));
    checker.start();
    enable('obsync');
    await checker.runNow('obsync');
    enable('obsync', true);
    expect(checker.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ appId: 'obsync', removed: true });
  });
});
