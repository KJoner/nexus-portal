import { appHref, desktopShortcuts, hostOf, MAX_PINS, pinnedSites, uiPreset, type AppEntry, type StatusLevel } from '@nexus/shared';
import { Activity, ArrowRight, ArrowUpRight, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, ExternalLink, Eye, EyeOff, GripVertical, Image, LayoutTemplate, Pencil, Pin, PinOff, Settings, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ContextMenu, menuPoint, type MenuItem, type MenuState } from '../../../components/ContextMenu';
import { ToastHost } from '../../../components/ToastHost';
import { toast } from '../../../components/toast-store';
import { dispatch, flush, useConfig, useConfigStore, useIsAdmin } from '../../../data/config-store';
import { useServices } from '../../../data/status';
import { useMotionLevel, useNow, useViewport } from '../../../lib/hooks';
import { host } from '../../../lib/host';
import { openApp } from '../../../lib/open';
import { useProximity } from '../../../lib/proximity';
import { storage } from '../../../lib/storage';
import { formatClock, formatDate } from '../../../lib/time';
import { openAddFavorite, openEditFavorite } from '../../favorites/dialog-store';
import { LazyFavoriteDialogs } from '../../favorites/lazy-dialogs';
import { homeActions } from '../actions';
import { useStarterHint } from '../starter-hint';
import type { QuickActionId } from '../search-model';
import { useCurrentWallpaper } from '../rotation';
import { Wallpaper } from '../Wallpaper';
import { WallpaperBar } from '../WallpaperBar';
import { Dock, DockHandle, dockHeights, useDockPeek, type MenuSource } from './Dock';
import { Drawer } from './Drawer';
import { extensionCols, ICON, slabWidthFor } from './geometry';
import { SearchSlab, type SearchSlabHandle } from './SearchSlab';
import { StatusPopover } from './StatusPopover';
import { TopBar } from './TopBar';

/** UI v2 (spec 02 N1, prototype nexus.html#home): the shortcuts' heading row inside the slab. */
const FRAME_HEAD = 34;
/** Per-browser memory of the extension being open (设置 · 记住展开状态). */
const EXPANDED_KEY = 'nexus.home.expanded';

type MenuEvent = MouseEvent<HTMLElement> | { currentTarget: HTMLElement; synthetic: true };

export function DesktopHome() {
  const config = useConfig();
  const { look, home, privacy } = config.settings;
  const { w, h } = useViewport();
  const motion = useMotionLevel();
  const now = useNow(look.showSeconds);
  const navigate = useNavigate();
  const { services, all, summary } = useServices();
  const current = useCurrentWallpaper();
  const ui = config.settings.ui.desktop;
  // The Chrome extension's new tab: same home, nothing that writes to the server.
  const ro = host.readOnly;
  const near = useProximity([ui.topbar, ui.status, ui.settings, ui.wallpaperName, ui.wallpaperCredit, ui.wallpaperActions].includes('hover'));

  const [drawer, setDrawer] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [errorSeen, setErrorSeen] = useState(false);
  const [expandedPref, setExpandedPref] = useState(() => home.shortcuts.remember && storage.get<boolean>(EXPANDED_KEY) === true);
  const slabRef = useRef<SearchSlabHandle>(null);
  const allRef = useRef<HTMLButtonElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  // Service status is the operator's view of the servers; other accounts have none (v0.4).
  const isAdmin = useIsAdmin();
  const showStatus = !privacy.guest && isAdmin;
  // 布局微调: vertical offset and slab width, kept inside the window.
  const top = Math.max(72, (h >= 900 ? 228 : Math.round(h * 0.24)) + Math.round((h * ui.offsetY) / 100));
  const slabW = slabWidthFor(ui.searchWidth, w);
  const clockH = ui.clock === 'show' ? Math.round(60 * ui.clockScale) + 20 : look.showDate ? 40 : 0;
  const iconSize = ICON[look.iconSize];
  const labels = home.labels.desktop;
  const showShortcuts = ui.shortcuts === 'show';
  // 常用网站 · 整理 above the shortcuts; edit mode has its own bar. Not in a very short window (600),
  // where the slab would no longer fit with the extension open. No buttons under the slab any more:
  // 我的收藏 is in the top bar and behind 整理, 添加收藏 in 快速打开 and in 我的收藏.
  const framed = showShortcuts && !edit && h >= 680;
  const frameH = framed ? FRAME_HEAD : 0;
  const pinned = useMemo(() => pinnedSites(config), [config]);
  // The first row fills the row (every column but 快速打开); only the rest goes to the extension.
  const cols = extensionCols(iconSize, slabW);
  const firstCap = cols - 1;
  const { first: dockSites, extra } = useMemo(() => desktopShortcuts(config, firstCap), [config, firstCap]);
  const { shortcuts } = home;
  // UI v2: no separate services strip — a pinned service sits among the pins with its status badge.
  const statusById = useMemo(() => new Map<string, StatusLevel>(services.map((s) => [s.app.id, s.level])), [services]);
  const starter = useStarterHint(config);

  useEffect(() => {
    if (summary.level !== 'error') setErrorSeen(false);
  }, [summary.level]);

  const closeDrawer = (refocus: boolean) => {
    setDrawer(false);
    setMenu(null);
    if (refocus) requestAnimationFrame(() => allRef.current?.focus());
  };
  const openDrawer = () => {
    setDrawer(true);
    setStatusOpen(false);
    setEdit(false);
  };
  const enterEdit = () => {
    setEdit(true);
    setDrawer(false);
    setMenu(null);
    setStatusOpen(false);
  };
  /** Confirms only what the server actually stored; offline edits are reported as queued. */
  const exitEdit = async () => {
    setEdit(false);
    await flush();
    const s = useConfigStore.getState();
    toast(!s.online ? { msg: '已离线保存，恢复连接后自动同步', tone: 'warn' } : s.pending.length ? { msg: '正在保存首页布局…', tone: 'info' } : { msg: '首页布局已保存', tone: 'ok' });
  };
  const openStatus = () => {
    setStatusOpen(true);
    setErrorSeen(true);
    setDrawer(false);
  };

  // Global keys: `/` or Ctrl/⌘+K focus search; `,` opens settings; Esc closes the top-most layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]');
      // Always reachable, even with every control hidden (首页显示).
      if (e.key === ',' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        navigate('/settings');
        return;
      }
      if (((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) && !drawer && !menu) {
        e.preventDefault();
        slabRef.current?.focus();
        return;
      }
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null);
      else if (drawer) closeDrawer(true);
      else if (statusOpen) {
        setStatusOpen(false);
        pillRef.current?.focus();
      } else if (edit) void exitEdit();
      else if (canToggle && expanded) collapse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Click outside the status popover closes it.
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('#nx-status') && !pillRef.current?.contains(t)) setStatusOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [statusOpen]);

  const onAction = (id: QuickActionId) => {
    if (id === 'status') openStatus();
    else if (id === 'wallpaper') changeWallpaper();
    else navigate('/settings');
  };

  /** Read-only with a fixed wallpaper: the picture is chosen in the portal's settings. */
  const changeWallpaper = () => (current.canStep ? current.next() : navigate('/settings/appearance'));

  /** Right-click on the empty wallpaper: a way back to settings when controls are hidden. */
  const onBackgroundMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('a, button, input, [role="dialog"], [role="menu"], main')) return;
    e.preventDefault();
    const minimal = config.settings.ui.preset === 'minimal';
    setMenu({
      ...menuPoint(e),
      origin: null,
      header: { target: { kind: 'system', icon: Settings }, name: 'Nexus', sub: '首页' },
      items: [
        { label: '打开设置', icon: Settings, hint: ',', onSelect: () => navigate('/settings') },
        { label: '换一张壁纸', icon: Image, hint: current.canStep ? undefined : '↗', onSelect: changeWallpaper },
        ...(ro ? [] : [{ label: '编辑首页…', icon: GripVertical, onSelect: enterEdit }]),
        'sep',
        ...(ro ? [] : [{ label: minimal ? '切换到日常模式' : '切换到极简模式', icon: LayoutTemplate, onSelect: () => dispatch({ type: 'settings.patch', section: 'ui', patch: uiPreset(minimal ? 'daily' : 'minimal', config.settings.ui) }) }]),
        { label: '显示与布局…', icon: SlidersHorizontal, hint: '↗', onSelect: () => navigate('/settings/display') },
      ],
    });
  };

  const openMenu = (e: MenuEvent, app: AppEntry, from: MenuSource) => {
    let pt: { x: number; y: number; keyboard: boolean };
    if ('synthetic' in e) {
      const r = e.currentTarget.getBoundingClientRect();
      pt = { x: r.left + 12, y: r.bottom + 4, keyboard: true };
    } else {
      e.preventDefault();
      pt = menuPoint(e);
    }
    const pins = useConfigStore.getState().snapshot.config.pins;
    const i = pins.indexOf(app.id);
    // UI v2: one editor for every favorite (site or service), opened right here; read-only views hand over.
    const toSettings: MenuItem = ro ? { label: '在我的收藏中编辑', icon: Pencil, hint: '↗', onSelect: () => navigate(`/settings/favorites?edit=${encodeURIComponent(app.id)}`) } : { label: '编辑收藏', icon: Pencil, onSelect: () => openEditFavorite(app.id) };
    const open: MenuItem[] = [
      { label: '打开', icon: ArrowUpRight, onSelect: () => openApp(app) },
      { label: '在新标签页打开', icon: ExternalLink, hint: '中键', onSelect: () => openApp(app, true) },
    ];
    let items: MenuItem[];
    if (ro) {
      items = [...open, ...(from === 'hosted' && showStatus ? [{ label: '查看状态', icon: Activity, onSelect: openStatus }] : []), 'sep', toSettings];
    } else if (from === 'hosted') {
      items = [...open, ...(showStatus ? [{ label: '查看状态', icon: Activity, onSelect: openStatus }] : []), 'sep', toSettings];
    } else if (from === 'dock') {
      const last = (shortcuts.mode === 'single' ? Math.min(pins.length, firstCap) : pins.length) - 1;
      items = [
        ...open,
        'sep',
        { label: '向前移动', icon: ChevronLeft, disabled: i <= 0, onSelect: () => homeActions.move(app.id, -1) },
        { label: '向后移动', icon: ChevronRight, disabled: i >= last, onSelect: () => homeActions.move(app.id, 1) },
        { label: '移到最前', icon: ChevronFirst, disabled: i <= 0, onSelect: () => homeActions.moveTo(app.id, 0) },
        { label: '移到最后', icon: ChevronLast, disabled: i >= pins.length - 1, onSelect: () => homeActions.moveTo(app.id, pins.length - 1) },
        { label: '从首页移除', icon: PinOff, onSelect: () => homeActions.unpin(app.id) },
        { label: '隐藏此应用', icon: EyeOff, onSelect: () => homeActions.hide(app.id) },
        'sep',
        { label: '编辑首页…', icon: GripVertical, onSelect: enterEdit },
        toSettings,
      ];
    } else {
      const usage = `${pins.length} / ${MAX_PINS}`;
      items = [
        ...open,
        'sep',
        i >= 0
          ? { label: '从首页移除', icon: PinOff, hint: usage, onSelect: () => homeActions.unpin(app.id) }
          : { label: '固定到首页', icon: Pin, hint: usage, disabled: app.hidden, onSelect: () => homeActions.pin(app.id, enterEdit) },
        app.hidden ? { label: '取消隐藏', icon: Eye, onSelect: () => homeActions.unhide(app.id) } : { label: '隐藏此应用', icon: EyeOff, onSelect: () => homeActions.hide(app.id) },
        'sep',
        toSettings,
      ];
    }
    setMenu({
      ...pt,
      origin: e.currentTarget,
      header: { target: { kind: 'app', app }, name: app.name, sub: from === 'hosted' ? '自托管服务 · 由设置管理' : hostOf(appHref(app)) },
      items,
    });
  };

  // Extension area (v0.2): rows per page shrink until the open slab fits above the bottom edge,
  // so expanding never moves the clock or the search field.
  const addToExtension = edit && shortcuts.mode !== 'single' && dockSites.length >= firstCap && pinned.length < MAX_PINS;
  const extItems = extra.length + (addToExtension ? 1 : 0);
  const room = h - top - clockH - 67 - (edit ? 62 : 0) - 56 - frameH;
  const pagesFor = (r: number) => Math.max(1, Math.ceil(extItems / (cols * r)));
  const heightFor = (r: number) => {
    const m = dockHeights(iconSize, labels, Math.min(r, Math.ceil(extItems / cols) || 1), shortcuts.pager && pagesFor(r) > 1);
    return { ...m, total: m.first + m.extension };
  };
  let rows = shortcuts.pageRows;
  while (rows > 1 && heightFor(rows).total > room) rows--;
  const metrics = heightFor(rows);
  const canToggle = shortcuts.mode === 'expand' && extra.length > 0 && !edit;
  // Opened with the button it stays open; opened by the mouse it follows the mouse.
  const peek = useDockPeek(canToggle && !expandedPref && !drawer, menu !== null);
  const expanded = extItems > 0 && (shortcuts.mode === 'double' || edit || expandedPref || peek.open);
  const pinExpanded = (v: boolean) => {
    peek.close();
    setExpandedPref(v);
    if (shortcuts.remember) storage.set(EXPANDED_KEY, v);
  };
  const collapse = () => pinExpanded(false);

  const drawerW = Math.min(1040, w - 160);
  const breathe = summary.level === 'error' && !errorSeen && motion === 'full';

  return (
    <div className="fixed inset-0 overflow-clip bg-base" onContextMenu={onBackgroundMenu}>
      <Wallpaper look={look} variant="desktop" receded={drawer} entry={current.entry} />

      <div inert={drawer}>
        <TopBar
          ref={pillRef}
          summary={summary}
          showStatus={showStatus}
          statusOpen={statusOpen}
          breathe={breathe}
          staticRing={summary.level === 'error' && motion !== 'full'}
          ui={ui}
          near={near}
          onToggleStatus={() => (statusOpen ? setStatusOpen(false) : openStatus())}
          onOpenDrawer={openDrawer}
          onOpenOverview={openStatus}
        />
        {showStatus && <StatusPopover open={statusOpen} services={services} />}

        <main
          className="absolute left-1/2 z-[3] transition-[opacity,transform] ease-soft"
          style={{
            top,
            width: slabW,
            transform: `translateX(-50%) scale(${drawer && motion === 'full' ? 0.98 : 1})`,
            opacity: drawer ? 0 : 1,
            transitionDuration: '200ms, 320ms',
          }}
        >
          {(ui.clock === 'show' || look.showDate) && (
            <div className="flex items-baseline gap-4 px-2 pb-5">
              {ui.clock === 'show' && (
                <span className="leading-none font-light tracking-[-0.035em] tabular-nums" style={{ fontSize: Math.round(60 * ui.clockScale) }}>
                  {formatClock(now, look.clock, look.showSeconds)}
                </span>
              )}
              {look.showDate && <span className="text-[15px] text-ink/66">{formatDate(now)}</span>}
            </div>
          )}
          <SearchSlab
            ref={slabRef}
            edit={edit}
            maxPanel={h - top - clockH - 67 - 36}
            dockHeight={(showShortcuts || edit ? metrics.first + (expanded ? metrics.extension : 0) : 0) + frameH}
            dockHandle={showShortcuts && canToggle ? <DockHandle state={expandedPref ? 'pinned' : peek.open ? 'peek' : 'closed'} count={extra.length} hover={peek.button} onToggle={() => pinExpanded(!expandedPref)} /> : undefined}
            hideInput={ui.search === 'hide'}
            onFocusSearch={() => {
              setStatusOpen(false);
              if (edit) setEdit(false);
            }}
            onAction={onAction}
            dock={
              <ShortcutsFrame framed={framed} onArrange={() => navigate('/settings/favorites?view=pinned')}>
              <Dock
                sites={dockSites}
                extra={extra}
                expanded={expanded}
                hover={peek.rows}
                rows={rows}
                showPager={shortcuts.pager}
                addToExtension={addToExtension}
                statusOf={showStatus ? (id) => statusById.get(id) : undefined}
                edit={edit}
                iconSize={iconSize}
                labels={labels}
                labelsOnHover={ui.labelsOnHover}
                slabWidth={slabW}
                allRef={allRef}
                onMenu={openMenu}
                onOpenDrawer={openDrawer}
                onUnpin={homeActions.unpin}
                onMove={homeActions.move}
                onMoveTo={homeActions.moveTo}
              />
              </ShortcutsFrame>
            }
          />
          {/* The dock's expand handle hangs below the slab: what follows starts under it, never on it. */}
          {showShortcuts && canToggle && <div aria-hidden className="h-9" />}
          {/* An empty collection: 添加收藏 (its 应用商店 tab) instead of an empty dock. */}
          {!edit && !privacy.guest && config.apps.length === 0 && !ro && (
            <button
              type="button"
              onClick={() => openAddFavorite({ tab: 'store' })}
              className="mx-auto mt-3.5 flex h-11 w-fit items-center gap-2 rounded-2xl border-0 px-4 text-[13px] text-ink/80 backdrop-blur-[30px] transition-colors duration-140 hover:text-ink"
              style={{ background: 'rgb(var(--nx-s1-rgb)/0.5)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.06)' }}
            >
              还没有收藏 · 从应用商店添加常用网站
              <ArrowRight className="size-4" />
            </button>
          )}
          {!edit && !privacy.guest && starter.show && (
            <div role="status" className="mx-auto mt-3.5 flex h-10 w-fit items-center gap-1 rounded-2xl pr-1 pl-4 text-[13px] text-ink/80 backdrop-blur-[30px]" style={{ background: 'rgb(var(--nx-s1-rgb)/0.5)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.06)' }}>
              已为你放好常用网站
              <button type="button" onClick={() => navigate('/settings/favorites?view=pinned')} className="ml-1 h-8 rounded-lg border-0 bg-transparent px-2 text-[13px] text-amber-hi hover:bg-ink/8">
                调整
              </button>
              <button type="button" onClick={starter.dismiss} aria-label="不再提示" className="grid size-8 place-items-center rounded-lg border-0 bg-transparent text-ink/50 hover:bg-ink/8 hover:text-ink">
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {edit && (
            <div className="mt-3.5 flex h-12 animate-pop items-center gap-3.5 rounded-2xl pr-2 pl-[18px] text-[13px] text-ink/78 backdrop-blur-[30px]" style={{ background: 'rgb(var(--nx-s1-rgb)/0.62)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-amber-rgb)/0.28)' }}>
              <span className="font-medium text-ink">编辑首页</span>
              <span>拖动排序 · 点 − 移除 · 键盘 Alt ←→ 移动、Delete 移除</span>
              <span className="flex-1" />
              <span className="text-ink/50">
                首排 {Math.min(pinned.length, firstCap)} / {firstCap} · 共 {pinned.length} / {MAX_PINS}
                {shortcuts.mode === 'single' && pinned.length > firstCap && ` · 另有 ${pinned.length - firstCap} 个仅在手机显示`}
              </span>
              <button type="button" onClick={() => void exitEdit()} className="h-[34px] rounded-[10px] border-0 bg-amber px-4 text-[13.5px] font-semibold text-on-amber hover:bg-amber-hi">
                完成
              </button>
            </div>
          )}
        </main>

        <WallpaperBar current={current} ui={ui} near={near.bottomLeft} hidden={drawer} />
      </div>

      <Drawer
        open={drawer}
        width={drawerW}
        top={h >= 900 ? 80 : 64}
        bottom={h >= 900 ? 56 : 32}
        services={all}
        showStatus={showStatus}
        onClose={closeDrawer}
        onMenu={openMenu}
        onEnterEdit={ro ? undefined : enterEdit}
      />

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={(refocus) => {
            const origin = menu.origin;
            setMenu(null);
            if (refocus) origin?.focus();
          }}
        />
      )}
      <ToastHost variant="desktop" />
      <LazyFavoriteDialogs />
    </div>
  );
}

/**
 * 常用网站 (UI v2 · spec 02 N1, prototype nexus.html#home): a heading row with 整理 (my favorites,
 * on 首页快捷方式) above the shortcuts. Lives in the slab's idle layer, so it fades out with the
 * shortcuts while searching. The middle clips: an extension opening or closing never paints over
 * the heading. The prototype's footer (with its 添加收藏) is gone: the home page has no favorites
 * buttons of its own.
 */
function ShortcutsFrame({ framed, onArrange, children }: { framed: boolean; onArrange(): void; children: ReactNode }) {
  if (!framed) return children;
  return (
    <section aria-labelledby="nx-shortcuts-title" className="flex h-full flex-col">
      <div className="flex flex-none items-end justify-between px-7 pb-0.5 text-[12px] text-ink/56" style={{ height: FRAME_HEAD }}>
        <h2 id="nx-shortcuts-title" className="m-0 text-[12px] font-normal">
          常用网站
        </h2>
        <button type="button" onClick={onArrange} aria-label="整理首页快捷方式" className="-mr-2 flex h-7 items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] text-ink/60 transition-colors duration-140 hover:bg-ink/8 hover:text-ink">
          整理
          <ArrowUpRight className="size-3" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}
