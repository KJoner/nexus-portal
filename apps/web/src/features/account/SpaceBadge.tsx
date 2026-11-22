import { CloudOff, HardDrive, RefreshCw, TriangleAlert, UserRound } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router';
import { useAccount, useConfigStore, useSaveState } from '../../data/config-store';
import { accountLabel } from '../../data/identity';
import { cn } from '../../lib/cn';
import { host } from '../../lib/host';

/**
 * 保存位置 (v0.5 · U1, 03-DESIGN-SPEC §4): always says where changes go — 「仅保存在此浏览器」 with
 * 登录同步 next to it for a local collection, the account and its sync state otherwise. Quiet, not a
 * banner: a local collection is a normal way to use Nexus, not an error. A storage failure is the
 * one loud case (nothing is being saved).
 */
export function SpaceBadge({ variant, className, style }: { variant: 'desktop' | 'mobile'; className?: string; style?: CSSProperties }) {
  const space = useConfigStore((s) => s.space);
  const save = useSaveState();
  const me = useAccount();
  const { pathname } = useLocation();
  const glass: CSSProperties = { background: 'rgba(26,25,22,0.42)', ...style };
  const pill = cn('flex items-center gap-2 rounded-full text-ink/85 no-underline backdrop-blur-[24px]', variant === 'desktop' ? 'h-9 px-3.5 text-[12.5px]' : 'h-9 px-3 text-[12px]', className);

  if (save.kind === 'error')
    return (
      <Link to="/settings/data" className={cn(pill, 'text-danger-ink')} style={glass} title={save.message} aria-label={`没有保存：${save.message}`}>
        <TriangleAlert className="size-3.5 flex-none" />
        没有保存 · 查看
      </Link>
    );

  if (space === 'local') {
    const connect = host.connectAccount;
    const label = `仅保存在${host.localWhere}`;
    return (
      <span className={pill} style={glass}>
        <HardDrive className="size-3.5 flex-none text-ink/60" aria-hidden />
        {/* Phones: the short form, never only an icon — where changes go stays readable. */}
        <span aria-hidden={variant === 'mobile'}>{variant === 'mobile' ? `仅${host.localWhere}` : label}</span>
        {variant === 'mobile' && <span className="sr-only">{label}</span>}
        <span aria-hidden className="h-3 w-px bg-ink/20" />
        {connect ? (
          <button type="button" onClick={connect} className="border-0 bg-transparent p-0 text-[inherit] font-medium text-amber">
            连接账号
          </button>
        ) : (
          <Link to={`/account/connect?from=${encodeURIComponent(pathname)}`} className="font-medium text-amber no-underline" aria-label={`${label}。登录同步`}>
            登录同步
          </Link>
        )}
      </span>
    );
  }

  const name = accountLabel(me) || '账号';
  const short = name.length > 18 ? `${name.slice(0, 16)}…` : name;
  const state = save.kind === 'offline' ? `离线${save.pending ? ` · ${save.pending} 项待同步` : ''}` : save.kind === 'saving' ? '正在同步…' : '已同步';
  const Icon = save.kind === 'offline' ? CloudOff : save.kind === 'saving' ? RefreshCw : UserRound;
  return (
    <Link to="/settings/account" className={pill} style={glass} aria-label={`账号 ${name}，${state}。账号与同步`}>
      <Icon className={cn('size-3.5 flex-none', save.kind === 'offline' ? 'text-warn' : 'text-ink/60')} aria-hidden />
      <span className={variant === 'mobile' ? 'max-w-[8em] truncate' : 'max-w-[14em] truncate'}>{short}</span>
      <span aria-hidden className="h-3 w-px bg-ink/20" />
      <span className={save.kind === 'offline' ? 'text-warn' : 'text-ink/62'}>{state}</span>
    </Link>
  );
}
