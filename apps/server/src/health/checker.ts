import { hostOf, type AppEntry, type ServiceStatus, type StatusLevel } from '@nexus/shared';
import type { ConfigRepo } from '../config/repo';
import type { DB } from '../db';
import type { NetPolicy } from '../net/ip';
import { probe as realProbe, type ProbeResult } from '../net/probe';

export type ProbeFn = typeof realProbe;

export interface Target {
  url: URL;
  via: 'lan' | 'ext';
}

/**
 * Where a service is checked: its LAN address when it has one (Nexus usually runs next to it),
 * otherwise its public address. Absolute targets must stay on one of the app's own hosts.
 */
export function checkTarget(app: AppEntry): Target | { error: string } {
  const base = app.lanUrl || app.url;
  const via = app.lanUrl ? 'lan' : 'ext';
  const t = app.health.target.trim() || '/';
  try {
    if (t.startsWith('/')) return { url: new URL(t, base), via };
    const url = new URL(t);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: '检查地址只能是 http 或 https' };
    if (url.host === hostOf(app.lanUrl)) return { url, via: 'lan' };
    if (url.host === hostOf(app.url)) return { url, via: 'ext' };
    return { error: '检查地址必须与外网或内网地址同一主机' };
  } catch {
    return { error: '检查地址格式不正确' };
  }
}

const SLOW_MS = 3000;
const CERT_WARN_DAYS = 14;

/** Five-state rule from R1.5 · 服务状态: one failure is 未知, two in a row is 异常. */
export function judge(p: ProbeResult, via: 'lan' | 'ext', prevFails: number): { level: StatusLevel; message: string; fails: number } {
  if (p.reached && p.status !== undefined && p.status < 500) {
    const s = p.status;
    if (s >= 400) return { level: 'warn', message: `HTTP ${s} · ${s === 401 || s === 403 ? '需要认证，换一个无需登录的检查地址' : '检查地址可能不正确'}`, fails: 0 };
    if ((p.latencyMs ?? 0) > SLOW_MS) return { level: 'warn', message: `响应缓慢 · ${((p.latencyMs ?? 0) / 1000).toFixed(1)} s`, fails: 0 };
    // Self-signed certificates are normal on a LAN; only the public address is held to it.
    if (p.untrustedCert && via === 'ext') return { level: 'warn', message: `证书不受信任 · HTTP ${s}`, fails: 0 };
    if (!p.untrustedCert && p.certDaysLeft !== undefined && p.certDaysLeft < CERT_WARN_DAYS) {
      return { level: 'warn', message: p.certDaysLeft < 0 ? '证书已过期' : `证书 ${p.certDaysLeft} 天后到期`, fails: 0 };
    }
    return { level: 'ok', message: `HTTP ${s} · ${p.latencyMs} ms${via === 'lan' ? ' · 内网' : ''}`, fails: 0 };
  }
  const fails = prevFails + 1;
  const reason = p.reached ? `HTTP ${p.status}` : p.message;
  return fails >= 2 ? { level: 'error', message: `${reason} · 连续 ${fails} 次失败`, fails } : { level: 'unknown', message: `${reason}，稍后重试`, fails };
}

interface Stored extends ServiceStatus {
  fails: number;
  key: string;
}

const MAX_CONCURRENT = 4;

/** Runs each enabled service's check on its own interval; results survive restarts. */
export class HealthChecker {
  private statuses = new Map<string, Stored>();
  private timers = new Map<string, { key: string; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(s: ServiceStatus | { appId: string; removed: true }) => void>();
  private running = 0;
  private queue: (() => void)[] = [];
  private stopped = false;
  private offChange: (() => void) | null = null;

  constructor(
    private db: DB,
    private repo: ConfigRepo,
    private policy: NetPolicy,
    private probe: ProbeFn = realProbe,
  ) {
    for (const r of db.prepare('select * from health_status').all() as { app_id: string; level: StatusLevel; message: string; checked_at: string; latency_ms: number | null; fails: number; key: string; via: 'lan' | 'ext' }[]) {
      this.statuses.set(r.app_id, { appId: r.app_id, level: r.level, message: r.message, checkedAt: r.checked_at, latencyMs: r.latency_ms, via: r.via, fails: r.fails, key: r.key });
    }
  }

  start() {
    this.stopped = false;
    this.offChange = this.repo.onChange(() => this.sync());
    this.sync();
  }

  stop() {
    this.stopped = true;
    this.offChange?.();
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
  }

  list(): ServiceStatus[] {
    return [...this.statuses.values()].map(({ fails: _f, key: _k, ...s }) => s);
  }

  onStatus(fn: (s: ServiceStatus | { appId: string; removed: true }) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private enabledApps(): AppEntry[] {
    return this.repo.snapshot().config.apps.filter((a) => a.kind === 'service' && a.health.enabled && !a.hidden);
  }

  private keyOf(app: AppEntry) {
    return JSON.stringify([app.url, app.lanUrl, app.health.target, app.health.intervalSec]);
  }

  /** Reconciles schedules with the configuration after every change. */
  sync() {
    if (this.stopped) return;
    const apps = this.enabledApps();
    const ids = new Set(apps.map((a) => a.id));
    for (const [id, t] of this.timers) {
      if (!ids.has(id)) {
        clearTimeout(t.timer);
        this.timers.delete(id);
      }
    }
    for (const id of [...this.statuses.keys()]) {
      if (!ids.has(id)) {
        this.statuses.delete(id);
        this.db.prepare('delete from health_status where app_id = ?').run(id);
        this.emit({ appId: id, removed: true });
      }
    }
    for (const app of apps) {
      const key = this.keyOf(app);
      const t = this.timers.get(app.id);
      if (t?.key === key) continue;
      if (t) clearTimeout(t.timer);
      // A changed target starts fresh; an unchanged one resumes its interval after a restart.
      const prev = this.statuses.get(app.id);
      const fresh = !prev || prev.key !== key;
      const delay = fresh ? Math.random() * 1500 : Math.max(0, app.health.intervalSec * 1000 - (Date.now() - Date.parse(prev.checkedAt ?? '0')));
      this.schedule(app.id, key, delay);
    }
  }

  private schedule(appId: string, key: string, delay: number) {
    const timer = setTimeout(() => void this.runNow(appId), delay);
    this.timers.set(appId, { key, timer });
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  /** Checks one service now and reschedules it. */
  async runNow(appId: string): Promise<ServiceStatus | null> {
    const app = this.enabledApps().find((a) => a.id === appId);
    if (!app) return null;
    const key = this.keyOf(app);
    const t = this.timers.get(appId);
    if (t) clearTimeout(t.timer);
    const target = checkTarget(app);
    const prev = this.statuses.get(appId);
    const prevFails = prev?.key === key ? prev.fails : 0;
    let result: { level: StatusLevel; message: string; fails: number };
    let latencyMs: number | null = null;
    let via: 'lan' | 'ext' = 'ext';
    if ('error' in target) result = { level: 'warn', message: target.error, fails: 0 };
    else {
      via = target.via;
      const p = await this.slot(() => this.probe(target.url, this.policy));
      latencyMs = p.latencyMs ?? null;
      result = judge(p, target.via, prevFails);
    }
    if (this.stopped || !this.enabledApps().some((a) => a.id === appId && this.keyOf(a) === key)) return null;
    const status: Stored = { appId, level: result.level, message: result.message, checkedAt: new Date().toISOString(), latencyMs, via, fails: result.fails, key };
    this.statuses.set(appId, status);
    this.db
      .prepare('insert into health_status (app_id, level, message, checked_at, latency_ms, fails, key, via) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(app_id) do update set level = excluded.level, message = excluded.message, checked_at = excluded.checked_at, latency_ms = excluded.latency_ms, fails = excluded.fails, key = excluded.key, via = excluded.via')
      .run(appId, status.level, status.message, status.checkedAt, latencyMs, status.fails, key, via);
    const { fails: _f, key: _k, ...pub } = status;
    this.emit(pub);
    // Failing services are re-checked sooner so a blip clears (or escalates) quickly.
    const interval = app.health.intervalSec * 1000;
    this.schedule(appId, key, result.level === 'unknown' ? Math.min(interval, 15_000) : interval);
    return pub;
  }

  /** 测试连接: a one-off check of an unsaved draft; nothing is stored. */
  async test(app: AppEntry): Promise<{ ok: boolean; level: StatusLevel; message: string }> {
    const target = checkTarget(app);
    if ('error' in target) return { ok: false, level: 'warn', message: target.error };
    const p = await this.slot(() => this.probe(target.url, this.policy));
    const r = judge(p, target.via, 1);
    return { ok: r.level === 'ok', level: r.level === 'error' ? 'error' : r.level, message: r.level === 'error' ? p.message : r.message };
  }

  private emit(s: ServiceStatus | { appId: string; removed: true }) {
    for (const fn of this.listeners) fn(s);
  }
}
