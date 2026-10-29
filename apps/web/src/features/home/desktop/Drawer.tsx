import { engineSearchUrl, hostOf, matchApps, type AppEntry } from '@nexus/shared';
import { Search, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { useConfig } from '../../../data/config-store';
import { useRecentStore } from '../../../data/recent';
import type { ServiceView } from '../../../data/status';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { appLinkProps, navigateTo, openApp, recordAppOpen } from '../../../lib/open';
import { usePinyin } from '../../../lib/pinyin';
import { dotStyle, messageColor } from '../status-style';
import type { MenuSource } from './Dock';

export interface DrawerHandle {
  focusFilter(): void;
}

interface Props {
  open: boolean;
  width: number;
  top: number;
  bottom: number;
  services: ServiceView[];
  showStatus: boolean;
  onClose(refocus: boolean): void;
  onMenu(e: MouseEvent<HTMLElement> | { currentTarget: HTMLElement; synthetic: true }, app: AppEntry, from: MenuSource): void;
  /** Absent in the read-only extension: no 编辑首页 button. */
  onEnterEdit?(): void;
}

export const Drawer = forwardRef<DrawerHandle, Props>(function Drawer({ open, width, top, bottom, services, showStatus, onClose, onMenu, onEnterEdit }, ref) {
  const config = useConfig();
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState(-1);
  const [gridNav, setGridNav] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [focused, setFocused] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({ focusFilter: () => filterRef.current?.focus() }), []);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => filterRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
    setFilter('');
    setSel(-1);
    setGridNav(false);
    setShowHidden(false);
  }, [open]);

  const inner = width - 68;
  const cols = Math.max(4, Math.min(8, Math.floor(inner / 120)));
  const hostedCols = inner < 600 ? 2 : 3;
  const pins = config.pins;
  const hiddenCount = config.apps.filter((a) => a.hidden).length;
  const pinyin = usePinyin((s) => s.fn);

  /** Flat order + 2-D rows of indices: hosted cards (3 per row) then each category grid. */
  const model = useMemo(() => {
    const matched = new Set(matchApps(config.apps, filter, showHidden, { pinyin }).map((a) => a.id));
    const flat: AppEntry[] = [];
    const rows: number[][] = [];
    const take = (list: AppEntry[], perRow: number) => {
      const start = flat.length;
      flat.push(...list);
      for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow).map((_, k) => start + i + k));
      return start;
    };
    const hosted = services.filter((s) => matched.has(s.app.id));
    const hostedStart = take(
      hosted.map((s) => s.app),
      hostedCols,
    );
    const cats = config.categories
      .filter((c) => c.id !== 'hosted')
      .map((c) => {
        const apps = config.apps.filter((a) => a.kind === 'site' && a.categoryId === c.id && matched.has(a.id));
        return { id: c.id, label: c.label, apps, start: take(apps, cols) };
      })
      .filter((c) => c.apps.length);
    // Sites filed under 我的服务 still need a home in the grid.
    const stray = config.apps.filter((a) => a.kind === 'site' && a.categoryId === 'hosted' && matched.has(a.id));
    if (stray.length) cats.push({ id: 'stray', label: '我的服务', apps: stray, start: take(stray, cols) });
    return { flat, rows, hosted, hostedStart, cats };
  }, [config.apps, config.categories, filter, showHidden, services, cols, hostedCols, pinyin]);

  const { flat, rows } = model;

  useEffect(() => {
    if (sel < 0) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-di="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const cellOf = (i: number): [number, number] => {
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r]!.indexOf(i);
      if (c >= 0) return [r, c];
    }
    return [0, 0];
  };

  const webEngine = config.engines.find((e) => e.id === config.settings.search.defaultEngine && e.kind === 'web') ?? config.engines.find((e) => e.kind === 'web');

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = flat.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (filter) {
        setFilter('');
        setSel(-1);
        setGridNav(false);
      } else onClose(true);
      return;
    }
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setGridNav(true);
      if (sel < 0) return setSel(0);
      const [r, c] = cellOf(sel);
      const t = Math.max(0, Math.min(rows.length - 1, r + (e.key === 'ArrowDown' ? 1 : -1)));
      setSel(rows[t]![Math.min(c, rows[t]!.length - 1)]!);
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (gridNav || !filter)) {
      e.preventDefault();
      setGridNav(true);
      setSel(Math.max(0, Math.min(n - 1, (sel < 0 ? -1 : sel) + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const app = flat[Math.max(sel, 0)];
      if (app) openApp(app, e.ctrlKey || e.metaKey);
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      if (sel < 0) return;
      e.preventDefault();
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-di="${sel}"]`);
      const app = flat[sel];
      if (el && app) onMenu({ currentTarget: el, synthetic: true }, app, app.kind === 'service' ? 'hosted' : 'drawer');
    }
  };

  const ring = (i: number) => (i === sel ? 'inset 0 0 0 2px rgba(230,192,138,0.75)' : 'none');
  const tab = open ? 0 : -1;
  const empty = !!filter.trim() && flat.length === 0;

  return (
    <div role="dialog" aria-modal="true" aria-label="全部应用" aria-hidden={!open} inert={!open} className="absolute inset-0 z-10 transition-opacity duration-280 ease-soft" style={{ opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }}>
      <div className="absolute inset-0" style={{ background: 'rgba(17,16,14,0.38)' }} onClick={() => onClose(true)} />
      <div
        className="absolute left-1/2 flex flex-col overflow-hidden rounded-[30px] backdrop-blur-[44px] backdrop-saturate-[1.15] transition-transform duration-420 ease-emph"
        style={{
          top,
          bottom,
          width,
          background: 'rgba(32,30,27,0.66)',
          boxShadow: '0 40px 100px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)',
          transform: `translateX(-50%) ${open ? 'none' : 'translateY(18px) scale(.985)'}`,
        }}
      >
        <div className="flex items-center gap-4 pt-[26px] pr-[30px] pb-5 pl-[34px]">
          <h2 className="m-0 text-[22px] font-medium tracking-[-0.01em]">全部应用</h2>
          <span className="text-[13px] text-ink/46">{config.apps.filter((a) => !a.hidden).length} 个</span>
          <span className="flex-1" />
          <div className="box-border flex h-10 w-[300px] items-center gap-2.5 rounded-xl pr-2 pl-3.5" style={{ background: 'rgba(239,234,225,0.07)', boxShadow: focused ? 'inset 0 0 0 1px rgba(230,192,138,0.4)' : 'none' }}>
            <Search className="size-[15px] flex-none text-ink/55" />
            <input
              ref={filterRef}
              tabIndex={tab}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setSel(e.target.value ? 0 : -1);
                setGridNav(false);
              }}
              onKeyDown={onFilterKey}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="筛选名称、域名或别名"
              aria-label="筛选应用"
              aria-controls="nx-drawer-grid"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink caret-amber outline-none"
            />
            <span className="flex-none text-[11.5px] text-ink/40">{filter ? `${flat.length} 项` : '/'}</span>
          </div>
          <button type="button" tabIndex={tab} onClick={() => onClose(true)} title="关闭（esc）" aria-label="关闭" className="grid size-10 place-items-center rounded-full border-0 bg-ink/7 text-ink/80 transition-colors duration-140 hover:bg-ink/14">
            <X className="size-4" />
          </button>
        </div>

        <div ref={scrollRef} id="nx-drawer-grid" className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-auto px-[34px] pt-1 pb-[30px]">
          {model.hosted.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="m-0 text-[12px] font-normal text-ink/50">我的服务</h3>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${hostedCols}, minmax(0,1fr))` }}>
                {model.hosted.map((s, k) => {
                  const di = model.hostedStart + k;
                  return (
                    <a
                      key={s.app.id}
                      {...appLinkProps(s.app)}
                      data-di={di}
                      tabIndex={tab}
                      onClick={() => recordAppOpen(s.app)}
                      onContextMenu={(e) => onMenu(e, s.app, 'hosted')}
                      className={cn('flex items-center gap-3.5 rounded-[20px] p-3.5 text-ink no-underline transition-colors duration-140 hover:bg-ink/8', s.app.hidden && 'opacity-42')}
                      style={{ background: di === sel ? 'rgba(239,234,225,0.09)' : 'rgba(239,234,225,0.045)', boxShadow: ring(di) }}
                    >
                      <AppTile target={{ kind: 'app', app: s.app }} size={52} lazy />
                      <span className="flex min-w-0 flex-col gap-[3px]">
                        <span className="flex items-baseline gap-2">
                          <span className="text-[15px] font-medium">{s.app.name}</span>
                          <span className="truncate text-[12px] text-ink/42">{s.app.description}</span>
                        </span>
                        {showStatus && (
                          <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: messageColor(s.level) }}>
                            <span className="size-1.5 flex-none rounded-full" style={dotStyle(s.level)} />
                            <span className="truncate">{s.message}</span>
                          </span>
                        )}
                      </span>
                    </a>
                  );
                })}
              </div>
            </section>
          )}
          {model.cats.map((c) => (
            <section key={c.id} className="flex flex-col gap-3.5">
              <h3 className="m-0 text-[12px] font-normal text-ink/50">{c.label}</h3>
              <div className="grid gap-y-3.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
                {c.apps.map((a, k) => {
                  const di = c.start + k;
                  const pinned = pins.includes(a.id);
                  return (
                    <a
                      key={a.id}
                      {...appLinkProps(a)}
                      data-di={di}
                      title={`${a.name} · ${hostOf(a.url)}`}
                      tabIndex={tab}
                      aria-label={`${a.name}${pinned ? '，已固定' : ''}${a.hidden ? '，已隐藏' : ''}`}
                      onClick={() => recordAppOpen(a)}
                      onContextMenu={(e) => onMenu(e, a, 'drawer')}
                      className={cn('flex flex-col items-center gap-[9px] rounded-[18px] pt-2 pb-1.5 text-ink no-underline transition-[transform,background] duration-140 ease-soft hover:-translate-y-[3px] active:-translate-y-px active:scale-[.96]', a.hidden && 'opacity-42')}
                      style={{ background: di === sel ? 'rgba(239,234,225,0.08)' : 'transparent', boxShadow: ring(di) }}
                    >
                      <AppTile target={{ kind: 'app', app: a }} size={60} lazy />
                      <span className="max-w-full truncate px-1 text-[12.5px] text-ink/82">{a.name}</span>
                      <span className="-mt-1 size-1 rounded-full" style={{ background: pinned ? '#e6c08a' : 'transparent' }} />
                    </a>
                  );
                })}
              </div>
            </section>
          ))}
          {empty && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2.5 py-10 text-center">
              <span className="grid size-[52px] place-items-center rounded-2xl bg-ink/6">
                <Search className="size-[22px] text-ink/50" />
              </span>
              <span className="mt-1.5 text-[17px] font-medium">没有匹配「{filter}」的应用</span>
              <span className="text-[13px] text-ink/50">可按名称、拼音或首字母、域名、别名筛选；隐藏的应用不参与匹配</span>
              <div className="mt-3 flex gap-2.5">
                {webEngine && (
                  <button
                    type="button"
                    tabIndex={tab}
                    onClick={() => {
                      const href = engineSearchUrl(webEngine, filter);
                      if (!href) return;
                      useRecentStore.getState().record({ kind: 'search', title: filter, query: filter, engineId: webEngine.id });
                      navigateTo(href, false);
                    }}
                    className="h-10 rounded-xl border-0 bg-ink/10 px-4 text-[13.5px] text-ink hover:bg-ink/16"
                  >
                    在 {webEngine.name} 中搜索「{filter}」
                  </button>
                )}
                <Link to={`/settings/apps?new=${encodeURIComponent(filter)}`} tabIndex={tab} className="flex h-10 items-center gap-2 rounded-xl px-4 text-[13.5px] text-amber-hi no-underline" style={{ background: 'rgba(230,192,138,0.14)' }}>
                  添加为新应用 →
                </Link>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-5 border-t border-ink/6 py-3 pr-6 pl-[34px] text-[12px] text-ink/46">
          <span className="flex items-center gap-[7px]">
            <span className="size-1 rounded-full bg-amber" />
            已固定在首页 {pins.length}
          </span>
          <span>方向键选择 · ↵ 打开 · 右键或 Shift+F10 管理</span>
          <span className="flex-1" />
          {hiddenCount > 0 && (
            <button type="button" tabIndex={tab} onClick={() => setShowHidden((v) => !v)} className="h-8 rounded-[9px] border-0 bg-transparent px-3 text-[12.5px] text-ink/66 hover:bg-ink/8">
              {showHidden ? '收起已隐藏' : `已隐藏 ${hiddenCount} 个 · 显示`}
            </button>
          )}
          {onEnterEdit && (
            <button type="button" tabIndex={tab} onClick={onEnterEdit} className="h-8 rounded-[9px] border-0 bg-ink/8 px-3 text-[12.5px] text-ink hover:bg-ink/14">
              编辑首页
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
