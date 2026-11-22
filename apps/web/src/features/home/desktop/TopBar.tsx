import type { StatusSummary, UiSettings } from '@nexus/shared';
import { Moon, Settings, Sun } from 'lucide-react';
import { forwardRef, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { cn } from '../../../lib/cn';
import { reveal, type Near } from '../../../lib/proximity';
import { useResolvedTheme } from '../../../lib/theme';
import { patch } from '../../settings/model';
import { SpaceBadge } from '../../account/SpaceBadge';
import { dotStyle, pillStyle } from '../status-style';

interface Props {
  summary: StatusSummary;
  showStatus: boolean;
  statusOpen: boolean;
  breathe: boolean;
  /** 减少动态效果: the 异常 dot gets a static ring instead of breathing. */
  staticRing: boolean;
  ui: UiSettings['desktop'];
  near: Near;
  onToggleStatus(): void;
  onOpenDrawer(): void;
  onOpenOverview(): void;
}

/**
 * Logo, navigation (首页 · 我的收藏), the save status, service status for operators, the theme and
 * settings — each following 首页显示 (always / on hover / hidden). A failing service is shown whatever
 * the setting says. UI v2: nothing here names the account (spec 02 N1); 应用目录 is a source of
 * 添加收藏 now, not a destination of its own.
 */
export const TopBar = forwardRef<HTMLButtonElement, Props>(function TopBar({ summary, showStatus, statusOpen, breathe, staticRing, ui, near, onToggleStatus, onOpenOverview }, pillRef) {
  const navLink = 'text-ink/60 no-underline transition-colors duration-140 hover:text-ink';
  const left = reveal(ui.topbar, near.top);
  const alert = summary.level === 'error';
  const status = reveal(alert || statusOpen ? 'show' : ui.status, near.top);
  const settings = reveal(ui.settings, near.top);
  // v0.5: where changes go is never hidden for good — a hidden settings button still reveals it on hover.
  const where = reveal(ui.settings === 'hide' ? 'hover' : ui.settings, near.top);
  const nav = [ui.navHome, ui.navApps, ui.navOverview && showStatus].some(Boolean);
  return (
    <header className="absolute top-0 right-0 left-0 z-[4] flex items-center gap-9 px-9 py-6">
      {!left.hidden && (ui.brand || nav) && (
        <div className={cn('flex items-center gap-9', left.className)} style={left.style}>
          {ui.brand && (
            <div className="flex items-center gap-2.5 text-[16px] font-semibold tracking-[-0.01em]">
              <span aria-hidden className="flex h-5 -rotate-[14deg] items-center gap-[2.5px]">
                <i className="block h-4 w-1 rounded-[2px] bg-amber" />
                <i className="block h-5 w-1 rounded-[2px] bg-amber" />
                <i className="block h-3 w-1 rounded-[2px] bg-amber" />
              </span>
              Nexus
            </div>
          )}
          {nav && (
            <nav aria-label="主导航" className="flex gap-6 text-[13.5px]">
              {ui.navHome && (
                <a href="/" aria-current="page" className="text-ink no-underline">
                  首页
                </a>
              )}
              {ui.navApps && (
                <Link to="/settings/favorites" className={navLink}>
                  我的收藏
                </Link>
              )}
              {ui.navOverview && showStatus && (
                <a
                  href="#status"
                  className={navLink}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenOverview();
                  }}
                >
                  运行概览
                </a>
              )}
            </nav>
          )}
        </div>
      )}
      <span className="flex-1" />
      {showStatus && !status.hidden && (
        <button
          ref={pillRef}
          type="button"
          onClick={onToggleStatus}
          aria-expanded={statusOpen}
          aria-controls="nx-status"
          aria-label={`服务状态：${summary.text}${summary.more ? `，${summary.more}` : ''}`}
          className={cn('flex h-9 items-center gap-[9px] rounded-full border-0 pr-[15px] pl-[13px] text-[13px] backdrop-blur-[24px] transition-[background,transform,opacity] duration-200 active:scale-[.97]', status.className)}
          style={{ ...pillStyle(summary.level), ...status.style }}
        >
          <span
            className={cn('size-[7px] flex-none rounded-full', breathe && 'animate-breathe')}
            style={{ ...dotStyle(summary.level, 0.5), ...(staticRing ? { boxShadow: '0 0 0 2px rgb(var(--nx-error-rgb)/0.4)' } : {}) }}
          />
          <span>{summary.text}</span>
          {summary.more && <span className="opacity-66">{summary.more}</span>}
        </button>
      )}
      {!where.hidden && <SpaceBadge variant="desktop" className={where.className} style={where.style} />}
      {!settings.hidden && <ThemeButton className={settings.className} style={settings.style} />}
      {!settings.hidden && (
        <Link
          to="/settings"
          title="设置（,）"
          aria-label="设置"
          className={cn('grid size-9 place-items-center rounded-full text-ink/80 backdrop-blur-[24px] transition-colors duration-140', settings.className)}
          style={{ background: 'rgb(var(--nx-s1-rgb)/0.36)', ...settings.style }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgb(var(--nx-s5-rgb)/0.6)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgb(var(--nx-s1-rgb)/0.36)')}
        >
          <Settings className="size-4" />
        </Link>
      )}
    </header>
  );
});

/** 深色 / 浅色 at one click (the choice is the collection's 主题; 跟随系统 is set in 设置). */
function ThemeButton({ className, style }: { className?: string; style?: CSSProperties }) {
  const theme = useResolvedTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => patch('look', { theme: next })}
      aria-label={next === 'light' ? '切换到浅色' : '切换到深色'}
      title={next === 'light' ? '切换到浅色' : '切换到深色'}
      className={cn('grid size-9 place-items-center rounded-full border-0 text-ink/80 backdrop-blur-[24px] transition-colors duration-140 hover:text-ink', className)}
      style={{ background: 'rgb(var(--nx-s1-rgb)/0.36)', ...style }}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
