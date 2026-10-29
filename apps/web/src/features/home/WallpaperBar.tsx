import type { UiSettings, WallpaperCredit } from '@nexus/shared';
import { Ban, ChevronLeft, ChevronRight, Heart, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useConfig } from '../../data/config-store';
import { cn } from '../../lib/cn';
import { reveal } from '../../lib/proximity';
import { homeActions } from './actions';
import type { CurrentWallpaper } from './rotation';

const ext = { target: '_blank', rel: 'noopener noreferrer' } as const;
const linkClass = 'text-inherit underline decoration-ink/25 underline-offset-2 hover:text-ink hover:decoration-ink/60';

/** Attribution as each source asks for it (Unsplash's wording, CC author · license · source). */
export function CreditText({ info, fallback }: { info: WallpaperCredit | null | undefined; fallback?: string }): ReactNode {
  if (!info) return fallback ?? null;
  if (info.provider === 'Unsplash') {
    return (
      <>
        Photo by{' '}
        <a href={info.authorUrl} {...ext} className={linkClass}>
          {info.author}
        </a>{' '}
        on{' '}
        <a href={info.sourceUrl} {...ext} className={linkClass}>
          Unsplash
        </a>
      </>
    );
  }
  const parts: ReactNode[] = [];
  if (info.author) parts.push(<span key="a">{info.author}</span>);
  if (info.license)
    parts.push(
      info.licenseUrl ? (
        <a key="l" href={info.licenseUrl} {...ext} className={linkClass}>
          {info.license}
        </a>
      ) : (
        <span key="l">{info.license}</span>
      ),
    );
  if (info.sourceUrl)
    parts.push(
      <a key="s" href={info.sourceUrl} {...ext} className={linkClass}>
        {info.provider ?? '来源'}
      </a>,
    );
  return parts.flatMap((p, i) => (i ? [<span key={`d${i}`}> · </span>, p] : [p]));
}

const iconBtn = 'grid size-7 place-items-center rounded-full border-0 bg-transparent p-0 text-ink/62 transition-colors duration-140 hover:bg-ink/10 hover:text-ink';

/**
 * Bottom-left: wallpaper name, attribution and quick actions (上一张 / 换一张 / 收藏 / 不喜欢 /
 * 锁定). Credits that a license requires stay visible whatever 首页显示 says.
 */
export function WallpaperBar({ current, ui, near, hidden }: { current: CurrentWallpaper; ui: UiSettings['desktop']; near: boolean; hidden: boolean }) {
  const look = useConfig().settings.look;
  const { entry, rotating } = current;
  const info = entry.info;
  const credit = reveal(info?.required ? 'show' : ui.wallpaperCredit, near);
  const actions = reveal(ui.wallpaperActions, near);
  const fav = look.favorites.includes(entry.id);
  const hasCredit = !!info || !!entry.credit;
  // A name shown only on hover takes no room until then, so a required credit sits flush left.
  const nameShown = ui.wallpaperName === 'show' || near;
  return (
    <div className="group/wbar absolute bottom-[22px] left-9 z-[2] flex h-8 items-center gap-2 text-[12px] text-ink/50 transition-opacity duration-200" style={{ opacity: hidden ? 0 : 1 }} inert={hidden}>
      {ui.wallpaperName !== 'hide' && <span className={cn(!nameShown && 'hidden group-focus-within/wbar:inline group-hover/wbar:inline')}>{entry.name}</span>}
      {!credit.hidden && hasCredit && (
        <span className={cn('max-w-[420px] truncate', credit.className)} style={credit.style}>
          {ui.wallpaperName !== 'hide' && <span className={cn(!nameShown && 'hidden group-focus-within/wbar:inline group-hover/wbar:inline')}>· </span>}
          <CreditText info={info} fallback={entry.credit} />
        </span>
      )}
      {!actions.hidden && (
        <span role="group" aria-label="壁纸操作" className={cn('flex items-center gap-0.5', actions.className)} style={actions.style}>
          <span>·</span>
          <button type="button" onClick={current.next} className="h-7 rounded-full border-0 bg-transparent px-1.5 text-[12px] text-ink/70 hover:text-ink">
            换一张
          </button>
          {/* The rest stays out of the way until the pointer (or focus) is on the bar. */}
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-focus-within/wbar:opacity-100 group-hover/wbar:opacity-100">
            <button type="button" aria-label="上一张壁纸" title="上一张" onClick={current.prev} className={iconBtn}>
              <ChevronLeft className="size-3.5" />
            </button>
            <button type="button" aria-label="下一张壁纸" title="下一张" onClick={current.next} className={iconBtn}>
              <ChevronRight className="size-3.5" />
            </button>
            <button type="button" aria-label={fav ? '取消收藏当前壁纸' : '收藏当前壁纸'} aria-pressed={fav} title={fav ? '取消收藏' : '收藏'} onClick={() => homeActions.toggleFavorite(entry)} className={iconBtn}>
              <Heart className="size-3.5" fill={fav ? 'currentColor' : 'none'} style={fav ? { color: '#e6c08a' } : undefined} />
            </button>
            <button type="button" aria-label="不喜欢这张" title="不喜欢这张（不再出现）" onClick={() => homeActions.dislike(entry, current.next)} className={iconBtn}>
              <Ban className="size-3.5" />
            </button>
            {rotating && (
              <button type="button" aria-label="锁定当前壁纸" title="锁定当前壁纸（停止自动切换）" onClick={() => homeActions.lock(entry)} className={iconBtn}>
                <Lock className="size-3.5" />
              </button>
            )}
          </span>
        </span>
      )}
    </div>
  );
}
