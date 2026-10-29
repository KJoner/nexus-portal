import { hostOf, matchApps, MAX_PINS, mobileShortcuts, paginate, shownServices, uiPreset, type AppEntry, type SearchRow } from '@nexus/shared';
import { Activity, Ban, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, ExternalLink, EyeOff, Heart, Image, LayoutTemplate, Lock, Pencil, Pin, PinOff, Plus, Search, Settings } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ActionSheet, type SheetItem, type SheetState } from '../../../components/ActionSheet';
import { Highlight } from '../../../components/Highlight';
import { ToastHost } from '../../../components/ToastHost';
import { dispatch, useConfig, useConfigStore } from '../../../data/config-store';
import { useServices, type ServiceView } from '../../../data/status';
import { AppTile } from '../../../icons/AppTile';
import { ALL_APPS_GLYPH } from '../../../icons/glyphs';
import { cn } from '../../../lib/cn';
import { useMotionLevel, useNow, useViewport, useVisualViewport } from '../../../lib/hooks';
import { host } from '../../../lib/host';
import { appLinkProps, openApp, recordAppOpen } from '../../../lib/open';
import { usePinyin } from '../../../lib/pinyin';
import { storage } from '../../../lib/storage';
import { formatClock, formatDate } from '../../../lib/time';
import { homeActions } from '../actions';
import { activateRow, rowTile, useSearchModel, type QuickActionId } from '../search-model';
import { actionStyle, dotStyle, messageColor, pillStyle, rowHighlighted } from '../status-style';
import { RetryButton } from '../desktop/StatusPopover';
import { useCurrentWallpaper } from '../rotation';
import { Wallpaper } from '../Wallpaper';
import { CreditText } from '../WallpaperBar';
import { useLongPress } from './useLongPress';

type Mode = 'home' | 'search' | 'apps';
type From = 'home' | 'apps' | 'hosted';

const TILE = { s: 54, m: 60, l: 66 } as const;
const GLASS: CSSProperties = { background: 'rgba(239,234,225,0.1)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(239,234,225,0.08)' };
const PANEL_BOTTOM = 'max(12px, calc(env(safe-area-inset-bottom) - 10px))';
const SAFE_TOP = 'max(env(safe-area-inset-top), 20px)';
/** Per-browser memory of the expanded shortcut sheet (设置 · 记住展开状态). */
const EXPANDED_KEY = 'nexus.home.expanded.mobile';
const DOTS_H = 18;

export function MobileHome() {
  const config = useConfig();
  const { look, home, privacy } = config.settings;
  const { w, h } = useViewport();
  const motion = useMotionLevel();
  const now = useNow(look.showSeconds);
  const navigate = useNavigate();
  const { services, all, summary } = useServices();
  const current = useCurrentWallpaper();
  const ui = config.settings.ui.mobile;
  const [mode, setMode] = useState<Mode>('home');
  const [q, setQ] = useState('');
  const [engineId, setEngineId] = useState(config.settings.search.defaultEngine);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [expandedPref, setExpandedPref] = useState(() => config.settings.home.shortcuts.remember && storage.get<boolean>(EXPANDED_KEY) === true);
  const inputRef = useRef<HTMLInputElement>(null);
  const vv = useVisualViewport(mode === 'search');

  const small = h < 760;
  const tile = TILE[look.iconSize] - (w < 380 ? 4 : 0);
  const labels = home.labels.mobile;
  const showStatus = !privacy.guest;
  const statusPill = showStatus && (ui.status === 'show' || summary.level === 'error');
  const shownIds = useMemo(() => new Set(shownServices(config).map((a) => a.id)), [config]);
  const homeServices = services.filter((s) => shownIds.has(s.app.id));
  const capacity = Math.max(0, home.mobileRows * 4 - homeServices.length);
  const { first: homeSites, extra } = useMemo(() => mobileShortcuts(config), [config]);
  // The Chrome extension's new tab is read-only: nothing here may write to the server.
  const ro = host.readOnly;
  const showAdd = !ro && homeSites.length < capacity;
  const isHome = mode === 'home';
  // v0.2: pinned sites beyond the first page live on swipeable pages, or all at once when the
  // sheet is pulled up. Hover is never needed.
  const extraPages = extra.length ? paginate(extra, home.mobileRows * 4) : [];
  const hasExtra = extraPages.length > 0;
  const expanded = hasExtra && (home.shortcuts.mode === 'double' || expandedPref);
  const setExpanded = (v: boolean) => {
    setExpandedPref(v);
    if (home.shortcuts.remember) storage.set(EXPANDED_KEY, v);
  };

  useEffect(() => setEngineId(config.settings.search.defaultEngine), [config.settings.search.defaultEngine]);

  const goHome = () => {
    setMode('home');
    setQ('');
    inputRef.current?.blur();
  };

  const openSheet = (id: string, from: From) => {
    const c = useConfigStore.getState().snapshot.config;
    const app = c.apps.find((a) => a.id === id);
    if (!app) return;
    const i = c.pins.indexOf(id);
    const toSettings: SheetItem = { label: '在设置中编辑', icon: Pencil, hint: '›', onSelect: () => navigate(`/settings/apps?edit=${id}`) };
    const hide: SheetItem = { label: '隐藏此应用', icon: EyeOff, danger: true, onSelect: () => homeActions.hide(id) };
    const newTab: SheetItem = { label: '在新标签页打开', icon: ExternalLink, onSelect: () => openApp(app, true) };
    const usage = `${c.pins.length}/${MAX_PINS}`;
    const last = (c.settings.home.shortcuts.mode === 'single' ? Math.min(c.pins.length, capacity) : c.pins.length) - 1;
    let items: SheetItem[];
    if (ro) items = [newTab, ...(from === 'hosted' && showStatus ? [{ label: '查看状态', icon: Activity, onSelect: () => openApps() }] : []), toSettings];
    else if (from === 'hosted') items = [newTab, ...(showStatus ? [{ label: '查看状态', icon: Activity, onSelect: () => openApps() }] : []), toSettings];
    else if (from === 'home')
      items = [
        newTab,
        { label: '向前移动', icon: ChevronLeft, disabled: i <= 0, onSelect: () => homeActions.move(id, -1) },
        { label: '向后移动', icon: ChevronRight, disabled: i >= last, onSelect: () => homeActions.move(id, 1) },
        { label: '移到最前', icon: ChevronFirst, disabled: i <= 0, onSelect: () => homeActions.moveTo(id, 0) },
        { label: '移到最后', icon: ChevronLast, disabled: i >= c.pins.length - 1, onSelect: () => homeActions.moveTo(id, c.pins.length - 1) },
        { label: '从首页移除', icon: PinOff, onSelect: () => homeActions.unpin(id) },
        hide,
        toSettings,
      ];
    else items = [newTab, i >= 0 ? { label: '从首页移除', icon: PinOff, hint: usage, onSelect: () => homeActions.unpin(id) } : { label: '添加到首页', icon: Pin, hint: usage, onSelect: () => homeActions.pin(id) }, hide, toSettings];
    setSheet({ header: { target: { kind: 'app', app }, name: app.name, sub: from === 'hosted' ? '自托管服务 · 在设置中管理' : hostOf(app.url) }, items });
  };
  /** Read-only with a fixed wallpaper: the picture is chosen in the portal's settings. */
  const changeWallpaper = () => (current.canStep ? current.next() : navigate('/settings/appearance'));
  const fromOf = (a: AppEntry, where: 'home' | 'apps'): From => (a.kind === 'service' ? 'hosted' : where);
  const bgPress = useLongPress(() => {
    const c = useConfigStore.getState().snapshot.config;
    const { entry, rotating } = current;
    const fav = c.settings.look.favorites.includes(entry.id);
    const minimal = c.settings.ui.preset === 'minimal';
    setSheet({
      header: { target: { kind: 'system', icon: Image }, name: entry.name, sub: '壁纸与首页' },
      items: [
        { label: '打开设置', icon: Settings, onSelect: () => navigate('/settings') },
        { label: '换一张壁纸', icon: Image, onSelect: changeWallpaper },
        ...(ro
          ? []
          : [
              { label: fav ? '取消收藏当前壁纸' : '收藏当前壁纸', icon: Heart, onSelect: () => homeActions.toggleFavorite(entry) },
              { label: '不喜欢这张', icon: Ban, onSelect: () => homeActions.dislike(entry, current.next) },
              ...(rotating ? [{ label: '锁定当前壁纸', icon: Lock, onSelect: () => homeActions.lock(entry) }] : []),
              { label: minimal ? '切换到日常模式' : '切换到极简模式', icon: LayoutTemplate, onSelect: () => dispatch({ type: 'settings.patch', section: 'ui', patch: uiPreset(minimal ? 'daily' : 'minimal', c.settings.ui) }) },
            ]),
      ],
    });
  });
  const { consumeClick: swallowBgClick, ...bgHandlers } = bgPress.bind('wallpaper');
  const { bind, pressed } = useLongPress((id) => {
    const app = useConfigStore.getState().snapshot.config.apps.find((a) => a.id === id);
    if (app) openSheet(id, fromOf(app, mode === 'apps' ? 'apps' : 'home'));
  });

  const openApps = () => {
    setMode('apps');
    setQ('');
  };

  const onAction = (id: QuickActionId) => {
    if (id === 'status') openApps();
    else if (id === 'wallpaper') changeWallpaper();
    else navigate('/settings');
  };

  // Sheet geometry: the floating home panel grows into a full-height sheet for search / apps.
  const rowH = tile + (labels ? 22 : 0);
  const rowsH = home.mobileRows * rowH + (home.mobileRows - 1) * 16;
  const dots = hasExtra && home.shortcuts.pager && !expanded;
  const statusH = statusPill ? 32 : 0;
  const homeH = 26 + statusH + 16 + rowsH + (dots ? DOTS_H : 0) + 8 + 14 + 52 + 14;
  // Pulled up: every pinned site in one scrolling grid, never covering the clock.
  const allRows = Math.ceil((homeSites.length + homeServices.length + (showAdd ? 1 : 0) + extra.length) / 4);
  const expandedH = 26 + statusH + 16 + allRows * rowH + (allRows - 1) * 16 + 8 + 14 + 52 + 14;
  const panelH = isHome ? (expanded ? `min(${expandedH}px, calc(100% - ${SAFE_TOP} - ${small ? 150 : 170}px))` : `${homeH}px`) : `calc(100% - ${SAFE_TOP} - 5px)`;
  const rowB = mode === 'apps' ? 'calc(max(env(safe-area-inset-bottom), 12px) + 6px)' : mode === 'search' ? '10px' : '14px';
  const contentB = `calc(${rowB} + 60px)`;
  const toastB = isHome ? `calc(${PANEL_BOTTOM} + 80px)` : `calc(${rowB} + 64px)`;
  const rootStyle: CSSProperties = vv ? { height: vv.height, transform: `translateY(${vv.offsetTop}px)` } : { height: '100dvh' };

  const layer = (on: boolean, delay = true): CSSProperties => ({
    opacity: on ? 1 : 0,
    transform: on ? 'none' : `translateY(${motion === 'full' ? 12 : 0}px)`,
    pointerEvents: on ? 'auto' : 'none',
    transitionDelay: on && delay ? '60ms' : '0ms',
  });

  return (
    <div className="nx-touch fixed inset-x-0 top-0 overflow-clip bg-base" style={rootStyle}>
      <Wallpaper look={look} variant="mobile" receded={!isHome} entry={current.entry} />
      {/* Long-press the wallpaper: settings and wallpaper actions, even with every control hidden. */}
      {isHome && <div aria-hidden data-bg-press className="absolute inset-0" style={{ WebkitTouchCallout: 'none' }} {...bgHandlers} onClick={swallowBgClick} />}

      <div className="pointer-events-none absolute right-[22px] left-[26px] flex items-start transition-opacity duration-200 ease-soft" style={{ top: `calc(${SAFE_TOP} + ${small ? 32 : 25}px)`, opacity: isHome ? 1 : 0 }} inert={!isHome}>
        <div className="flex min-w-0 flex-col gap-1.5">
          {ui.clock === 'show' && (
            <span className="leading-none font-light tracking-[-0.04em] tabular-nums" style={{ fontSize: Math.round((small ? 50 : 58) * ui.clockScale) }}>
              {formatClock(now, look.clock, look.showSeconds)}
            </span>
          )}
          {look.showDate && <span className="text-[14px] text-ink/70">{formatDate(now)}</span>}
          {(ui.wallpaperCredit === 'show' || current.entry.info?.required) && (current.entry.info || current.entry.credit) && (
            <span className="pointer-events-auto truncate text-[11.5px] text-ink/50">
              {current.entry.name} · <CreditText info={current.entry.info} fallback={current.entry.credit} />
            </span>
          )}
        </div>
        <span className="flex-1" />
        {ui.settings === 'show' && (
          <Link to="/settings" aria-label="设置" className="pointer-events-auto grid size-11 flex-none place-items-center rounded-full text-ink/85 backdrop-blur-[24px]" style={{ background: 'rgba(26,25,22,0.36)' }}>
            <Settings className="size-[18px]" />
          </Link>
        )}
      </div>

      <div
        className="absolute overflow-hidden backdrop-blur-[36px] backdrop-saturate-[1.15] ease-emph"
        style={{
          left: isHome ? 10 : 0,
          right: isHome ? 10 : 0,
          bottom: isHome ? PANEL_BOTTOM : 0,
          height: panelH,
          borderRadius: isHome ? 34 : '30px 30px 0 0',
          background: isHome ? 'rgba(26,25,22,0.5)' : 'rgba(28,26,23,0.72)',
          boxShadow: '0 20px 50px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.07)',
          transitionProperty: 'left, right, bottom, height, border-radius, background',
          transitionDuration: '420ms',
        }}
      >
        <Grabber
          label={!isHome ? '收起' : hasExtra ? (expanded ? '收起快捷方式' : '展开更多快捷方式') : '展开全部应用'}
          expanded={isHome && hasExtra ? expanded : undefined}
          onTap={() => (!isHome ? goHome() : hasExtra && home.shortcuts.mode === 'expand' ? setExpanded(!expanded) : openApps())}
          onSwipe={(dir) => {
            if (!isHome) return dir === 'down' && goHome();
            if (dir === 'up') return hasExtra && !expanded ? setExpanded(true) : openApps();
            if (expanded && home.shortcuts.mode === 'expand') setExpanded(false);
          }}
        />

        {/* home */}
        <div className="absolute top-[26px] right-3.5 left-3.5 flex flex-col transition-[opacity,transform] duration-200 ease-soft" style={{ bottom: contentB, ...layer(isHome, false) }} inert={!isHome}>
          {statusPill && (
            <div className="flex items-center px-0.5">
              <button type="button" onClick={openApps} aria-label={`服务状态：${summary.text}，查看全部应用`} className="-my-1.5 flex h-11 items-center border-0 bg-transparent p-0">
                <span className="flex h-8 items-center gap-2 rounded-full pr-3 pl-[11px] text-[12.5px]" style={pillStyle(summary.level)}>
                  <span
                    className={cn('size-1.5 flex-none rounded-full', summary.level === 'error' && motion === 'full' && 'animate-breathe')}
                    style={{ ...dotStyle(summary.level, 0.5), ...(summary.level === 'error' && motion !== 'full' ? { boxShadow: '0 0 0 2px rgba(233,118,95,0.4)' } : {}) }}
                  />
                  <span>{summary.text}</span>
                  {summary.more && <span className="opacity-66">{summary.more}</span>}
                  <span className="opacity-60">›</span>
                </span>
              </button>
            </div>
          )}
          <HomeGrid
            pages={[[...homeSites.map((a) => ({ app: a, view: undefined as ServiceView | undefined })), ...homeServices.map((s) => ({ app: s.app, view: s }))], ...extraPages.map((p) => p.map((a) => ({ app: a, view: undefined as ServiceView | undefined })))]}
            expanded={expanded}
            dots={dots}
            showAdd={showAdd}
            tile={tile}
            labels={labels}
            showStatus={showStatus}
            bind={bind}
            pressed={pressed}
            onAdd={openApps}
          />
        </div>

        {/* search */}
        <MobileSearch mode={mode} q={q} engineId={engineId} setEngineId={setEngineId} contentB={contentB} layer={layer} onAction={onAction} onDone={goHome} />

        {/* apps */}
        <MobileApps
          open={mode === 'apps'}
          q={q}
          contentB={contentB}
          layer={layer}
          all={all}
          showStatus={showStatus}
          bind={bind}
          pressed={pressed}
          onWebSearch={() => setMode('search')}
        />

        <form
          className="absolute right-3.5 left-3.5 flex gap-2.5 transition-[bottom] duration-420 ease-emph"
          style={{ bottom: rowB }}
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'search') document.querySelector<HTMLElement>('[data-first-result]')?.click();
          }}
        >
          <div
            className="flex h-[52px] min-w-0 flex-1 items-center gap-[11px] rounded-[18px] pr-1 pl-3.5 transition-[background,box-shadow] duration-200"
            style={{ background: isHome ? 'rgba(239,234,225,0.09)' : 'rgba(239,234,225,0.11)', boxShadow: mode === 'search' ? 'inset 0 0 0 1px rgba(230,192,138,0.4)' : 'none' }}
          >
            <LeadIcon mode={mode} engineId={engineId} />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onFocus={() => isHome && setMode('search')}
              placeholder={mode === 'apps' ? '筛选应用' : '搜索、网址或应用'}
              type="search"
              enterKeyHint="go"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={mode === 'apps' ? '筛选应用' : '搜索'}
              className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent text-[16px] text-ink caret-amber outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {q && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQ('');
                  inputRef.current?.focus();
                }}
                aria-label="清除"
                className="grid size-11 flex-none place-items-center border-0 bg-transparent p-0"
              >
                <span className="grid size-5 place-items-center rounded-full bg-ink/22 text-[11px] text-base">✕</span>
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => (isHome ? openApps() : goHome())}
            aria-label={isHome ? '全部应用' : mode === 'search' ? '取消' : '完成'}
            className="grid h-[52px] min-w-[52px] flex-none place-items-center rounded-[18px] border-0 text-[15px] text-ink transition-colors duration-200 active:scale-[.96]"
            style={isHome ? { ...GLASS, padding: 0 } : { background: 'transparent', padding: '0 16px' }}
          >
            {isHome ? <img src={ALL_APPS_GLYPH} alt="" className="size-[22px]" /> : mode === 'search' ? '取消' : '完成'}
          </button>
        </form>
      </div>

      <ToastHost variant="mobile" bottom={toastB} />
      <ActionSheet sheet={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}

function LeadIcon({ mode, engineId }: { mode: Mode; engineId: string }) {
  const config = useConfig();
  if (mode === 'search') {
    const engine = config.engines.find((e) => e.id === engineId) ?? config.engines[0]!;
    return <AppTile target={{ kind: 'engine', engine }} size={22} />;
  }
  return <Search className="size-5 flex-none text-ink/60" />;
}

interface SearchProps {
  mode: Mode;
  q: string;
  engineId: string;
  setEngineId(id: string): void;
  contentB: string;
  layer(on: boolean): CSSProperties;
  onAction(id: QuickActionId): void;
  onDone(): void;
}

function MobileSearch({ mode, q, engineId, setEngineId, contentB, layer, onAction, onDone }: SearchProps) {
  const config = useConfig();
  const on = mode === 'search';
  const { engines, result } = useSearchModel(q, engineId, 2);
  const hasQ = !!q.trim();
  const activate = (row: SearchRow, e: React.MouseEvent) => {
    e.preventDefault();
    if (row.kind === 'action') onDone();
    activateRow(row, config, false, onAction);
  };
  let first = true;
  return (
    <div className="absolute top-[26px] right-2.5 left-2.5 flex flex-col justify-end transition-[opacity,transform] duration-200 ease-soft" style={{ bottom: contentB, ...layer(on) }} inert={!on}>
      <div className="nx-scroll-hidden min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain">
        {result.sections.map((sec) => (
          <div key={sec.id}>
            <div className="px-2.5 pt-3.5 pb-1.5 text-[11.5px] text-ink/46">{sec.title}</div>
            {(hasQ ? sec.rows : sec.rows.slice(0, 2)).map((row) => {
              const isFirst = first && hasQ;
              first = false;
              return (
                <a
                  key={row.key}
                  href={'href' in row ? row.href : '#'}
                  data-first-result={isFirst || undefined}
                  onClick={(e) => activate(row, e)}
                  className="flex min-h-[54px] items-center gap-3 rounded-[14px] px-2.5 text-ink no-underline active:bg-ink/10"
                  style={{ background: isFirst ? 'rgba(239,234,225,0.08)' : 'transparent' }}
                >
                  <AppTile target={rowTile(row, config, result.engine)} size={34} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[15px]">
                      <Highlight text={row.title} ranges={row.highlight} />
                    </span>
                    <span className="truncate text-[12px] text-ink/48">{row.sub}</span>
                  </span>
                  {row.meta && <span className="flex-none text-[11.5px] text-ink/44">{row.meta}</span>}
                </a>
              );
            })}
          </div>
        ))}
      </div>
      <div className="nx-scroll-hidden mt-1 flex flex-none gap-0.5 overflow-x-auto px-0.5">
        {engines.map((e) => {
          const sel = e.id === result.engine.id;
          return (
            <button key={e.id} type="button" onMouseDown={(ev) => ev.preventDefault()} onClick={() => setEngineId(e.id)} aria-pressed={sel} className="h-11 flex-none border-0 bg-transparent px-0.5">
              <span
                className="flex h-[34px] items-center gap-[7px] rounded-full pr-[11px] pl-[7px] text-[12.5px] whitespace-nowrap"
                style={{ background: sel ? 'rgba(239,234,225,0.16)' : 'rgba(239,234,225,0.06)', boxShadow: sel ? 'inset 0 0 0 1px rgba(239,234,225,0.16)' : 'none', color: sel ? '#efeae1' : 'rgba(239,234,225,0.7)' }}
              >
                <AppTile target={{ kind: 'engine', engine: e }} size={20} />
                {e.kind === 'linkwarden' ? '收藏' : e.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface AppsProps {
  open: boolean;
  q: string;
  contentB: string;
  layer(on: boolean): CSSProperties;
  all: ServiceView[];
  showStatus: boolean;
  bind: ReturnType<typeof useLongPress>['bind'];
  pressed: string | null;
  onWebSearch(): void;
}

function MobileApps({ open, q, contentB, layer, all, showStatus, bind, pressed, onWebSearch }: AppsProps) {
  const config = useConfig();
  const fl = open ? q.trim() : '';
  const pinyin = usePinyin((s) => s.fn);
  const matched = useMemo(() => new Set(matchApps(config.apps, fl, false, { pinyin }).map((a) => a.id)), [config.apps, fl, pinyin]);
  const services = all.filter((s) => matched.has(s.app.id));
  const cats = config.categories
    .filter((c) => c.id !== 'hosted')
    .map((c) => ({ ...c, apps: config.apps.filter((a) => a.kind === 'site' && a.categoryId === c.id && matched.has(a.id)) }))
    .filter((c) => c.apps.length);
  const count = config.apps.filter((a) => !a.hidden).length;
  const empty = !!fl && !services.length && !cats.length;

  return (
    <div className="absolute top-[26px] right-0 left-0 flex flex-col transition-[opacity,transform] duration-200 ease-soft" style={{ bottom: contentB, ...layer(open) }} inert={!open}>
      <div className="flex flex-none items-baseline gap-2.5 px-6 pt-2 pb-1">
        <span className="text-[22px] font-medium tracking-[-0.01em]">全部应用</span>
        <span className="text-[12.5px] text-ink/46">{count} 个</span>
        <span className="flex-1" />
        <span className="text-[12px] text-ink/46">长按管理</span>
      </div>
      <div className="nx-scroll-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3.5 pb-2">
        {services.length > 0 && <div className="px-2.5 pt-4 pb-1.5 text-[11.5px] text-ink/50">我的服务</div>}
        {services.map((s) => {
          const { consumeClick, ...handlers } = bind(s.app.id);
          return (
            <div key={s.app.id} className="flex min-h-[62px] items-center gap-3 rounded-2xl px-2.5" style={{ background: showStatus && rowHighlighted(s.level) ? 'rgba(239,234,225,0.045)' : 'transparent' }}>
              <span {...handlers} onClick={(e) => consumeClick(e)} style={{ transform: pressed === s.app.id ? 'scale(.92)' : undefined }} className="transition-transform duration-160">
                <AppTile target={{ kind: 'app', app: s.app }} size={44} lazy />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex items-baseline gap-2">
                  <span className="text-[15px] font-medium">{s.app.name}</span>
                  {showStatus && <span className="text-[11.5px] text-ink/42">{s.levelLabel}</span>}
                </span>
                {showStatus ? (
                  <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: messageColor(s.level) }}>
                    <span className="size-1.5 flex-none rounded-full" style={dotStyle(s.level)} />
                    <span className="truncate">{s.message}</span>
                  </span>
                ) : (
                  <span className="truncate text-[12.5px] text-ink/50">{s.app.description}</span>
                )}
              </span>
              {s.level === 'unknown' && showStatus ? (
                <RetryButton appId={s.app.id} style={actionStyle(s.level)} className="flex h-11 flex-none items-center rounded-xl border-0 px-3.5 text-[13px] disabled:opacity-60" />
              ) : s.level === 'off' && showStatus ? (
                <Link to={`/settings/apps?edit=${s.app.id}`} className="flex h-11 flex-none items-center rounded-xl px-3.5 text-[13px] no-underline" style={actionStyle(s.level)}>
                  开启
                </Link>
              ) : (
                <a {...appLinkProps(s.app)} onClick={() => recordAppOpen(s.app)} className="flex h-11 flex-none items-center rounded-xl px-3.5 text-[13px] no-underline" style={actionStyle(showStatus ? s.level : 'ok')}>
                  打开
                </a>
              )}
            </div>
          );
        })}
        {cats.map((c) => (
          <div key={c.id}>
            <div className="px-2.5 pt-5 pb-3 text-[11.5px] text-ink/50">{c.label}</div>
            <div className="grid grid-cols-4 gap-y-4">
              {c.apps.map((a) => {
                const { consumeClick, ...handlers } = bind(a.id);
                const pinned = config.pins.includes(a.id);
                return (
                  <a
                    key={a.id}
                    {...appLinkProps(a)}
                    {...handlers}
                    aria-label={a.name + (pinned ? '，已在首页' : '')}
                    onClick={(e) => !consumeClick(e) && recordAppOpen(a)}
                    draggable={false}
                    className="flex flex-col items-center gap-[7px] text-ink no-underline transition-transform duration-90 active:scale-[.94]"
                    style={{ transform: pressed === a.id ? 'scale(.92)' : undefined }}
                  >
                    <AppTile target={{ kind: 'app', app: a }} size={56} lazy />
                    <span className="max-w-full truncate px-0.5 text-[11.5px] text-ink/82">{a.name}</span>
                    <span className="-mt-[3px] size-1 rounded-full" style={{ background: pinned ? '#e6c08a' : 'transparent' }} />
                  </a>
                );
              })}
            </div>
          </div>
        ))}
        {empty && (
          <div className="flex flex-col items-center gap-2 px-5 pt-16 pb-5 text-center">
            <span className="text-[16px] font-medium">没有匹配「{q}」的应用</span>
            <span className="text-[13px] leading-[1.6] text-ink/50">可按名称、域名或别名筛选</span>
            <button type="button" onClick={onWebSearch} className="mt-2.5 h-11 rounded-[14px] border-0 bg-ink/10 px-[18px] text-[14px] text-ink">
              改为网页搜索
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The sheet handle: tap toggles, a vertical swipe expands / collapses. Touch scrolling is off on
 * the handle itself, so the gesture never scrolls the page or fights Safari's own gestures.
 */
function Grabber({ label, expanded, onTap, onSwipe }: { label: string; expanded?: boolean; onTap(): void; onSwipe(dir: 'up' | 'down'): void }) {
  const start = useRef<{ y: number; id: number } | null>(null);
  const swiped = useRef(false);
  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    start.current = { y: e.clientY, id: e.pointerId };
    swiped.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const up = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dy = e.clientY - s.y;
    if (Math.abs(dy) < 24) return;
    swiped.current = true;
    onSwipe(dy < 0 ? 'up' : 'down');
  };
  return (
    <button
      type="button"
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={() => (start.current = null)}
      onClick={() => (swiped.current ? (swiped.current = false) : onTap())}
      aria-label={label}
      aria-expanded={expanded}
      className="absolute top-0 left-1/2 z-[1] grid h-[26px] w-40 -translate-x-1/2 touch-none place-items-center border-0 bg-transparent"
    >
      <span className="h-[5px] w-9 rounded-[3px] bg-ink/28" />
    </button>
  );
}

interface GridItem {
  app: AppEntry;
  view: ServiceView | undefined;
}

interface HomeGridProps {
  /** Page 1: first sites + services; later pages: the remaining pinned sites. */
  pages: GridItem[][];
  expanded: boolean;
  dots: boolean;
  showAdd: boolean;
  tile: number;
  labels: boolean;
  showStatus: boolean;
  bind: ReturnType<typeof useLongPress>['bind'];
  pressed: string | null;
  onAdd(): void;
}

/**
 * Collapsed: pages side by side on a native scroll-snap strip (smooth on iOS, a swipe never opens a
 * tile). Expanded: one vertical grid with everything.
 */
function HomeGrid({ pages, expanded, dots, showAdd, tile, labels, showStatus, bind, pressed, onAdd }: HomeGridProps) {
  const strip = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const multi = pages.length > 1;

  useEffect(() => {
    if (expanded) setPage(0);
  }, [expanded]);

  const cell = ({ app, view }: GridItem) => {
    const { consumeClick, ...handlers } = bind(app.id);
    return (
      <a
        key={app.id}
        {...appLinkProps(app)}
        {...handlers}
        aria-label={view && showStatus ? `${app.name}，${view.levelLabel}` : app.name}
        onClick={(e) => !consumeClick(e) && recordAppOpen(app)}
        draggable={false}
        className="flex flex-col items-center gap-[7px] text-ink no-underline transition-transform duration-160 ease-soft active:scale-[.94]"
        style={{ transform: pressed === app.id ? 'scale(.92)' : undefined }}
      >
        <AppTile target={{ kind: 'app', app }} size={tile} status={view && showStatus ? view.level : undefined} />
        {labels && <span className="max-w-full truncate px-0.5 text-[11.5px] text-ink/82">{app.name}</span>}
      </a>
    );
  };
  const add = showAdd && (
    <button key="add" type="button" onClick={onAdd} aria-label="添加到首页" className="flex flex-col items-center gap-[7px] border-0 bg-transparent p-0 text-ink">
      <span className="grid place-items-center rounded-[17px] border-[1.5px] border-dashed border-ink/30" style={{ width: tile, height: tile }}>
        <Plus className="size-5 text-ink/66" />
      </span>
      {labels && <span className="text-[11.5px] text-ink/56">添加</span>}
    </button>
  );

  if (expanded) {
    return (
      <div role="group" aria-label="全部快捷方式" className="nx-scroll-hidden mt-4 grid min-h-0 flex-1 grid-cols-4 content-start gap-y-4 overflow-y-auto overscroll-contain pb-1">
        {pages[0]!.map(cell)}
        {add}
        {pages.slice(1).flat().map(cell)}
      </div>
    );
  }

  return (
    <>
      <div
        ref={strip}
        role={multi ? 'group' : undefined}
        aria-label={multi ? `快捷方式，第 ${page + 1} / ${pages.length} 页` : undefined}
        onScroll={(e) => setPage(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
        className="nx-scroll-hidden mt-4 flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain"
      >
        {pages.map((items, p) => (
          <div key={p} className="grid w-full flex-none snap-start snap-always grid-cols-4 content-start gap-y-4">
            {items.map(cell)}
            {p === 0 && add}
          </div>
        ))}
      </div>
      {dots && (
        <div className="flex justify-center gap-1.5" style={{ height: DOTS_H, alignItems: 'flex-end' }}>
          {pages.map((_, p) => (
            <button
              key={p}
              type="button"
              aria-label={`第 ${p + 1} 页`}
              aria-current={p === page ? 'page' : undefined}
              onClick={() => strip.current?.scrollTo({ left: p * strip.current.clientWidth, behavior: 'smooth' })}
              className="grid h-4 w-3 place-items-center border-0 bg-transparent p-0"
            >
              <span className="block size-1.5 rounded-full" style={{ background: p === page ? 'rgba(239,234,225,0.8)' : 'rgba(239,234,225,0.28)' }} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
