import { LEVEL_LABEL, summarize, type AppEntry, type ServiceStatus, type StatusLevel, type StatusSummary } from '@nexus/shared';
import { useMemo } from 'react';
import { useConfig } from './config-store';

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

function viewOf(app: AppEntry): ServiceView {
  const s = live.get(app.id);
  if (!app.health.enabled) return { app, level: 'off', levelLabel: LEVEL_LABEL.off, message: '未开启健康检查', checkedAt: null };
  if (!s) return { app, level: 'unknown', levelLabel: LEVEL_LABEL.unknown, message: '等待首次检查', checkedAt: null };
  return { app, level: s.level, levelLabel: LEVEL_LABEL[s.level], message: s.message, checkedAt: s.checkedAt };
}

/** `services` excludes hidden ones; `all` keeps them for the drawer's 已隐藏 view. */
export function useServices(): { services: ServiceView[]; all: ServiceView[]; summary: StatusSummary } {
  const config = useConfig();
  return useMemo(() => {
    const all = config.apps.filter((a) => a.kind === 'service').map(viewOf);
    const services = all.filter((s) => !s.app.hidden);
    return { services, all, summary: summarize(services.map((s) => ({ name: s.app.name, level: s.level }))) };
  }, [config.apps]);
}
