import type { StatusSummary } from '@nexus/shared';
import { Settings } from 'lucide-react';
import { forwardRef } from 'react';
import { Link } from 'react-router';
import { cn } from '../../../lib/cn';
import { dotStyle, pillStyle } from '../status-style';

interface Props {
  summary: StatusSummary;
  showStatus: boolean;
  statusOpen: boolean;
  breathe: boolean;
  /** 减少动态效果: the 异常 dot gets a static ring instead of breathing. */
  staticRing: boolean;
  onToggleStatus(): void;
  onOpenDrawer(): void;
  onOpenOverview(): void;
}

export const TopBar = forwardRef<HTMLButtonElement, Props>(function TopBar({ summary, showStatus, statusOpen, breathe, staticRing, onToggleStatus, onOpenDrawer, onOpenOverview }, pillRef) {
  const navLink = 'text-ink/60 no-underline transition-colors duration-140 hover:text-ink';
  return (
    <header className="absolute top-0 right-0 left-0 z-[4] flex items-center gap-9 px-9 py-6">
      <div className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[0.01em]">
        <span className="size-2 rounded-full bg-amber" style={{ boxShadow: '0 0 14px rgba(230,192,138,0.75)' }} />
        Nexus
      </div>
      <nav aria-label="主导航" className="flex gap-6 text-[13.5px]">
        <a href="/" aria-current="page" className="text-ink no-underline">
          首页
        </a>
        <a
          href="#apps"
          className={navLink}
          onClick={(e) => {
            e.preventDefault();
            onOpenDrawer();
          }}
        >
          应用
        </a>
        {showStatus && (
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
      <span className="flex-1" />
      {showStatus && (
        <button
          ref={pillRef}
          type="button"
          onClick={onToggleStatus}
          aria-expanded={statusOpen}
          aria-controls="nx-status"
          aria-label={`服务状态：${summary.text}${summary.more ? `，${summary.more}` : ''}`}
          className="flex h-9 items-center gap-[9px] rounded-full border-0 pr-[15px] pl-[13px] text-[13px] backdrop-blur-[24px] transition-[background,transform] duration-200 active:scale-[.97]"
          style={pillStyle(summary.level)}
        >
          <span
            className={cn('size-[7px] flex-none rounded-full', breathe && 'animate-breathe')}
            style={{ ...dotStyle(summary.level, 0.5), ...(staticRing ? { boxShadow: '0 0 0 2px rgba(233,118,95,0.4)' } : {}) }}
          />
          <span>{summary.text}</span>
          {summary.more && <span className="opacity-66">{summary.more}</span>}
        </button>
      )}
      <Link
        to="/settings"
        title="设置"
        aria-label="设置"
        className="grid size-9 place-items-center rounded-full text-ink/80 backdrop-blur-[24px] transition-colors duration-140"
        style={{ background: 'rgba(26,25,22,0.36)' }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(46,43,38,0.6)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(26,25,22,0.36)')}
      >
        <Settings className="size-4" />
      </Link>
    </header>
  );
});
