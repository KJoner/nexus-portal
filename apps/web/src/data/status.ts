import { LEVEL_LABEL, summarize, type AppEntry, type ServiceStatus, type StatusLevel, type StatusSummary } from '@nexus/shared';
import { useMemo } from 'react';
import { useConfigStore } from './config-store';

export interface ServiceView {
  app: AppEntry;
  level: StatusLevel;
  levelLabel: string;
  message: string;
  checkedAt: string | null;
}

/**
 * Live statuses pushed by the Nexus health checker (batch 3). Until a check has actually run,
 * a service is 未监测 (check off) or 未知 (check on, no result yet) — never reported as healthy.
 */
const live = new Map<string, ServiceStatus>();

function viewOf(app: AppEntry, online: boolean): ServiceView {
  const s = live.get(app.id);
  if (!app.health.enabled) return { app, level: 'off', levelLabel: LEVEL_LABEL.off, message: '未开启健康检查', checkedAt: null };
  // R1.5: 「Nexus 本身离线」 is 未知 — no alarm, because nothing could be confirmed.
  if (!online) return { app, level: 'unknown', levelLabel: LEVEL_LABEL.unknown, message: '无法连接 Nexus 服务端', checkedAt: s?.checkedAt ?? null };
  if (!s) return { app, level: 'unknown', levelLabel: LEVEL_LABEL.unknown, message: '等待首次检查', checkedAt: null };
  return { app, level: s.level, levelLabel: LEVEL_LABEL[s.level], message: s.message, checkedAt: s.checkedAt };
}

/** `services` excludes hidden ones; `all` keeps them for the drawer's 已隐藏 view. */
export function useServices(): { services: ServiceView[]; all: ServiceView[]; summary: StatusSummary } {
  const apps = useConfigStore((s) => s.snapshot.config.apps);
  const online = useConfigStore((s) => s.online);
  const fallback = useConfigStore((s) => s.fallback);
  const pending = useConfigStore((s) => s.pending.length);
  return useMemo(() => {
    const all = apps.filter((a) => a.kind === 'service').map((a) => viewOf(a, online));
    const services = all.filter((s) => !s.app.hidden);
    const summary: StatusSummary = online
      ? summarize(services.map((s) => ({ name: s.app.name, level: s.level })))
      : { level: 'unknown', text: 'Nexus 服务端离线', more: fallback ? '显示默认配置' : pending ? `${pending} 项更改待同步` : '' };
    return { services, all, summary };
  }, [apps, online, fallback, pending]);
}
