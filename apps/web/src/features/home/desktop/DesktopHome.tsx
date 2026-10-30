import { appHref, desktopShortcuts, hostOf, MAX_PINS, pinnedSites, shownServices, uiPreset, type AppEntry } from '@nexus/shared';
import { Activity, ArrowUpRight, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, ExternalLink, Eye, EyeOff, GripVertical, Image, LayoutTemplate, Pencil, Pin, PinOff, Settings, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { ContextMenu, menuPoint, type MenuItem, type MenuState } from '../../../components/ContextMenu';
import { ToastHost } from '../../../components/ToastHost';
import { toast } from '../../../components/toast-store';
import { dispatch, flush, useConfig, useConfigStore } from '../../../data/config-store';
import { useServices } from '../../../data/status';
import { useMotionLevel, useNow, useViewport } from '../../../lib/hooks';
import { host } from '../../../lib/host';
import { openApp } from '../../../lib/open';
import { useProximity } from '../../../lib/proximity';
import { storage } from '../../../lib/storage';
import { formatClock, formatDate } from '../../../lib/time';
import { homeActions } from '../actions';
import type { QuickActionId } from '../search-model';
import { useCurrentWallpaper } from '../rotation';
import { Wallpaper } from '../Wallpaper';
import { WallpaperBar } from '../WallpaperBar';
import { Dock, DockHandle, dockHeights, extensionCols, useDockPeek, type MenuSource } from './Dock';
import { Drawer } from './Drawer';
import { SearchSlab, type SearchSlabHandle } from './SearchSlab';
import { StatusPopover } from './StatusPopover';
import { TopBar } from './TopBar';

const ICON = { s: 48, m: 56, l: 64 } as const;
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

  const showStatus = !privacy.guest;
  // 布局微调: vertical offset and slab width, kept inside the window.
  const top = Math.max(72, (h >= 900 ? 228 : Math.round(h * 0.24)) + Math.round((h * ui.offsetY) / 100));
  const slabW = Math.min(ui.searchWidth, w - 120);
  const clockH = ui.clock === 'show' ? Math.round(60 * ui.clockScale) + 20 : look.showDate ? 40 : 0;
  const iconSize = ICON[look.iconSize];
  const labels = home.labels.desktop;
  const showShortcuts = ui.shortcuts === 'show';
  const pinned = useMemo(() => pinnedSites(config), [config]);
  const { first: dockSites, extra } = useMemo(() => desktopShortcuts(config), [config]);
  const { shortcuts } = home;
  const dockServices = useMemo(() => {
    const shown = new Set(shownServices(config).map((a) => a.id));
    return services.filter((s) => shown.has(s.app.id));
  }, [config, services]);

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
    const toSettings: MenuItem = { label: '在设置中编辑', icon: Pencil, hint: '↗', onSelect: () => navigate(`/settings/apps?edit=${app.id}`) };
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
      const last = (shortcuts.mode === 'single' ? Math.min(pins.length, home.dockSize) : pins.length) - 1;
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
  const addToExtension = edit && shortcuts.mode !== 'single' && dockSites.length >= home.dockSize && pinned.length < MAX_PINS;
  const extItems = extra.length + (addToExtension ? 1 : 0);
  const cols = extensionCols(iconSize, slabW);
  const room = h - top - clockH - 67 - (edit ? 62 : 0) - 56;
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
            dockHeight={showShortcuts || edit ? metrics.first + (expanded ? metrics.extension : 0) : 0}
            dockHandle={showShortcuts && canToggle ? <DockHandle state={expandedPref ? 'pinned' : peek.open ? 'peek' : 'closed'} count={extra.length} hover={peek.button} onToggle={() => pinExpanded(!expandedPref)} /> : undefined}
            hideInput={ui.search === 'hide'}
            onFocusSearch={() => {
              setStatusOpen(false);
              if (edit) setEdit(false);
            }}
            onAction={onAction}
            dock={
              <Dock
                sites={dockSites}
                extra={extra}
                expanded={expanded}
                hover={peek.rows}
                rows={rows}
                showPager={shortcuts.pager}
                addToExtension={addToExtension}
                services={dockServices}
                dockSize={home.dockSize}
                edit={edit}
                iconSize={iconSize}
                labels={labels}
                labelsOnHover={ui.labelsOnHover}
                slabWidth={slabW}
                showBadges={showStatus}
                allRef={allRef}
                onMenu={openMenu}
                onOpenDrawer={openDrawer}
                onUnpin={homeActions.unpin}
                onMove={homeActions.move}
                onMoveTo={homeActions.moveTo}
              />
            }
          />
          {edit && (
            <div className="mt-3.5 flex h-12 animate-pop items-center gap-3.5 rounded-2xl pr-2 pl-[18px] text-[13px] text-ink/78 backdrop-blur-[30px]" style={{ background: 'rgba(26,25,22,0.62)', boxShadow: 'inset 0 0 0 1px rgba(230,192,138,0.28)' }}>
              <span className="font-medium text-ink">编辑首页</span>
              <span>拖动排序 · 点 − 移除 · 键盘 Alt ←→ 移动、Delete 移除</span>
              <span className="flex-1" />
              <span className="text-ink/50">
                首排 {Math.min(pinned.length, home.dockSize)} / {home.dockSize} · 共 {pinned.length} / {MAX_PINS}
                {shortcuts.mode === 'single' && pinned.length > home.dockSize && ` · 另有 ${pinned.length - home.dockSize} 个仅在手机显示`}
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
    </div>
  );
}
