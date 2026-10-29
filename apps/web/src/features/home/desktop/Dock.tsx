import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { horizontalListSortingStrategy, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { hostOf, paginate } from '@nexus/shared';
import type { AppEntry } from '@nexus/shared';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
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
  showBadges: boolean;
  /** Extension visible. */
  expanded: boolean;
  /** Collapse / expand control; absent when the extension is always open or empty. */
  onToggleExpanded?: () => void;
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

const SLAB_INNER = 760 - 48;
const GAP = 3;
const SEP = 13;
const EXT_GAP_X = 12;
const EXT_GAP_Y = 14;
const EXT_TOP = 18;
const PAGER_H = 34;
/** The expand control sits in the slab's bottom padding. */
const HANDLE_H = 18;

/**
 * Heights the search slab animates between: the first row alone (R1.5: 64 + icon, 40 + icon
 * without labels) and the open extension below it.
 */
export function dockHeights(iconSize: number, labels: boolean, rows: number, pager: boolean) {
  const item = iconSize + (labels ? 27 : 0);
  const bottom = labels ? 15 : 18;
  const first = 22 + item + bottom;
  const grid = rows * item + (rows - 1) * EXT_GAP_Y;
  return { first, item, rowGap: EXT_GAP_Y, extension: EXT_TOP + grid + (pager ? PAGER_H : 0) + HANDLE_H - bottom };
}

/** Extension columns: the natural Dock cell with a little more air, as many as fit the slab. */
export function extensionCols(iconSize: number): number {
  return Math.max(5, Math.min(10, Math.floor((SLAB_INNER + EXT_GAP_X) / (iconSize + 12 + EXT_GAP_X))));
}

const itemClass = 'flex flex-col items-center gap-[9px] text-ink no-underline transition-transform duration-140 ease-soft';
const liftClass = 'hover:-translate-y-[3px] active:-translate-y-px active:scale-[.96]';

function focusDock(id: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-dock="${CSS.escape(id)}"]`)?.focus());
}

function Label({ name, labels, cell }: { name: string; labels: boolean; cell: number }) {
  if (!labels) return null;
  return (
    <span className="truncate text-[12px] text-ink/80" style={{ maxWidth: cell + 8 }}>
      {name}
    </span>
  );
}

type SiteProps = { app: AppEntry; index: number; total: number; cell: number; onReveal(id: string): void } & Pick<Props, 'edit' | 'iconSize' | 'labels' | 'onMenu' | 'onUnpin' | 'onMove'>;

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
        <Label name={app.name} labels={p.labels} cell={cell} />
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
  const { sites, extra, services, dockSize, edit, iconSize, labels, showBadges, expanded, rows, showPager } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const showAdd = edit && sites.length < dockSize;
  const cells = sites.length + (showAdd ? 1 : 0) + services.length + 1;
  const seps = services.length ? 2 : 1;
  const natural = iconSize + 12;
  const cell = Math.max(iconSize + 2, Math.min(natural, Math.floor((SLAB_INNER - (cells - 1) * GAP - seps * SEP) / cells)));

  const cols = extensionCols(iconSize);
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

  const siteProps = { edit, iconSize, labels, onMenu: props.onMenu, onUnpin: props.onUnpin, onMove: props.onMove, onReveal: reveal, total };

  return (
    <DndContext accessibility={dndAccessibility} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
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
            <Label name={s.app.name} labels={labels} cell={cell} />
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
          <Label name="全部应用" labels={labels} cell={cell} />
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

      {props.onToggleExpanded && (
        <button
          type="button"
          onClick={props.onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? '收起更多快捷方式' : `展开更多快捷方式（另有 ${extra.length} 个）`}
          title={expanded ? '收起' : `另有 ${extra.length} 个快捷方式`}
          className="group/handle absolute bottom-0 left-1/2 flex h-[18px] -translate-x-1/2 items-center gap-1.5 rounded-t-lg border-0 bg-transparent px-3 text-[11px] text-ink/30 transition-colors duration-200 hover:text-ink/80 focus-visible:text-ink/80 group-hover/slab:text-ink/55"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span className="tabular-nums">{expanded ? '收起' : `另有 ${extra.length} 个`}</span>
        </button>
      )}
    </DndContext>
  );
}
