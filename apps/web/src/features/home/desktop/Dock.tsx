import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { horizontalListSortingStrategy, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { hostOf, paginate } from '@nexus/shared';
import type { AppEntry } from '@nexus/shared';
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type Ref } from 'react';
import type { ServiceView } from '../../../data/status';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { dndAccessibility } from '../../../lib/dnd';
import { appLinkProps, recordAppOpen } from '../../../lib/open';

export type MenuSource = 'dock' | 'drawer' | 'hosted';

interface Props {
  sites: AppEntry[];
  /** Pinned sites after the first row (v0.2 扩展区). */
  extra: AppEntry[];
  services: ServiceView[];
  dockSize: number;
  edit: boolean;
  iconSize: number;
  labels: boolean;
  /** 首页显示: names appear only while the pointer (or focus) is on a tile. */
  labelsOnHover?: boolean;
  /** Outer width of the search slab (设置 · 搜索面板宽度). */
  slabWidth?: number;
  showBadges: boolean;
  /** Extension visible. */
  expanded: boolean;
  /** Mouse over the rows (悬停展开); the wrapper is what useDockPeek watches. */
  hover?: HoverZone;
  /** Rows per extension page, already limited to what fits the viewport. */
  rows: number;
  showPager: boolean;
  /** Edit mode with room left: an add tile closes the extension. */
  addToExtension: boolean;
  allRef: Ref<HTMLButtonElement>;
  onMenu(e: MouseEvent<HTMLElement>, app: AppEntry, from: MenuSource): void;
  onOpenDrawer(): void;
  onUnpin(id: string): void;
  onMove(id: string, delta: number): void;
  onMoveTo(id: string, index: number): void;
}

const GAP = 3;
const SEP = 13;
const EXT_GAP_X = 12;
const EXT_GAP_Y = 14;
const EXT_TOP = 18;
const PAGER_H = 34;
const EXT_BOTTOM = 18;
/** A pointer passing through the first row does not open anything. */
const PEEK_OPEN_MS = 160;
/** Crossing between the rows and the button, or slipping out briefly, does not close anything. */
const PEEK_CLOSE_MS = 260;

export interface HoverZone {
  onPointerEnter(e: PointerEvent): void;
  onPointerLeave(e: PointerEvent): void;
}

/**
 * 悬停展开: the mouse opens the extension for a moment. The rows open it and keep it open, the
 * button only keeps it open: opening from the button would pull it away from under the pointer.
 * Touch and pen never count, they use the button. `hold` keeps it open while a menu is up, whose
 * tile would otherwise fold away under it.
 */
export function useDockPeek(enabled: boolean, hold: boolean) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inside = useRef(false);

  const schedule = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  const enter = (e: PointerEvent, opens: boolean) => {
    if (e.pointerType !== 'mouse') return;
    inside.current = true;
    clearTimeout(timer.current);
    if (opens && enabled && !hold && !open) schedule(true, PEEK_OPEN_MS);
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    inside.current = false;
    clearTimeout(timer.current);
    if (open && !hold) schedule(false, PEEK_CLOSE_MS);
  };

  useEffect(() => {
    if (!enabled) close();
  }, [enabled]);
  useEffect(() => {
    clearTimeout(timer.current);
    if (!hold && open && !inside.current) schedule(false, PEEK_CLOSE_MS);
    // Only when the menu comes or goes; a pointer leaving later is handled by leave().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    open: enabled && open,
    close,
    rows: { onPointerEnter: (e: PointerEvent) => enter(e, true), onPointerLeave: leave } satisfies HoverZone,
    button: { onPointerEnter: (e: PointerEvent) => enter(e, false), onPointerLeave: leave } satisfies HoverZone,
  };
}

/**
 * Heights the search slab animates between: the first row alone (R1.5: 64 + icon, 40 + icon
 * without labels) and the open extension below it.
 */
export function dockHeights(iconSize: number, labels: boolean, rows: number, pager: boolean) {
  const item = iconSize + (labels ? 27 : 0);
  const bottom = labels ? 15 : 18;
  const first = 22 + item + bottom;
  const grid = rows * item + (rows - 1) * EXT_GAP_Y;
  return { first, item, rowGap: EXT_GAP_Y, extension: EXT_TOP + grid + (pager ? PAGER_H : 0) + EXT_BOTTOM - bottom };
}

/** Extension columns: the natural Dock cell with a little more air, as many as fit the slab. */
export function extensionCols(iconSize: number, slabWidth = 760): number {
  return Math.max(5, Math.min(12, Math.floor((slabWidth - 48 + EXT_GAP_X) / (iconSize + 12 + EXT_GAP_X))));
}

const itemClass = 'group/tile flex flex-col items-center gap-[9px] text-ink no-underline transition-transform duration-140 ease-soft';
const liftClass = 'hover:-translate-y-[3px] active:-translate-y-px active:scale-[.96]';

function focusDock(id: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-dock="${CSS.escape(id)}"]`)?.focus());
}

function Label({ name, labels, onHover, cell }: { name: string; labels: boolean; onHover?: boolean; cell: number }) {
  if (!labels) return null;
  // On-hover labels keep their space, so tiles never jump when a name appears.
  return (
    <span
      className={cn('truncate text-[12px] text-ink/80', onHover && 'opacity-0 transition-opacity duration-140 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100')}
      style={{ maxWidth: cell + 8 }}
    >
      {name}
    </span>
  );
}

type SiteProps = { app: AppEntry; index: number; total: number; cell: number; onReveal(id: string): void } & Pick<Props, 'edit' | 'iconSize' | 'labels' | 'labelsOnHover' | 'onMenu' | 'onUnpin' | 'onMove'>;

function DockSite(p: SiteProps) {
  const { app, edit, cell, iconSize, index, total } = p;
  const s = useSortable({ id: app.id, disabled: !edit });
  const onKey = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (!edit) return;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      p.onMove(app.id, e.key === 'ArrowLeft' ? -1 : 1);
      p.onReveal(app.id);
      focusDock(app.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      p.onUnpin(app.id);
    }
  };
  return (
    <div
      ref={s.setNodeRef}
      data-dnd-id={app.id}
      data-dnd-name={app.name}
      {...(edit ? s.listeners : {})}
      className={cn('relative flex-none', edit && 'cursor-grab touch-none', s.isDragging && 'z-10 cursor-grabbing')}
      style={{ width: cell, transform: DndCSS.Translate.toString(s.transform), transition: s.transition, opacity: s.isDragging ? 0.6 : 1 }}
    >
      <a
        {...appLinkProps(app)}
        data-dock={app.id}
        title={`${app.name} · ${hostOf(app.url)}`}
        draggable={false}
        aria-label={edit ? `${app.name}，第 ${index + 1} / ${total} 位。Alt+左右方向键移动，Delete 移除` : app.name}
        onClick={(e) => (edit ? e.preventDefault() : recordAppOpen(app))}
        onContextMenu={(e) => p.onMenu(e, app, 'dock')}
        onKeyDown={onKey}
        className={cn(itemClass, !edit && liftClass, edit && 'cursor-[inherit]')}
      >
        <AppTile target={{ kind: 'app', app }} size={iconSize} />
        <Label name={app.name} labels={p.labels} onHover={p.labelsOnHover && !edit} cell={cell} />
      </a>
      {edit && (
        <button
          type="button"
          aria-label={`从首页移除 ${app.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => p.onUnpin(app.id)}
          className="absolute -top-[7px] grid size-[22px] place-items-center rounded-full border-0 p-0"
          style={{ left: (cell - iconSize) / 2 - 7, background: 'rgba(60,56,50,0.96)', boxShadow: '0 2px 6px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(239,234,225,0.16)' }}
        >
          <span className="h-0.5 w-2.5 rounded-[1px] bg-ink" />
        </button>
      )}
    </div>
  );
}

function AddTile({ cell, iconSize, labels, label, onClick }: { cell: number; iconSize: number; labels: boolean; label: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className={cn(itemClass, 'flex-none border-0 bg-transparent p-0')} style={{ width: cell }}>
      <span className="grid place-items-center border-[1.5px] border-dashed border-ink/32" style={{ width: iconSize, height: iconSize, borderRadius: Math.round(iconSize * 0.285) }}>
        <Plus className="size-5 text-ink/70" />
      </span>
      {labels && <span className="text-[12px] whitespace-nowrap text-ink/60">{label}</span>}
    </button>
  );
}

function Separator() {
  return <span aria-hidden className="mx-1.5 mt-2 h-10 w-px flex-none bg-ink/14" />;
}

export type DockHandleState = 'closed' | 'peek' | 'pinned';

const HANDLE_TEXT: Record<DockHandleState, (n: number) => { label: string; title: string }> = {
  closed: (n) => ({ label: `展开更多快捷方式（另有 ${n} 个）`, title: `另有 ${n} 个快捷方式` }),
  peek: (n) => ({ label: `固定展开更多快捷方式（另有 ${n} 个）`, title: '固定展开' }),
  pinned: () => ({ label: '收起更多快捷方式', title: '收起' }),
};

/**
 * The expand control under the slab. The arrow shows what a click does, so it still points down
 * while the extension is only peeking: the click keeps it open. One size in every state, so only
 * the arrow changes; the wide transparent hit area is what makes it easy to reach.
 */
export function DockHandle({ state, count, hover, onToggle }: { state: DockHandleState; count: number; hover?: HoverZone; onToggle(): void }) {
  const { label, title } = HANDLE_TEXT[state](count);
  return (
    <button
      type="button"
      {...hover}
      onClick={onToggle}
      aria-expanded={state !== 'closed'}
      aria-label={label}
      title={title}
      className="group/handle grid h-11 w-32 place-items-center border-0 bg-transparent p-0 outline-none"
    >
      <span className="grid size-[30px] place-items-center rounded-full bg-[rgba(26,25,22,0.6)] text-ink/70 opacity-45 shadow-[0_6px_18px_rgba(0,0,0,0.28),inset_0_0_0_1px_rgba(239,234,225,0.1)] transition-[opacity,color,box-shadow] duration-200 ease-soft group-hover/handle:text-amber-hi group-hover/handle:opacity-100 group-hover/handle:shadow-[0_6px_18px_rgba(0,0,0,0.28),inset_0_0_0_1px_rgba(230,192,138,0.42)] group-hover/slab:opacity-100 group-focus-visible/handle:opacity-100 group-focus-visible/handle:outline-2 group-focus-visible/handle:outline-offset-2 group-focus-visible/handle:outline-amber pointer-coarse:opacity-100">
        <span className={cn('grid transition-transform duration-240 ease-soft', state === 'pinned' && 'rotate-180')}>
          <ChevronDown className="size-4 group-hover/handle:animate-nudge" />
        </span>
      </span>
    </button>
  );
}

/**
 * Wheel / two-finger swipe over the extension turns one page per gesture. The listener is not
 * passive so a horizontal swipe cannot also trigger the browser's back gesture; it is attached to
 * the extension only, never the page.
 */
function useWheelPaging(el: HTMLElement | null, pages: number, go: (dir: number) => void) {
  useEffect(() => {
    if (!el || pages < 2) return;
    let acc = 0;
    let last = 0;
    let turned = false;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = e.timeStamp;
      // A pause ends the gesture (inertial scrolling keeps sending small deltas).
      if (now - last > 220) {
        acc = 0;
        turned = false;
      }
      last = now;
      if (turned) return;
      acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(acc) >= 40) {
        turned = true;
        go(acc > 0 ? 1 : -1);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el, pages, go]);
}

export function Dock(props: Props) {
  const { sites, extra, services, dockSize, edit, iconSize, labels, labelsOnHover, showBadges, expanded, rows, showPager, slabWidth = 760 } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const showAdd = edit && sites.length < dockSize;
  const cells = sites.length + (showAdd ? 1 : 0) + services.length + 1;
  const seps = services.length ? 2 : 1;
  const natural = iconSize + 12;
  const cell = Math.max(iconSize + 2, Math.min(natural, Math.floor((slabWidth - 48 - (cells - 1) * GAP - seps * SEP) / cells)));

  const cols = extensionCols(iconSize, slabWidth);
  const pages = paginate(extra, cols * rows);
  const [page, setPage] = useState(0);
  const [dir, setDir] = useState<'next' | 'prev' | null>(null);
  const current = Math.min(page, pages.length - 1);
  const [extEl, setExtEl] = useState<HTMLDivElement | null>(null);
  const pagesRef = useRef(pages.length);
  pagesRef.current = pages.length;
  const go = useRef((d: number) => {
    setPage((p) => {
      const next = Math.max(0, Math.min(pagesRef.current - 1, p + d));
      if (next !== p) setDir(d > 0 ? 'next' : 'prev');
      return next;
    });
  }).current;
  const goTo = (p: number) => {
    setDir(p > current ? 'next' : 'prev');
    setPage(p);
  };
  useWheelPaging(expanded ? extEl : null, pages.length, go);
  // Rendered from the first opening on, so a collapsed home never loads the extension's icons.
  const [opened, setOpened] = useState(expanded);
  if (expanded && !opened) setOpened(true);

  // Collapsing returns to the first page, so the next opening starts from the beginning.
  useEffect(() => {
    if (expanded) return;
    setPage(0);
    setDir(null);
  }, [expanded]);

  /** Keeps a pin that moves across a page boundary (Alt+←→ in edit mode) on screen. */
  const reveal = (id: string) => {
    const i = extra.findIndex((a) => a.id === id);
    if (i >= 0) setPage(Math.floor(i / (cols * rows)));
  };

  const shownExtra = pages[current] ?? [];
  const lastPage = current === pages.length - 1;
  const total = sites.length + extra.length;

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const all = [...sites, ...extra];
    const to = all.findIndex((a) => a.id === e.over!.id);
    if (to >= 0) props.onMoveTo(String(e.active.id), to);
  };

  const onExtKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      go(e.key === 'PageDown' ? 1 : -1);
    }
  };

  const siteProps = { edit, iconSize, labels, labelsOnHover, onMenu: props.onMenu, onUnpin: props.onUnpin, onMove: props.onMove, onReveal: reveal, total };

  return (
    <DndContext accessibility={dndAccessibility} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="h-full" {...props.hover}>
        <div data-dock-row="first" className="flex items-start justify-center px-6 pt-[22px]" style={{ gap: GAP }}>
          <SortableContext items={sites.map((a) => a.id)} strategy={horizontalListSortingStrategy}>
            {sites.map((app, i) => (
              <DockSite key={app.id} app={app} index={i} cell={cell} {...siteProps} />
            ))}
          </SortableContext>
          {showAdd && <AddTile cell={cell} iconSize={iconSize} labels={labels} label={`添加 ${sites.length}/${dockSize}`} onClick={props.onOpenDrawer} />}
          {services.length > 0 && <Separator />}
          {services.map((s) => (
            <a
              key={s.app.id}
              {...appLinkProps(s.app)}
              title={`${s.app.name} · ${s.levelLabel}：${s.message}`}
              aria-label={showBadges ? `${s.app.name}，${s.levelLabel}：${s.message}` : s.app.name}
              onClick={(e) => (edit ? e.preventDefault() : recordAppOpen(s.app))}
              onContextMenu={(e) => props.onMenu(e, s.app, 'hosted')}
              className={cn(itemClass, 'flex-none', !edit && liftClass, edit && 'pointer-events-none opacity-40')}
              style={{ width: cell }}
              tabIndex={edit ? -1 : undefined}
            >
              <AppTile target={{ kind: 'app', app: s.app }} size={iconSize} status={showBadges ? s.level : undefined} />
              <Label name={s.app.name} labels={labels} onHover={labelsOnHover} cell={cell} />
            </a>
          ))}
          <Separator />
          <button
            ref={props.allRef}
            type="button"
            aria-label="全部应用"
            onClick={props.onOpenDrawer}
            tabIndex={edit ? -1 : undefined}
            className={cn(itemClass, 'flex-none border-0 bg-transparent p-0', !edit && liftClass, edit && 'pointer-events-none opacity-40')}
            style={{ width: cell }}
          >
            <AppTile target={{ kind: 'all' }} size={iconSize} />
            <Label name="全部应用" labels={labels} onHover={labelsOnHover} cell={cell} />
          </button>
        </div>

        {opened && (extra.length > 0 || props.addToExtension) && (
          // Stays mounted while collapsed so the slab's height animation clips it instead of popping.
          <div
            ref={setExtEl}
            role="group"
            aria-label={pages.length > 1 ? `更多快捷方式，第 ${current + 1} / ${pages.length} 页` : '更多快捷方式'}
            aria-hidden={!expanded}
            inert={!expanded}
            onKeyDown={onExtKey}
            className="px-6 transition-opacity duration-200 ease-soft"
            style={{ paddingTop: EXT_TOP, opacity: expanded ? 1 : 0 }}
          >
            <SortableContext items={shownExtra.map((a) => a.id)} strategy={rectSortingStrategy}>
              <div
                key={current}
                className={cn('grid justify-center', dir === 'next' && 'nx-page-next', dir === 'prev' && 'nx-page-prev')}
                style={{ gridTemplateColumns: `repeat(${cols}, ${natural}px)`, columnGap: EXT_GAP_X, rowGap: EXT_GAP_Y }}
              >
                {shownExtra.map((app, k) => (
                  <DockSite key={app.id} app={app} index={sites.length + current * cols * rows + k} cell={natural} {...siteProps} />
                ))}
                {props.addToExtension && lastPage && shownExtra.length < cols * rows && <AddTile cell={natural} iconSize={iconSize} labels={labels} label="添加" onClick={props.onOpenDrawer} />}
              </div>
            </SortableContext>
            {showPager && pages.length > 1 && (
              <div className="flex items-center justify-center gap-1 pt-2" style={{ height: PAGER_H }}>
                <button type="button" aria-label="上一页" disabled={current === 0} onClick={() => go(-1)} className="grid size-7 place-items-center rounded-full border-0 bg-transparent text-ink/60 hover:bg-ink/10 hover:text-ink disabled:opacity-25">
                  <ChevronLeft className="size-3.5" />
                </button>
                {pages.map((_, p) => (
                  <button key={p} type="button" aria-label={`第 ${p + 1} 页`} aria-current={p === current ? 'page' : undefined} onClick={() => goTo(p)} className="grid h-7 w-4 place-items-center border-0 bg-transparent p-0">
                    <span className="block h-1.5 rounded-full transition-[width,background] duration-200 ease-soft" style={{ width: p === current ? 14 : 6, background: p === current ? 'rgba(239,234,225,0.78)' : 'rgba(239,234,225,0.26)' }} />
                  </button>
                ))}
                <button type="button" aria-label="下一页" disabled={lastPage} onClick={() => go(1)} className="grid size-7 place-items-center rounded-full border-0 bg-transparent text-ink/60 hover:bg-ink/10 hover:text-ink disabled:opacity-25">
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </DndContext>
  );
}
