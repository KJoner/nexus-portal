import { CloudOff, HardDrive, LogIn, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { useConfigStore, useSaveState } from '../../data/config-store';
import { storedQueueLength, useLibrary } from '../../data/library';
import { cn } from '../../lib/cn';
import { host } from '../../lib/host';

/**
 * 状态胶囊 (UI v2 · spec 02 N1, 07 §6): only where changes stand — never who is signed in. No user
 * name, nickname or e-mail in the text, the title or the aria-label (projected screens, shared
 * screenshots); the account itself is shown in 设置 › 账号与同步. And never a state it cannot vouch
 * for: 已同步 only when the account's server has confirmed every change (settings and 我的收藏).
 *
 *   仅此设备   a local collection, and the browser stored the last change
 *   未保存     the browser (or the server) did not store a change — the one loud case
 *   已同步     account, online, nothing waiting, nothing to decide
 *   同步中     changes on their way
 *   待同步     changes waiting (offline queue of 我的收藏, or kept conflicts to decide)
 *   离线       no connection, nothing waiting
 *   重新登录   the account's sign-in ended (its collection stays hidden)
 */
export type PillState = { label: string; tone: 'ok' | 'quiet' | 'warn' | 'error'; icon: LucideIcon | null; to: string; why: string };

export function usePillState(): PillState {
  const space = useConfigStore((s) => s.space);
  const auth = useConfigStore((s) => s.auth);
  const save = useSaveState();
  const queued = Math.max(useLibrary((s) => s.queued), storedQueueLength());
  const conflicts = useLibrary((s) => s.conflicts.length);
  if (save.kind === 'error') return { label: '未保存', tone: 'error', icon: TriangleAlert, to: '/settings/data', why: `更改没有保存：${save.message}` };
  if (space === 'local') return { label: '仅此设备', tone: 'quiet', icon: HardDrive, to: '/settings/account', why: `收藏只保存在${host.localWhere}，登录后可以同步` };
  if (auth === 'anonymous') return { label: '重新登录', tone: 'warn', icon: LogIn, to: '/account/connect', why: '登录已过期，重新登录后继续同步' };
  const waiting = save.kind === 'offline' || save.kind === 'saving' ? save.pending + queued : queued;
  if (save.kind === 'offline') return waiting ? { label: '待同步', tone: 'warn', icon: CloudOff, to: '/settings/account', why: `离线，${waiting} 项更改联网后同步` } : { label: '离线', tone: 'warn', icon: CloudOff, to: '/settings/account', why: '离线：显示的是上次同步的内容' };
  if (conflicts) return { label: '待同步', tone: 'warn', icon: TriangleAlert, to: '/settings/favorites', why: `${conflicts} 项离线时的更改需要你在我的收藏里决定` };
  if (save.kind === 'saving' || queued) return { label: '同步中', tone: 'quiet', icon: RefreshCw, to: '/settings/account', why: `正在同步 ${waiting || ''} 项更改`.replace('  ', ' ') };
  return { label: '已同步', tone: 'ok', icon: null, to: '/settings/account', why: '所有更改都已同步到账号' };
}

export function SpaceBadge({ variant, className, style }: { variant: 'desktop' | 'mobile'; className?: string; style?: CSSProperties }) {
  const s = usePillState();
  const color = s.tone === 'error' ? 'text-danger-ink' : s.tone === 'warn' ? 'text-warn' : 'text-ink/84';
  return (
    <Link
      to={s.to}
      title={s.why}
      aria-label={`保存状态：${s.label}。${s.why}`}
      className={cn('flex items-center gap-2 rounded-full no-underline backdrop-blur-[24px]', variant === 'desktop' ? 'h-9 px-3.5 text-[12.5px]' : 'h-9 px-3 text-[12px]', color, className)}
      style={{ background: 'rgb(var(--nx-s1-rgb)/0.42)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.08)', ...style }}
    >
      {s.icon ? <s.icon className="size-3.5 flex-none" aria-hidden /> : <span aria-hidden className="size-[7px] flex-none rounded-full bg-ok" />}
      <span>{s.label}</span>
    </Link>
  );
}
