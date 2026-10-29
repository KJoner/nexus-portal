export type StatusLevel = 'ok' | 'warn' | 'error' | 'unknown' | 'off';

export const LEVEL_LABEL: Record<StatusLevel, string> = {
  ok: '正常',
  warn: '警告',
  error: '异常',
  unknown: '未知',
  off: '未监测',
};

/** Live state of one service as reported by the Nexus health checker. */
export interface ServiceStatus {
  appId: string;
  level: StatusLevel;
  /** Human readable, e.g. `200 · 86 ms` or `连续 2 次超时`. */
  message: string;
  checkedAt: string | null;
  latencyMs: number | null;
  /** Which address was checked: the LAN one when the app has it. */
  via?: 'lan' | 'ext';
}

export interface HealthTestResult {
  ok: boolean;
  level: StatusLevel;
  message: string;
}

export interface StatusSummary {
  level: StatusLevel;
  text: string;
  more: string;
}

const SEVERITY: StatusLevel[] = ['error', 'warn', 'unknown'];

/**
 * Pill text following R1.5: only the most severe issue is named (异常 > 警告 > 未知 > 正常);
 * 未监测 never counts as healthy and never adds colour.
 */
export function summarize(services: ReadonlyArray<{ name: string; level: StatusLevel }>): StatusSummary {
  const by = (l: StatusLevel) => services.filter((s) => s.level === l);
  const off = by('off').length;
  for (const level of SEVERITY) {
    const hits = by(level);
    if (!hits.length) continue;
    const name = hits[0]!.name;
    const others = services.filter((s) => s !== hits[0] && SEVERITY.includes(s.level)).length;
    const text = level === 'error' ? `${name} 无法访问` : level === 'warn' ? `${name} 需要处理` : `${name} 状态未知`;
    return { level, text, more: others ? `另有 ${others} 项提醒` : '' };
  }
  const ok = by('ok').length;
  if (!ok) return { level: 'off', text: services.length ? `${off} 项服务未监测` : '尚未添加服务', more: '' };
  return { level: 'ok', text: `${ok} 项服务正常`, more: off ? `${off} 项未监测` : '' };
}
