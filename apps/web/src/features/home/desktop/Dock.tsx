import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { hostOf } from '@nexus/shared';
import type { AppEntry } from '@nexus/shared';
import { Plus } from 'lucide-react';
import type { KeyboardEvent, MouseEvent, Ref } from 'react';
import type { ServiceView } from '../../../data/status';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { appLinkProps, recordAppOpen } from '../../../lib/open';

export type MenuSource = 'dock' | 'drawer' | 'hosted';

interface Props {
  sites: AppEntry[];
  services: ServiceView[];
  dockSize: number;
  edit: boolean;
  iconSize: number;
  labels: boolean;
  showBadges: boolean;
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

function DockSite(p: { app: AppEntry; index: number; total: number; cell: number } & Pick<Props, 'edit' | 'iconSize' | 'labels' | 'onMenu' | 'onUnpin' | 'onMove'>) {
  const { app, edit, cell, iconSize, index, total } = p;
  const s = useSortable({ id: app.id, disabled: !edit });
  const onKey = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (!edit) return;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      p.onMove(app.id, e.key === 'ArrowLeft' ? -1 : 1);
      focusDock(app.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      p.onUnpin(app.id);
    }
  };
  return (
    <div
      ref={s.setNodeRef}
      {...(edit ? s.listeners : {})}
      className={cn('relative flex-none', edit && 'cursor-grab touch-none', s.isDragging && 'z-10 cursor-grabbing')}
      style={{ width: cell, transform: DndCSS.Translate.toString(s.transform), transition: s.transition, opacity: s.isDragging ? 0.6 : 1 }}
    >
      <a
        {...appLinkProps(app)}
        data-dock={app.id}
        title={hostOf(app.url)}
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

function Separator() {
  return <span aria-hidden className="mx-1.5 mt-2 h-10 w-px flex-none bg-ink/14" />;
}

export function Dock(props: Props) {
  const { sites, services, dockSize, edit, iconSize, labels, showBadges } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const showAdd = edit && sites.length < dockSize;
  const cells = sites.length + (showAdd ? 1 : 0) + services.length + 1;
  const seps = services.length ? 2 : 1;
  const natural = iconSize + 12;
  const cell = Math.max(iconSize + 2, Math.min(natural, Math.floor((SLAB_INNER - (cells - 1) * GAP - seps * SEP) / cells)));

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const to = sites.findIndex((a) => a.id === e.over!.id);
    if (to >= 0) props.onMoveTo(String(e.active.id), to);
  };

  return (
    <div className="flex items-start justify-center px-6 pt-[22px]" style={{ gap: GAP }}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sites.map((a) => a.id)} strategy={horizontalListSortingStrategy}>
          {sites.map((app, i) => (
            <DockSite key={app.id} app={app} index={i} total={sites.length} cell={cell} {...props} />
          ))}
        </SortableContext>
      </DndContext>
      {showAdd && (
        <button type="button" onClick={props.onOpenDrawer} className={cn(itemClass, 'flex-none border-0 bg-transparent p-0')} style={{ width: cell }}>
          <span className="grid place-items-center border-[1.5px] border-dashed border-ink/32" style={{ width: iconSize, height: iconSize, borderRadius: Math.round(iconSize * 0.285) }}>
            <Plus className="size-5 text-ink/70" />
          </span>
          {labels && <span className="text-[12px] whitespace-nowrap text-ink/60">{`添加 ${sites.length}/${dockSize}`}</span>}
        </button>
      )}
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
  );
}
