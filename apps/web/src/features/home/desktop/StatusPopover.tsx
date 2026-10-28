import { Link } from 'react-router';
import type { ServiceView } from '../../../data/status';
import { AppTile } from '../../../icons/AppTile';
import { appLinkProps, recordAppOpen } from '../../../lib/open';
import { actionStyle, dotStyle, messageColor, rowHighlighted } from '../status-style';

interface Props {
  open: boolean;
  services: ServiceView[];
}

function footerText(services: ServiceView[]): string {
  const monitored = services.filter((s) => s.app.health.enabled);
  if (!monitored.length) return '尚未为任何服务开启健康检查';
  const every = Math.min(...monitored.map((s) => s.app.health.intervalSec));
  const last = monitored.map((s) => s.checkedAt).filter(Boolean).sort().at(-1);
  const when = last ? new Date(last).toLocaleTimeString('zh-CN', { hour: 'numeric', minute: '2-digit' }) : '尚未完成';
  return `每 ${every >= 60 ? `${every / 60} 分钟` : `${every} 秒`}检查 · 上次 ${when}`;
}

/** One row per service; 异常 / 警告 rows get a light fill and a direct action (R1 Spec · 状态层级). */
export function StatusPopover({ open, services }: Props) {
  return (
    <div
      id="nx-status"
      aria-hidden={!open}
      inert={!open}
      className="absolute top-[70px] right-[84px] z-[6] w-[368px] origin-top-right rounded-[20px] p-2 backdrop-blur-[30px] transition-[opacity,transform] duration-200 ease-soft"
      style={{
        background: 'rgba(30,28,25,0.8)',
        boxShadow: '0 24px 60px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)',
        opacity: open ? 1 : 0,
        transform: open ? 'none' : 'translateY(-4px) scale(.98)',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {services.length === 0 && <div className="px-2.5 py-3 text-[13px] text-ink/50">还没有自托管服务。在设置中新增后会显示在这里。</div>}
      {services.map((s) => (
        <div key={s.app.id} className="flex items-center gap-3 rounded-[13px] p-2.5" style={{ background: rowHighlighted(s.level) ? 'rgba(239,234,225,0.04)' : 'transparent' }}>
          <AppTile target={{ kind: 'app', app: s.app }} size={36} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium">{s.app.name}</span>
              <span className="text-[11.5px] text-ink/44">{s.levelLabel}</span>
            </span>
            <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: messageColor(s.level) }}>
              <span className="size-1.5 flex-none rounded-full" style={dotStyle(s.level)} />
              <span className="truncate">{s.message}</span>
            </span>
          </span>
          {s.level === 'off' ? (
            <Link to={`/settings/apps?edit=${s.app.id}`} className="flex h-[30px] flex-none items-center rounded-[9px] px-3 text-[12.5px] no-underline transition-colors duration-140 hover:!bg-ink/14" style={actionStyle(s.level)}>
              开启
            </Link>
          ) : (
            <a {...appLinkProps(s.app)} onClick={() => recordAppOpen(s.app)} className="flex h-[30px] flex-none items-center rounded-[9px] px-3 text-[12.5px] no-underline transition-colors duration-140 hover:!bg-ink/14" style={actionStyle(s.level)}>
              打开
            </a>
          )}
        </div>
      ))}
      <div className="mt-1 flex justify-between border-t border-ink/8 px-2.5 pt-[11px] pb-[5px] text-[12px] text-ink/50">
        <span>{footerText(services)}</span>
        <Link to="/settings/apps" className="text-ink/72 no-underline hover:text-ink">
          在设置中管理 →
        </Link>
      </div>
    </div>
  );
}
