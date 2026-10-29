import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { displayUrl, LOCKED_CATEGORY, type AppEntry, type Category, type Config, type Op } from '@nexus/shared';
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, Ellipsis, FolderInput, GripVertical, type LucideIcon } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useMemo, useState } from 'react';
import { ActionSheet, type SheetItem, type SheetState } from '../../../components/ActionSheet';
import { useConfig } from '../../../data/config-store';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { dndAccessibility } from '../../../lib/dnd';
import { apply } from '../model';
import { Tag, useCompact } from '../ui';

/** Category ids are prefixed in the shared drag space; app ids cannot contain `:`. */
const CAT = 'cat:';
const catKey = (id: string) => CAT + id;
const isCatKey = (id: string) => id.startsWith(CAT);

interface Order {
  cats: string[];
  apps: Record<string, string[]>;
}

function orderOf(c: Config): Order {
  return { cats: c.categories.map((k) => k.id), apps: Object.fromEntries(c.categories.map((k) => [k.id, c.apps.filter((a) => a.categoryId === k.id).map((a) => a.id)])) };
}

function containerOf(id: string, order: Order): string | undefined {
  if (isCatKey(id)) return id.slice(CAT.length);
  return order.cats.find((k) => order.apps[k]?.includes(id));
}

/** Same rule as the `app.move` op: services stay in 我的服务, sites never go there. */
const allowedIn = (app: AppEntry, categoryId: string) => (app.kind === 'service') === (categoryId === LOCKED_CATEGORY.hosted);

interface MoveItem {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  run(): void;
}

function appMoves(app: AppEntry, index: number, count: number): MoveItem[] {
  const to = (toIndex: number): Op => ({ type: 'app.move', appId: app.id, toIndex });
  const msg = `已移动「${app.name}」`;
  return [
    { label: '移到最前', icon: ArrowUpToLine, disabled: index === 0, run: () => apply(to(0), msg) },
    { label: '上移', icon: ChevronUp, disabled: index === 0, run: () => apply(to(index - 1), msg) },
    { label: '下移', icon: ChevronDown, disabled: index === count - 1, run: () => apply(to(index + 1), msg) },
    { label: '移到最后', icon: ArrowDownToLine, disabled: index === count - 1, run: () => apply(to(count - 1), msg) },
  ];
}

function categoryMoves(cat: Category, index: number, count: number): MoveItem[] {
  const to = (toIndex: number): Op => ({ type: 'category.move', categoryId: cat.id, toIndex });
  const msg = `已调整「${cat.label}」的位置`;
  return [
    { label: '移到最前', icon: ArrowUpToLine, disabled: index === 0, run: () => apply(to(0), msg) },
    { label: '上移', icon: ChevronUp, disabled: index === 0, run: () => apply(to(index - 1), msg) },
    { label: '下移', icon: ChevronDown, disabled: index === count - 1, run: () => apply(to(index + 1), msg) },
    { label: '移到最后', icon: ArrowDownToLine, disabled: index === count - 1, run: () => apply(to(count - 1), msg) },
  ];
}

const menuStyle = { background: 'rgba(40,38,34,0.97)', boxShadow: '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)' };
const itemClass = 'flex h-9 cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] outline-none data-[disabled]:cursor-default data-[disabled]:opacity-35 data-[highlighted]:bg-ink/8';

/** Desktop ⋯ menu: the non-drag way to reorder (R2 · 每个拖拽都有按钮替代). */
function MoveMenu({ label, moves, targets }: { label: string; moves: MoveItem[]; targets?: { label: string; run(): void }[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={label} className="grid size-8 flex-none place-items-center rounded-[9px] border-0 bg-transparent text-ink/75 hover:bg-ink/8 data-[state=open]:bg-ink/8">
        <Ellipsis className="size-[15px]" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-20 w-[200px] animate-[nx-pop_.14s_var(--ease-soft)] rounded-[14px] p-1.5 text-ink" style={menuStyle}>
          {moves.map((m) => (
            <DropdownMenu.Item key={m.label} disabled={m.disabled} onSelect={m.run} className={itemClass}>
              <m.icon className="size-3.5 opacity-80" />
              {m.label}
            </DropdownMenu.Item>
          ))}
          {targets && targets.length > 0 && (
            <>
              <DropdownMenu.Separator className="mx-2 my-1 h-px bg-ink/7" />
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className={itemClass}>
                  <FolderInput className="size-3.5 opacity-80" />
                  <span className="flex-1">移到分类</span>
                  <span className="text-ink/40">›</span>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent sideOffset={4} className="z-20 w-[180px] rounded-[14px] p-1.5 text-ink" style={menuStyle}>
                    {targets.map((t) => (
                      <DropdownMenu.Item key={t.label} onSelect={t.run} className={itemClass}>
                        {t.label}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Handle({ label, dndId, name, sortable }: { label: string; dndId: string; name: string; sortable: ReturnType<typeof useSortable> }) {
  const compact = useCompact();
  return (
    <button
      ref={sortable.setActivatorNodeRef}
      type="button"
      {...sortable.listeners}
      {...sortable.attributes}
      aria-label={label}
      data-dnd-id={dndId}
      data-dnd-name={name}
      className={cn('grid flex-none cursor-grab place-items-center border-0 bg-transparent text-ink/40 hover:text-ink/70', compact ? 'size-11 touch-manipulation' : 'h-9 w-7 touch-none')}
    >
      <GripVertical className="size-4" />
    </button>
  );
}

interface RowProps {
  app: AppEntry;
  index: number;
  count: number;
  targets: { label: string; run(): void }[];
  onSheet(s: SheetState): void;
}

function SortRow({ app, index, count, targets, onSheet }: RowProps) {
  const compact = useCompact();
  const s = useSortable({ id: app.id });
  const moves = appMoves(app, index, count);
  return (
    <div
      ref={s.setNodeRef}
      data-sort-app={app.id}
      className={cn('flex items-center gap-3', compact ? 'min-h-[58px] pr-1 pl-3.5' : 'h-[54px] pr-3 pl-2', s.isDragging && 'opacity-35')}
      style={{ transform: DndCSS.Translate.toString(s.transform), transition: s.transition }}
    >
      {!compact && <Handle label={`拖动排序 ${app.name}`} dndId={app.id} name={app.name} sortable={s} />}
      <AppTile target={{ kind: 'app', app }} size={compact ? 34 : 30} lazy style={app.hidden ? { opacity: 0.55 } : undefined} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('flex items-center gap-[7px]', compact ? 'text-[15px]' : 'text-[14px]', app.hidden && 'text-ink/60')}>
          <span className="truncate">{app.name}</span>
          {app.hidden && <Tag>已隐藏</Tag>}
        </span>
        <span className="truncate text-[12px] text-ink/44">{displayUrl(app.url)}</span>
      </span>
      {compact ? (
        <>
          <button
            type="button"
            aria-label={`${app.name} 的移动选项`}
            onClick={() =>
              onSheet({
                header: { target: { kind: 'app', app }, name: app.name, sub: '调整顺序或分类' },
                items: [...moves.map((m): SheetItem => ({ label: m.label, icon: m.icon, disabled: m.disabled, onSelect: m.run })), ...targets.map((t): SheetItem => ({ label: t.label, icon: FolderInput, onSelect: t.run }))],
              })
            }
            className="grid size-11 flex-none place-items-center border-0 bg-transparent text-ink/60"
          >
            <Ellipsis className="size-[18px]" />
          </button>
          <Handle label={`长按拖动排序 ${app.name}`} dndId={app.id} name={app.name} sortable={s} />
        </>
      ) : (
        <MoveMenu label={`${app.name} 的移动选项`} moves={moves} targets={targets} />
      )}
    </div>
  );
}

function CategoryHeader({ cat, index, count, n, onSheet }: { cat: Category; index: number; count: number; n: number; onSheet(s: SheetState): void }) {
  const compact = useCompact();
  const s = useSortable({ id: catKey(cat.id) });
  const moves = categoryMoves(cat, index, count);
  return (
    <div
      ref={s.setNodeRef}
      data-sort-cat={cat.id}
      className={cn('flex items-center gap-2 bg-ink/[0.035]', compact ? 'h-12 pr-1 pl-4' : 'h-11 pr-3 pl-2', s.isDragging && 'opacity-35')}
      style={{ transform: DndCSS.Translate.toString(s.transform), transition: s.transition }}
    >
      {!compact && <Handle label={`拖动分类 ${cat.label}`} dndId={catKey(cat.id)} name={`分类「${cat.label}」`} sortable={s} />}
      <span className="flex-1 text-[13px] font-medium text-ink/70">
        {cat.label}
        <span className="ml-2 text-[12px] font-normal text-ink/40">{n} 个</span>
      </span>
      {compact ? (
        <>
          <button
            type="button"
            aria-label={`分类「${cat.label}」的移动选项`}
            onClick={() => onSheet({ header: { target: { kind: 'all' }, name: cat.label, sub: '调整分类顺序' }, items: moves.map((m) => ({ label: m.label, icon: m.icon, disabled: m.disabled, onSelect: m.run })) })}
            className="grid size-11 flex-none place-items-center border-0 bg-transparent text-ink/60"
          >
            <Ellipsis className="size-[18px]" />
          </button>
          <Handle label={`长按拖动分类 ${cat.label}`} dndId={catKey(cat.id)} name={`分类「${cat.label}」`} sortable={s} />
        </>
      ) : (
        <MoveMenu label={`分类「${cat.label}」的移动选项`} moves={moves} />
      )}
    </div>
  );
}

/**
 * 应用与服务 · 排序模式: categories and the apps inside them in their real order (hidden ones too).
 * Drag a handle (long-press on touch), use the keyboard (space, arrows, space) or the ⋯ menu.
 * Every change is an ordinary op: it syncs to other devices and can be undone from the toast.
 */
export function SortMode() {
  const config = useConfig();
  const compact = useCompact();
  const base = useMemo(() => orderOf(config), [config]);
  const [drag, setDrag] = useState<{ id: string; order: Order } | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const order = drag?.order ?? base;
  const byId = useMemo(() => new Map(config.apps.map((a) => [a.id, a])), [config.apps]);
  const cats = order.cats.map((id) => config.categories.find((k) => k.id === id)!).filter(Boolean);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // Touch: a long press starts the drag, so a normal swipe still scrolls the list.
    useSensor(TouchSensor, { activationConstraint: { delay: 260, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Categories only collide with categories; apps with apps and with category headers (to reach
  // an empty category).
  const collision: CollisionDetection = (args) => {
    const cat = isCatKey(String(args.active.id));
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((d) => !cat || isCatKey(String(d.id))) });
  };

  const onStart = (e: DragStartEvent) => setDrag({ id: String(e.active.id), order: base });

  /** Moving across categories updates the local order so the placeholder follows the pointer. */
  const onOver = (e: DragOverEvent) => {
    const id = String(e.active.id);
    const over = e.over && String(e.over.id);
    if (!drag || isCatKey(id) || !over) return;
    const from = containerOf(id, drag.order);
    const to = containerOf(over, drag.order);
    const app = byId.get(id);
    if (!from || !to || from === to || !app || !allowedIn(app, to)) return;
    const target = drag.order.apps[to]!;
    const at = isCatKey(over) ? 0 : Math.max(0, target.indexOf(over));
    setDrag({
      id,
      order: { ...drag.order, apps: { ...drag.order.apps, [from]: drag.order.apps[from]!.filter((x) => x !== id), [to]: [...target.slice(0, at), id, ...target.slice(at)] } },
    });
  };

  const onEnd = (e: DragEndEvent) => {
    const current = drag?.order ?? base;
    setDrag(null);
    const id = String(e.active.id);
    const over = e.over && String(e.over.id);
    if (!over) return;
    if (isCatKey(id)) {
      const to = containerOf(over, current);
      const toIndex = to ? base.cats.indexOf(to) : -1;
      const cat = config.categories.find((k) => catKey(k.id) === id);
      if (cat && toIndex >= 0) apply({ type: 'category.move', categoryId: cat.id, toIndex }, `已调整「${cat.label}」的位置`);
      return;
    }
    const app = byId.get(id);
    const to = containerOf(id, current);
    if (!app || !to) return;
    let list = current.apps[to]!;
    // Dropped on its category's header: first in that category.
    if (isCatKey(over)) list = containerOf(over, current) === to ? [id, ...list.filter((x) => x !== id)] : list;
    else if (list.includes(over)) list = arrayMove(list, list.indexOf(id), list.indexOf(over));
    apply({ type: 'app.move', appId: id, categoryId: to, toIndex: list.indexOf(id) }, `已移动「${app.name}」`);
  };

  const active = drag && (isCatKey(drag.id) ? null : byId.get(drag.id));
  const activeCat = drag && isCatKey(drag.id) ? config.categories.find((k) => catKey(k.id) === drag.id) : null;

  return (
    <>
      <DndContext accessibility={dndAccessibility} sensors={sensors} collisionDetection={collision} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setDrag(null)}>
        <SortableContext items={order.cats.map(catKey)} strategy={verticalListSortingStrategy}>
          <div className={cn('flex flex-col overflow-hidden', compact ? 'rounded-2xl bg-ink/6' : 'rounded-[20px] bg-ink/[0.045] shadow-[inset_0_0_0_1px_rgba(239,234,225,0.05)]')}>
            {cats.map((cat, ci) => {
              const ids = order.apps[cat.id] ?? [];
              const apps = ids.map((id) => byId.get(id)!).filter(Boolean);
              return (
                <section key={cat.id} aria-label={cat.label} className={cn(ci > 0 && 'border-t border-ink/7')}>
                  <CategoryHeader cat={cat} index={ci} count={cats.length} n={apps.length} onSheet={setSheet} />
                  <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                    <div className="flex min-h-2 flex-col divide-y divide-ink/5">
                      {apps.map((a, i) => (
                        <SortRow
                          key={a.id}
                          app={a}
                          index={i}
                          count={apps.length}
                          onSheet={setSheet}
                          targets={cats
                            .filter((k) => k.id !== cat.id && allowedIn(a, k.id))
                            .map((k) => ({ label: `移到「${k.label}」`, run: () => apply({ type: 'app.move', appId: a.id, categoryId: k.id, toIndex: order.apps[k.id]?.length ?? 0 }, `已将「${a.name}」移到「${k.label}」`) }))}
                        />
                      ))}
                      {!apps.length && <div className={cn('text-[12.5px] text-ink/40', compact ? 'px-4 py-3' : 'py-3 pl-11')}>空分类 · 可把应用拖到这里</div>}
                    </div>
                  </SortableContext>
                </section>
              );
            })}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {active ? (
            <div className="flex h-[54px] items-center gap-3 rounded-xl pr-3 pl-4 text-[14px] text-ink" style={{ ...menuStyle, cursor: 'grabbing' }}>
              <AppTile target={{ kind: 'app', app: active }} size={30} />
              {active.name}
            </div>
          ) : activeCat ? (
            <div className="flex h-11 items-center rounded-xl px-4 text-[13px] font-medium text-ink/80" style={{ ...menuStyle, cursor: 'grabbing' }}>
              {activeCat.label}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <ActionSheet sheet={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
