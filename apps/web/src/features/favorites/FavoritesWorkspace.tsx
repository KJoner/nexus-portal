import {
  closestCenter,
  DndContext,
  DragOverlay,
  getClientRect,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type Modifier,
} from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { groupTree, hostOf, itemUrlKey, MAX_PINS, UNFILED, type Category, type GroupNode, type Item } from '@nexus/shared';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bookmark,
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronRight,
  Download,
  Folder,
  FolderInput,
  FolderPlus,
  GripVertical,
  LayoutGrid,
  List,
  ListTree,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Server,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import { ActionSheet, type SheetState } from '../../components/ActionSheet';
import { ContextMenu, type MenuItem, type MenuState } from '../../components/ContextMenu';
import { toast } from '../../components/toast-store';
import { currentTransport, useConfig, useConfigStore, useSaveState } from '../../data/config-store';
import { libraryApi, loadLibrary, loadTrash, pinNotice, useLibrary, type WriteOutcome } from '../../data/library';
import { AppTile } from '../../icons/AppTile';
import { cn } from '../../lib/cn';
import { dndAccessibilityWith } from '../../lib/dnd';
import { host } from '../../lib/host';
import { openApp } from '../../lib/open';
import { usePinyin } from '../../lib/pinyin';
import { storage } from '../../lib/storage';
import { apply } from '../settings/model';
import { Button, Dialog, Spinner, useCompact } from '../settings/ui';
import { openAddFavorite, openEditFavorite } from './dialog-store';
import FavoriteDialogs from './FavoriteDialogs';
import { GroupDialog, type GroupTask } from './GroupDialogs';
import { ConflictLine, ImportDialog } from './ImportDialog';
import { asApp, byPosition, canReorder, dropAnchor, groupCounts, inView, isService, matches, parseView, pathLabel, SORT_LABEL, sortItems, treeDropMove, treeDropProblem, treeZone, viewKey, type SortMode, type TreeZone, type View } from './model';
import { GroupSelect } from './parts';

/**
 * 我的收藏 (UI v2 · v12.0.3 N1–N4): the one place every favorite is managed — opened from the home
 * page and from 设置, the same page either way (/settings/favorites). A group tree with the system
 * views, a toolbar (search the whole collection with full group paths, view order, list / grid,
 * 添加收藏, 更多), rows that show name, group and pin, and one editor for every property. Three
 * orders stay apart: groups among siblings (drag in the tree, or its menu), favorites inside a
 * group (drag in the list or the grid, or 上移 / 下移 / 移动到 — no long press needed), and the
 * home page's pins (首页快捷方式 view, or 首页与外观 › 快捷方式). Sorting by name or date only
 * changes the view. On a desktop favorites can also be dragged onto a group of the tree (the
 * selected ones with them); every drag has a menu path, and a phone uses only those.
 */
const MODE_KEY = 'nexus.favorites.mode.v1';
const VIEW_LABEL: Record<Exclude<View['kind'], 'group'>, string> = { all: '全部收藏', pinned: '首页快捷方式', services: '服务', unfiled: '未分组', trash: '回收站' };

function useLibraryReady() {
  const status = useLibrary((s) => s.status);
  useEffect(() => {
    if (status === 'idle') void loadLibrary();
  }, [status]);
  useEffect(() => {
    // Back to the tab: what changed elsewhere meanwhile.
    const on = () => document.visibilityState === 'visible' && useLibrary.getState().status === 'ready' && void loadLibrary();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return status;
}

/** Tells the person what a refused write means; true when it went through. */
function report(r: WriteOutcome, done?: string): boolean {
  if (r.ok) {
    const notice = pinNotice(r.pin);
    if (notice) toast({ msg: notice, tone: 'warn' });
    else if (r.queued) toast({ msg: '已离线保存，联网后自动同步', tone: 'warn' });
    else if (done) toast({ msg: done, tone: 'ok' });
    return true;
  }
  if (r.code === 'ORDER_CONFLICT' || r.code === 'FIELD_CONFLICT') {
    toast({ msg: '这个分组的顺序刚在别处变过，已刷新为最新顺序，请再试一次', tone: 'warn' });
    void loadLibrary();
  } else toast({ msg: `没有完成：${r.message}`, tone: 'error' });
  return false;
}

export function FavoritesWorkspace() {
  const config = useConfig();
  const categories = config.categories;
  const status = useLibraryReady();
  const error = useLibrary((s) => s.error);
  const byId = useLibrary((s) => s.items);
  const pins = useLibrary((s) => s.pins);
  const conflicts = useLibrary((s) => s.conflicts);
  const trashState = useLibrary((s) => s.trash);
  const pinyin = usePinyin((s) => s.fn);
  const compact = useCompact();
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get('view'));
  const query = params.get('q') ?? '';
  const [mode, setModeState] = useState<'list' | 'grid'>(() => (storage.get<string>(MODE_KEY) === 'grid' ? 'grid' : 'list'));
  const [sort, setSort] = useState<SortMode>('manual');
  const [withSub, setWithSub] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [groupTask, setGroupTask] = useState<GroupTask | null>(null);
  const [importing, setImporting] = useState(false);
  const [moving, setMoving] = useState<Item[] | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [treeSheet, setTreeSheet] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const setMode = (m: 'list' | 'grid') => {
    setModeState(m);
    storage.set(MODE_KEY, m);
  };
  const setParam = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const setView = (v: View) => {
    setSelected(new Set());
    setWithSub(false);
    setParam('view', v.kind === 'all' ? null : viewKey(v));
    setTreeSheet(false);
  };

  // Old links and 快速打开: ?edit=<id> opens the editor, ?add=manual|store the add dialog (prefilled),
  // ?import=1 (数据与备份 › 导入收藏或浏览器书签, old /library?import=1) the import dialog.
  useEffect(() => {
    const edit = params.get('edit');
    const add = params.get('add');
    const imp = params.get('import') === '1';
    if (!edit && add === null && !imp) return;
    if (imp) setImporting(true);
    else if (edit) openEditFavorite(edit);
    else openAddFavorite({ tab: add === 'store' ? 'store' : 'manual', q: params.get('sq') ?? '', title: params.get('title') ?? '', url: params.get('url') ?? '', ...(view.kind === 'group' ? { folderId: view.id } : {}) });
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const k of ['edit', 'add', 'sq', 'title', 'url', 'import']) n.delete(k);
        return n;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const all = useMemo(() => Object.values(byId), [byId]);
  const live = useMemo(() => all.filter((i) => i.deletedAt === null), [all]);
  const trash = useMemo(() => all.filter((i) => i.deletedAt !== null), [all]);
  const pinSet = useMemo(() => new Set(pins), [pins]);
  const counts = useMemo(() => groupCounts(categories, live), [categories, live]);
  const tree = useMemo(() => groupTree(categories), [categories]);
  const services = live.filter(isService).length;
  const current = view.kind === 'group' ? categories.find((c) => c.id === view.id) : null;
  const effective: View = view.kind === 'group' && !current ? { kind: 'all' } : view;
  // Search covers the whole collection (spec 02 N2), whatever view is open.
  const searching = !!query.trim();
  const shown = useMemo(() => {
    const ctx = { pins: pinSet, categories, withSub };
    const base = searching ? live.filter((i) => matches(i, query, pinyin)) : all.filter((i) => inView(i, effective, ctx));
    return sortItems(base, effective.kind === 'trash' ? 'updated' : sort, { pins, categories, view: effective });
  }, [all, live, effective, pinSet, categories, withSub, searching, query, pinyin, sort, pins]);
  const reorder = canReorder(effective, sort, query, withSub);
  const groupIdOfView = effective.kind === 'group' ? effective.id : effective.kind === 'unfiled' ? UNFILED : null;
  const title = searching ? `搜索「${query.trim()}」` : effective.kind === 'group' ? pathLabel(categories, effective.id) : VIEW_LABEL[effective.kind];
  const hasChildren = effective.kind === 'group' && categories.some((c) => (c.parentId ?? null) === effective.id);
  const chosen = shown.filter((i) => selected.has(i.id) && i.deletedAt === null);
  const existingUrls = useMemo(() => new Set(live.map((i) => itemUrlKey(i.url))), [live]);

  // ── item actions ────────────────────────────────────────────────────────
  const pinToggle = async (i: Item) => {
    if (pinSet.has(i.id)) return void report(await libraryApi.unpin(i), `已从首页移除「${i.title}」`);
    if (i.app?.hidden) return toast({ msg: '隐藏的收藏不能固定到首页；先在编辑里取消隐藏', tone: 'warn' });
    if (pins.length >= MAX_PINS) return toast({ msg: `首页已经固定满 ${MAX_PINS} 个，先取消固定一个`, tone: 'warn' });
    report(await libraryApi.pin(i), `已把「${i.title}」固定到首页`);
  };
  const trashItems = async (list: Item[]) => {
    const done: Item[] = [];
    for (const i of list) {
      const r = await libraryApi.remove(i);
      if (r.ok && r.item) done.push(r.item);
      else if (!r.ok) toast({ msg: `「${i.title}」没有移到回收站：${r.message}`, tone: 'error' });
    }
    setSelected(new Set());
    if (done.length) toast({ msg: done.length === 1 ? `已把「${done[0]!.title}」移到回收站` : `已把 ${done.length} 个收藏移到回收站`, tone: 'info', action: { label: '撤销', run: () => void Promise.all(done.map((i) => libraryApi.restore(i))).then(() => toast({ msg: '已恢复', tone: 'ok' })) } });
  };
  /** Said with where it really went: the server's answer (a group deleted since files it under the nearest one left). */
  const restore = async (i: Item) => {
    const r = await libraryApi.restore(i);
    return report(r, `已恢复「${i.title}」到「${pathLabel(categories, (r.ok && r.item?.folderId) || i.folderId)}」`);
  };
  /** One step inside its group's own order (the anchor is a neighbour; no drag needed). */
  const step = async (i: Item, to: 'up' | 'down' | 'first' | 'last') => {
    const siblings = live.filter((x) => (x.folderId || UNFILED) === (i.folderId || UNFILED)).sort(byPosition);
    const k = siblings.findIndex((x) => x.id === i.id);
    const others = siblings.filter((x) => x.id !== i.id);
    const target = to === 'first' ? 0 : to === 'last' ? others.length : to === 'up' ? Math.max(0, k - 1) : Math.min(others.length, k + 1);
    if (target === k) return;
    const afterId = target === 0 ? null : others[target - 1]!.id;
    report(await libraryApi.moveItems([i], i.folderId || UNFILED, afterId), `已移动「${i.title}」`);
  };
  const moveInto = async (list: Item[], folderId: string) => {
    if (!list.length) return;
    const ok = report(await libraryApi.moveItems(list, folderId), list.length === 1 ? `已移到「${pathLabel(categories, folderId)}」` : `已把 ${list.length} 个收藏移到「${pathLabel(categories, folderId)}」`);
    if (ok) setSelected(new Set());
  };
  const pinMany = async (list: Item[], on: boolean) => {
    let refused = 0;
    let done = 0;
    for (const i of list) {
      if (on === pinSet.has(i.id)) continue;
      const r = on ? await libraryApi.pin(i) : await libraryApi.unpin(i);
      if (!r.ok || (r.pin && !r.pin.pinned)) refused++;
      else done++;
    }
    setSelected(new Set());
    toast(refused ? { msg: `${done} 个已${on ? '固定' : '取消固定'}；${refused} 个没有固定（首页最多 ${MAX_PINS} 个，或是隐藏的收藏）`, tone: 'warn' } : { msg: on ? `已固定 ${done} 个到首页` : `已取消固定 ${done} 个`, tone: 'ok' });
  };
  /** What a drag of this favorite carries: every selected one when it is one of them, else itself. */
  const carried = (id: string): Item[] => {
    const one = byId[id];
    if (!one) return [];
    return selected.has(id) && chosen.length > 1 && chosen.some((x) => x.id === id) ? chosen : [one];
  };
  /** Dropped on a row of the list or the grid: the same anchor as 上移 / 下移 (moveItems afterId). */
  const dropOnRow = (activeId: string, overId: string) => {
    if (activeId === overId || !groupIdOfView || !reorder) return;
    const ids = shown.map((x) => x.id);
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    const moving = carried(activeId);
    const set = new Set(moving.map((x) => x.id));
    const afterId = dropAnchor(ids, set, from, to);
    const block = shown.filter((x) => set.has(x.id));
    // Said out loud as well (a status toast), like the moves from the ⋯ menu.
    void libraryApi.moveItems(block, groupIdOfView, afterId).then((r) => report(r, block.length === 1 ? `已移动「${block[0]!.title}」` : `已移动 ${block.length} 个收藏`));
  };
  /** Dropped on a group of the tree (or 未分组): what 移动到分组… does, with the same words. */
  const dropOnGroup = (activeId: string, folderId: string) => {
    const moving = carried(activeId).filter((x) => (x.folderId || UNFILED) !== folderId);
    if (!moving.length) return toast({ msg: `已经在「${pathLabel(categories, folderId)}」里`, tone: 'info' });
    void moveInto(moving, folderId);
  };

  const actions = (i: Item): { label: string; icon: LucideIcon; onSelect(): void; disabled?: boolean; danger?: boolean }[] => {
    if (i.deletedAt !== null) return [{ label: '恢复', icon: RotateCcw, onSelect: () => void restore(i) }];
    const siblings = live.filter((x) => (x.folderId || UNFILED) === (i.folderId || UNFILED)).sort(byPosition);
    const k = siblings.findIndex((x) => x.id === i.id);
    return [
      { label: '编辑', icon: Pencil, onSelect: () => openEditFavorite(i.id) },
      { label: '打开', icon: ArrowUpRight, onSelect: () => openApp(asApp(i), true) },
      pinSet.has(i.id) ? { label: '从首页取消固定', icon: PinOff, onSelect: () => void pinToggle(i) } : { label: '固定到首页', icon: Pin, disabled: !!i.app?.hidden, onSelect: () => void pinToggle(i) },
      { label: '在分组里上移', icon: ArrowUp, disabled: k <= 0, onSelect: () => void step(i, 'up') },
      { label: '在分组里下移', icon: ArrowDown, disabled: k < 0 || k >= siblings.length - 1, onSelect: () => void step(i, 'down') },
      { label: '移到分组最前', icon: ChevronFirst, disabled: k <= 0, onSelect: () => void step(i, 'first') },
      { label: '移到分组最后', icon: ChevronLast, disabled: k < 0 || k >= siblings.length - 1, onSelect: () => void step(i, 'last') },
      { label: '移动到分组…', icon: FolderInput, onSelect: () => setMoving([i]) },
      { label: '移到回收站', icon: Trash2, danger: true, onSelect: () => void trashItems([i]) },
    ];
  };
  const openActions = (i: Item, el: HTMLElement) => {
    const header = { target: { kind: 'app' as const, app: asApp(i) }, name: i.title, sub: `${hostOf(i.url)} · ${pathLabel(categories, i.folderId)}` };
    if (compact) return setSheet({ header, items: actions(i).map((a) => ({ ...a, onSelect: () => a.onSelect() })) });
    const r = el.getBoundingClientRect();
    const items: MenuItem[] = [];
    actions(i).forEach((a, n) => {
      if (n === 3 || n === 7) items.push('sep');
      items.push(a);
    });
    setMenu({ x: Math.max(8, r.right - 240), y: r.bottom + 4, header, items, keyboard: true, origin: el });
  };

  const exportAll = async () => {
    try {
      const data = await currentTransport().items.exportAll();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = `nexus-collection-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast({ msg: '已导出我的收藏（v3 备份：分组层级、顺序、图标与固定都在里面）', tone: 'ok' });
    } catch (e) {
      toast({ msg: `导出失败：${e instanceof Error ? e.message : String(e)}`, tone: 'error' });
    }
  };
  const readOnly = host.readOnly;

  // ── tree ────────────────────────────────────────────────────────────────
  const groupMenu = (g: GroupNode, el: HTMLElement) => {
    const siblings = categories.filter((c) => (c.parentId ?? null) === g.parentId && c.id !== UNFILED);
    const k = siblings.findIndex((c) => c.id === g.id);
    const items = [
      { label: '新建子分组', icon: FolderPlus, onSelect: () => setGroupTask({ kind: 'create', parentId: g.id }) },
      { label: '重命名', icon: Pencil, onSelect: () => setGroupTask({ kind: 'rename', id: g.id }) },
      { label: '移动到…', icon: FolderInput, onSelect: () => setGroupTask({ kind: 'move', id: g.id }) },
      { label: '上移', icon: ArrowUp, disabled: k <= 0, onSelect: () => dispatchMove(g, k - 1) },
      { label: '下移', icon: ArrowDown, disabled: k < 0 || k >= siblings.length - 1, onSelect: () => dispatchMove(g, k + 1) },
      { label: '移到最前', icon: ChevronFirst, disabled: k <= 0, onSelect: () => dispatchMove(g, 0) },
      { label: '移到最后', icon: ChevronLast, disabled: k < 0 || k >= siblings.length - 1, onSelect: () => dispatchMove(g, siblings.length - 1) },
      { label: '删除分组…', icon: Trash2, danger: true, onSelect: () => setGroupTask({ kind: 'delete', id: g.id }) },
    ];
    const header = { target: { kind: 'system' as const, icon: Folder }, name: g.label, sub: g.path.join(' / ') };
    if (compact) return setSheet({ header, items });
    const r = el.getBoundingClientRect();
    setMenu({ x: Math.min(window.innerWidth - 248, r.left), y: r.bottom + 4, header, items: [...items.slice(0, 3), 'sep', ...items.slice(3, 7), 'sep', items[7]!], keyboard: true, origin: el });
  };
  /** Sibling order of groups (its own order: favorites and pins are untouched); with 撤销. */
  const dispatchMove = (g: GroupNode, index: number) => apply({ type: 'group.move', groupId: g.id, parentId: g.parentId, index }, `已调整「${g.label}」的位置`);

  // ── drag (desktop): groups in the tree, favorites in the list / grid and onto the tree ────────
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<DragData | null>(null);
  const [hint, setHint] = useState<DropHint | null>(null);
  const hintRef = useRef<DropHint | null>(null);
  const lastHint = useRef<DropHint | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const treeBox = useRef<HTMLElement | null>(null);
  const expand = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const dnd = !compact && !readOnly;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: rowsOnlyKeyboard }));
  const collide = useMemo(() => treeAwareCollisions(treeBox), []);

  const showHint = (h: DropHint | null) => {
    hintRef.current = h;
    setHint((was) => (was?.key === h?.key ? was : h));
  };
  /** Where the drag would land now, said in words (the tree draws it; screen readers hear it). */
  const hintFor = (active: DragData, over: DragOverEvent['over']): DropHint | null => {
    const data = over?.data.current as DropData | undefined;
    if (!over || data?.kind !== 'tree') return null;
    if (active.kind === 'item') {
      const moving = carried(active.id).filter((x) => (x.folderId || UNFILED) !== data.groupId);
      const where = pathLabel(categories, data.groupId);
      if (!moving.length) return { key: `i:${data.groupId}:same`, target: data.groupId, zone: null, ok: false, neutral: true, text: `已经在「${where}」里` };
      return { key: `i:${data.groupId}:${moving.length}`, target: data.groupId, zone: null, ok: true, text: moving.length === 1 ? `把「${moving[0]!.title}」移到「${where}」` : `把 ${moving.length} 个收藏移到「${where}」` };
    }
    const g = categories.find((c) => c.id === active.id);
    const target = categories.find((c) => c.id === data.groupId);
    if (!g || !target) return null;
    if (g.id === target.id) return { key: `g:${g.id}:self`, target: g.id, zone: null, ok: false, neutral: true, text: '放回原处' };
    const y = pointer.current?.y ?? over.rect.top + over.rect.height / 2;
    const zone = treeZone(y, over.rect.top, over.rect.height, !target.locked);
    const open = !collapsed.has(target.id);
    const move = treeDropMove(categories, g.id, target.id, zone, open);
    if (!move) return null;
    const firstChild = zone === 'after' && move.parentId === target.id;
    const key = `g:${target.id}:${zone}:${firstChild}`;
    // Where it already is (group.move would change nothing): said so, and nothing is sent.
    const now = categories.filter((c) => c.id !== UNFILED && (c.parentId ?? null) === (g.parentId ?? null));
    const at = move.index ?? categories.filter((c) => c.id !== UNFILED && c.id !== g.id && (c.parentId ?? null) === move.parentId).length;
    if ((g.parentId ?? null) === move.parentId && now.indexOf(g) === at) return { key: `${key}:same`, target: target.id, zone, firstChild, ok: false, neutral: true, text: '位置不变' };
    const problem = treeDropProblem(categories, g.id, move.parentId);
    if (problem) return { key, target: target.id, zone, firstChild, ok: false, text: `不能放在这里：${problem}`, move };
    const level = move.parentId ? `「${pathLabel(categories, move.parentId)}」里` : '顶层';
    const text = zone === 'inside' ? `把「${g.label}」放进「${target.label}」，作为子分组` : firstChild ? `把「${g.label}」放进「${target.label}」，作为第一个子分组` : `把「${g.label}」放到「${target.label}」${zone === 'before' ? '前面' : '后面'}（${level}）`;
    return { key, target: target.id, zone, firstChild, ok: true, text, move };
  };
  /** A collapsed group under the pointer opens after a moment, so its subgroups can be reached. */
  const expandLater = (id: string | null) => {
    if (expand.current?.id === id) return;
    if (expand.current) clearTimeout(expand.current.timer);
    expand.current = id && collapsed.has(id) && categories.some((c) => (c.parentId ?? null) === id) ? { id, timer: setTimeout(() => setCollapsed((s) => toggleSet(s, id, false)), 700) } : null;
  };
  // One function for the whole page life: the listener added when a drag starts is the one removed.
  const trackPointer = useMemo(
    () => (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    },
    [],
  );
  const endDrag = () => {
    window.removeEventListener('pointermove', trackPointer, true);
    expandLater(null);
    pointer.current = null;
    setDrag(null);
    showHint(null);
  };
  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as DragData | undefined;
    if (!data) return;
    const start = e.activatorEvent as PointerEvent | KeyboardEvent;
    if ('clientY' in start) pointer.current = { x: start.clientX, y: start.clientY };
    window.addEventListener('pointermove', trackPointer, true);
    setDrag(data.kind === 'item' ? { ...data, count: carried(data.id).length } : data);
    lastHint.current = null;
  };
  const onDragOver = (e: DragOverEvent) => {
    const data = e.active.data.current as DragData | undefined;
    if (!data) return;
    const h = hintFor(data, e.over);
    showHint(h);
    expandLater(h ? h.target : null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const data = e.active.data.current as DragData | undefined;
    const h = data ? hintFor(data, e.over) : null;
    lastHint.current = h;
    endDrag();
    if (!data || !e.over) return;
    const over = e.over.data.current as DropData | undefined;
    if (data.kind === 'item') {
      if (over?.kind === 'tree') dropOnGroup(data.id, over.groupId);
      else if (over?.kind === 'item') dropOnRow(data.id, over.id);
      return;
    }
    // A group: always through group.move — its rules decide, and its refusal is what is said.
    if (over?.kind !== 'tree' || !h?.move) return;
    const g = categories.find((c) => c.id === data.id)!;
    const moved = (g.parentId ?? null) !== h.move.parentId;
    const newPath = [...(h.move.parentId ? [pathLabel(categories, h.move.parentId)] : []), g.label].join(' / ');
    apply({ type: 'group.move', groupId: g.id, parentId: h.move.parentId, ...(h.move.index !== undefined ? { index: h.move.index } : {}) }, moved ? `已把「${g.label}」移到「${newPath}」` : `已调整「${g.label}」的位置`);
  };
  const accessibility = dndAccessibilityWith((phase) => (phase === 'over' ? hintRef.current : lastHint.current)?.text ?? null);
  useEffect(() => () => window.removeEventListener('pointermove', trackPointer, true), [trackPointer]);

  const treeView = (
    <GroupTreePanel
      tree={tree}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      dnd={dnd}
      drag={drag}
      hint={hint}
      boxRef={(el) => {
        treeBox.current = el;
      }}
      view={effective}
      counts={counts}
      total={live.length}
      pinned={pins.filter((id) => byId[id] && byId[id]!.deletedAt === null).length}
      services={services}
      unfiled={live.filter((i) => inView(i, { kind: 'unfiled' }, { pins: pinSet, categories, withSub: false })).length}
      trash={trash.length}
      compact={compact}
      readOnly={readOnly}
      onView={setView}
      onNewGroup={() => setGroupTask({ kind: 'create', parentId: effective.kind === 'group' ? effective.id : null })}
      onGroupMenu={groupMenu}
    />
  );

  const syncLine = <SyncLine />;
  // 回收站 holds what was deleted before this page was opened too (the snapshot has live favorites
  // only): read when 回收站 is opened — it can be thousands (an undone import), so not on every visit.
  useEffect(() => {
    if (status === 'ready' && trashState === 'idle' && effective.kind === 'trash') void loadTrash();
  }, [status, trashState, effective.kind]);
  // 回收站 not read yet (or not readable now): never called empty while that is unknown.
  const trashUnknown = effective.kind === 'trash' && !searching && trashState !== 'ready';
  const empty = status === 'ready' && shown.length === 0 && !trashUnknown;

  const dragItem = drag?.kind === 'item' ? byId[drag.id] : undefined;
  const dragGroup = drag?.kind === 'group' ? categories.find((c) => c.id === drag.id) : undefined;
  const canDrag = dnd && effective.kind !== 'trash';

  return (
    <DndContext accessibility={accessibility} sensors={sensors} collisionDetection={collide} measuring={MEASURING} onDragStart={onDragStart} onDragMove={onDragOver} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={endDrag}>
    <div className={cn('flex min-h-0 flex-col', compact ? 'gap-4' : 'gap-6')}>
      {!compact && (
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-[12px] tracking-[0.06em] text-ink/50">一处收藏，有序安放</span>
            <h1 className="m-0 flex items-center gap-3 text-[28px] font-semibold tracking-[-0.02em]">
              我的收藏
              <span className="rounded-md bg-ink/9 px-2 py-0.5 text-[12.5px] font-normal text-ink/66 tabular-nums">{live.length}</span>
            </h1>
            <p className="m-0 text-[13.5px] text-ink/56">网站、网页与自己的服务，都收在这里。</p>
          </div>
          {!readOnly && (
            <>
              <div className="relative">
                <Button aria-label="更多：导入、导出、管理分组" aria-expanded={moreOpen} className="size-10 p-0" onClick={() => setMoreOpen((v) => !v)}>
                  <MoreHorizontal className="size-[18px]" />
                </Button>
                {moreOpen && (
                  <MoreMenu
                    onClose={() => setMoreOpen(false)}
                    items={[
                      { label: '导入书签或备份…', icon: Upload, onSelect: () => setImporting(true) },
                      { label: '导出我的收藏', icon: Download, onSelect: () => void exportAll() },
                      { label: '新建分组…', icon: FolderPlus, onSelect: () => setGroupTask({ kind: 'create', parentId: null }) },
                    ]}
                  />
                )}
              </div>
              <Button variant="primary" className="h-10 px-4" onClick={() => openAddFavorite({ ...(effective.kind === 'group' ? { folderId: effective.id } : {}) })}>
                <Plus className="size-4" />
                添加收藏
              </Button>
            </>
          )}
        </div>
      )}

      {conflicts.length > 0 && (
        <section aria-label="需要你决定的离线更改" className="flex flex-col gap-2 rounded-2xl p-4" style={{ background: 'rgb(var(--nx-amber-rgb)/0.08)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-amber-rgb)/0.3)' }}>
          <span className="text-[13.5px] font-medium">有 {conflicts.length} 项离线时的更改需要你决定</span>
          {conflicts.map((c, k) => (
            <ConflictLine key={`${c.op.opId}-${c.at}`} conflict={c} index={k} />
          ))}
        </section>
      )}

      <div className={cn('flex min-h-0 overflow-hidden', compact ? 'flex-col gap-3' : 'rounded-[18px]')} style={compact ? undefined : { background: 'rgb(var(--nx-ink-rgb)/0.035)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.08)' }}>
        {!compact && <aside className="flex w-[198px] flex-none flex-col border-r border-ink/8">{treeView}</aside>}
        <section aria-label={title} className="flex min-w-0 flex-1 flex-col">
          <div className={cn('flex flex-wrap items-center gap-2', compact ? '' : 'px-5 pt-4 pb-3')}>
            {compact && (
              <button type="button" onClick={() => setTreeSheet(true)} aria-haspopup="dialog" className="flex h-11 min-w-0 items-center gap-2 rounded-xl border-0 bg-ink/8 px-3.5 text-[15px] text-ink">
                <ListTree className="size-4 flex-none text-ink/60" />
                <span className="truncate">{searching ? '全部收藏' : title}</span>
                <ChevronDown className="size-4 flex-none text-ink/50" />
              </button>
            )}
            <div className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-3', compact ? 'h-11 basis-full' : 'h-10')} style={{ background: 'rgb(var(--nx-ink-rgb)/0.05)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.09)' }}>
              <Search className="size-4 flex-none text-ink/50" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setParam('q', e.target.value || null)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    setParam('q', null);
                  }
                }}
                placeholder="搜索名称、网址或标签"
                aria-label="搜索我的收藏"
                spellCheck={false}
                autoComplete="off"
                className={cn('h-full min-w-0 flex-1 appearance-none border-0 bg-transparent text-ink caret-amber outline-none', compact ? 'text-[16px]' : 'text-[13.5px]')}
              />
              {!compact && <kbd className="rounded bg-ink/8 px-1.5 font-sans text-[11px] text-ink/50">Ctrl K</kbd>}
            </div>
            {!compact && (
              <>
                <label className="flex h-10 items-center gap-1.5 rounded-[10px] px-2 text-[12.5px] text-ink/70" style={{ background: 'rgb(var(--nx-ink-rgb)/0.05)' }}>
                  <span className="sr-only">排序</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="排序方式（按名称或时间排序只改变显示，不改变手动顺序）" className="h-9 border-0 bg-transparent text-[12.5px] text-ink outline-none">
                    {(Object.keys(SORT_LABEL) as SortMode[]).map((k) => (
                      <option key={k} value={k}>
                        {SORT_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <div role="radiogroup" aria-label="显示方式" className="flex h-10 items-center gap-0.5 rounded-[10px] p-[3px]" style={{ background: 'rgb(var(--nx-ink-rgb)/0.05)' }}>
                  {(
                    [
                      ['list', List, '列表'],
                      ['grid', LayoutGrid, '网格'],
                    ] as const
                  ).map(([k, Icon, label]) => (
                    <button key={k} type="button" role="radio" aria-checked={mode === k} aria-label={label} onClick={() => setMode(k)} className={cn('grid size-[34px] place-items-center rounded-[8px] border-0', mode === k ? 'bg-ink/12 text-ink' : 'bg-transparent text-ink/55 hover:text-ink')}>
                      <Icon className="size-4" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink/56', compact ? 'pb-1' : 'border-b border-ink/8 px-5 pb-3')}>
            <span className="font-medium text-ink/86">{title}</span>
            <span className="tabular-nums">{shown.length} 项</span>
            {hasChildren && !searching && (
              <label className="flex min-h-8 items-center gap-1.5">
                <input type="checkbox" className="size-4 accent-[var(--color-amber)]" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} />
                包含子分组
              </label>
            )}
            {compact && (
              <span className="ml-auto flex items-center gap-1">
                <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="排序方式" className="h-9 rounded-lg border-0 bg-ink/8 px-2 text-[13px] text-ink outline-none">
                  {(Object.keys(SORT_LABEL) as SortMode[]).map((k) => (
                    <option key={k} value={k}>
                      {SORT_LABEL[k]}
                    </option>
                  ))}
                </select>
              </span>
            )}
            {!compact && <span className="flex-1" />}
            {!compact && effective.kind !== 'trash' && !searching && (
              <span className="text-[12px] text-ink/46">{reorder ? (canDrag ? '拖动把手排序，或拖到左侧分组；也可用「…」里的上移 / 下移' : '用「…」里的上移 / 下移排序') : sort === 'manual' ? (canDrag ? '进入具体分组可手动排序；拖动名称到左侧分组可移动' : '进入具体分组可手动排序') : '按名称或时间排序只改变显示'}</span>
            )}
          </div>

          {chosen.length > 0 && !readOnly && (
            <div role="region" aria-label="批量操作" className={cn('flex flex-wrap items-center gap-2', compact ? 'rounded-xl bg-ink/7 p-2.5' : 'border-b border-ink/8 px-5 py-2.5')} style={compact ? undefined : { background: 'rgb(var(--nx-amber-rgb)/0.07)' }}>
              <span className="text-[13px] font-medium">已选 {chosen.length} 项</span>
              <span className="flex-1" />
              <Button size="sm" className={cn(compact && 'h-10')} onClick={() => setMoving(chosen)}>
                <FolderInput className="size-3.5" />
                移动到分组
              </Button>
              <Button size="sm" className={cn(compact && 'h-10')} onClick={() => void pinMany(chosen, true)}>
                <Pin className="size-3.5" />
                固定
              </Button>
              <Button size="sm" className={cn(compact && 'h-10')} onClick={() => void pinMany(chosen, false)}>
                <PinOff className="size-3.5" />
                取消固定
              </Button>
              <Button size="sm" variant="danger" className={cn(compact && 'h-10')} onClick={() => void trashItems(chosen)}>
                <Trash2 className="size-3.5" />
                移到回收站
              </Button>
              <Button size="sm" variant="ghost" className={cn(compact && 'h-10')} onClick={() => setSelected(new Set())}>
                取消选择
              </Button>
            </div>
          )}

          <div className={cn('min-h-0 flex-1', !compact && 'overflow-y-auto')} style={compact ? undefined : { maxHeight: 'calc(100dvh - 330px)', minHeight: 360 }}>
            {status === 'loading' && (
              <p role="status" className="m-0 flex items-center gap-2 px-5 py-6 text-[13.5px] text-ink/60">
                <Spinner /> 正在读取我的收藏…
              </p>
            )}
            {status === 'error' && (
              <div role="alert" className="m-5 flex flex-col items-start gap-3 rounded-xl p-4" style={{ background: 'rgb(var(--nx-error-rgb)/0.1)' }}>
                <span className="text-[13.5px]">没有读到我的收藏：{error || '加载失败'}</span>
                <Button onClick={() => void loadLibrary()}>重试</Button>
              </div>
            )}
            {status === 'ready' && trashUnknown && trashState !== 'error' && shown.length === 0 && (
              <p role="status" className="m-0 flex items-center gap-2 px-5 py-6 text-[13.5px] text-ink/60">
                <Spinner /> 正在读取回收站…
              </p>
            )}
            {status === 'ready' && trashUnknown && trashState === 'error' && (
              <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-xl p-4', compact ? 'my-2' : 'm-5')} style={{ background: 'rgb(var(--nx-error-rgb)/0.1)' }}>
                <span className="text-[13.5px] leading-[1.6]">没有读到更早移到回收站的收藏（可能是离线）。这里只列出这次打开页面之后删除的。</span>
                <Button onClick={() => void loadTrash()}>重试</Button>
              </div>
            )}
            {empty && (
              <div className={cn('flex flex-col items-start gap-3', compact ? 'py-6' : 'px-5 py-8')}>
                <span className="text-[15px] font-medium">{searching ? '没有找到匹配的收藏' : effective.kind === 'trash' ? '回收站是空的' : live.length === 0 ? '还没有收藏' : '这里还没有收藏'}</span>
                <span className="text-[13px] leading-[1.7] text-ink/56">{searching ? '试试其他关键词，或清除筛选。' : effective.kind === 'trash' ? '移到回收站的收藏会在这里，可以恢复。' : live.length === 0 ? '存下第一个常用网址，之后更容易找到。' : '可以从别的分组移进来，或者直接添加。'}</span>
                <div className="flex flex-wrap gap-2">
                  {searching && <Button onClick={() => setParam('q', null)}>清除搜索</Button>}
                  {effective.kind !== 'trash' && !readOnly && (
                    <Button variant="primary" onClick={() => openAddFavorite({ tab: searching ? 'store' : 'manual', q: query, ...(effective.kind === 'group' ? { folderId: effective.id } : {}) })}>
                      <Plus className="size-4" />
                      添加收藏
                    </Button>
                  )}
                </div>
              </div>
            )}
            {status === 'ready' && shown.length > 0 && (mode === 'grid' && !compact ? (
              <ul aria-label={`${title}，${shown.length} 项`} className="m-0 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3 p-5">
                <SortableContext items={canDrag ? shown.slice(0, GRID_MAX).map((i) => i.id) : []} strategy={rectSortingStrategy}>
                  {shown.slice(0, GRID_MAX).map((i) => (
                    <Card key={i.id} item={i} pinned={pinSet.has(i.id)} path={pathLabel(categories, i.folderId)} selected={selected.has(i.id)} reorder={reorder && canDrag} draggable={canDrag} onSelect={(v) => setSelected((s) => toggleSet(s, i.id, v))} onPin={() => void pinToggle(i)} onMore={(el) => openActions(i, el)} readOnly={readOnly} />
                  ))}
                </SortableContext>
                {/* Never a silent cut: the rest is one click away. */}
                {shown.length > GRID_MAX && (
                  <li className="col-span-full flex list-none flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-[13px] text-ink/66" style={{ background: 'rgb(var(--nx-ink-rgb)/0.04)' }}>
                    网格只显示前 {GRID_MAX} 项，另有 {shown.length - GRID_MAX} 项；切换到列表可以看到全部，或用搜索缩小范围。
                    <Button size="sm" onClick={() => setMode('list')}>
                      切换到列表
                    </Button>
                  </li>
                )}
              </ul>
            ) : (
              <ItemList
                items={shown}
                compact={compact}
                pinSet={pinSet}
                categories={categories}
                selected={selected}
                reorder={reorder && !readOnly}
                draggable={canDrag}
                readOnly={readOnly}
                showPath={effective.kind !== 'group' || withSub || searching}
                label={title}
                onSelect={(id, v, range) => {
                  const from = anchor.current ? shown.findIndex((x) => x.id === anchor.current) : -1;
                  const to = shown.findIndex((x) => x.id === id);
                  if (range && from >= 0 && to >= 0) {
                    const [lo, hi] = from < to ? [from, to] : [to, from];
                    setSelected((s) => {
                      const n = new Set(s);
                      for (const x of shown.slice(lo, hi + 1)) if (x.deletedAt === null) n.add(x.id);
                      return n;
                    });
                  } else setSelected((s) => toggleSet(s, id, v));
                  anchor.current = id;
                }}
                onSelectAll={(v) => setSelected(v ? new Set(shown.filter((i) => i.deletedAt === null).map((i) => i.id)) : new Set())}
                onPin={(i) => void pinToggle(i)}
                onMore={openActions}
                onRestore={(i) => void restore(i)}
              />
            ))}
          </div>
          <div className={cn('flex items-center gap-3 text-[12px] text-ink/52', compact ? 'pt-2' : 'border-t border-ink/8 px-5 py-3')}>
            <span className="tabular-nums">{live.length} 项收藏</span>
            <span className="flex-1" />
            {syncLine}
          </div>
        </section>
      </div>

      {compact && !readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setImporting(true)}>
            <Upload className="size-3.5" />
            导入
          </Button>
          <Button onClick={() => void exportAll()}>
            <Download className="size-3.5" />
            导出
          </Button>
          <Button onClick={() => setGroupTask({ kind: 'create', parentId: null })}>
            <FolderPlus className="size-3.5" />
            新建分组
          </Button>
        </div>
      )}

      {compact && treeSheet && (
        <Dialog open onOpenChange={(o) => !o && setTreeSheet(false)} title="选择分组" width={420} footer={<Button onClick={() => setTreeSheet(false)}>关闭</Button>}>
          <div className="max-h-[60dvh] overflow-y-auto">{treeView}</div>
        </Dialog>
      )}
      <GroupDialog task={groupTask} categories={categories} items={all} onClose={() => setGroupTask(null)} onDone={(id) => id && setView({ kind: 'group', id })} />
      <ImportDialog open={importing} categories={categories} existing={existingUrls} onClose={() => setImporting(false)} />
      {moving && <MoveDialog items={moving} categories={categories} onClose={() => setMoving(null)} onMove={(folderId) => void moveInto(moving, folderId).then(() => setMoving(null))} />}
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
      <ActionSheet sheet={sheet} onClose={() => setSheet(null)} />
      <FavoriteDialogs />
    </div>
    {typeof document !== 'undefined' &&
      createPortal(
        <DragOverlay dropAnimation={null} modifiers={[besidePointer]}>
          {drag ? <DragChip drag={drag} item={dragItem} group={dragGroup} hint={hint} /> : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

const toggleSet = (s: ReadonlySet<string>, id: string, on: boolean) => {
  const n = new Set(s);
  if (on) n.add(id);
  else n.delete(id);
  return n;
};

function SyncLine() {
  const save = useSaveState();
  const space = useConfigStore((s) => s.space);
  const queued = useLibrary((s) => s.queued);
  if (save.kind === 'error') return <span className="text-danger-ink">没有保存 · {save.message}</span>;
  if (space === 'local') return <span>仅保存在{host.localWhere}</span>;
  if (save.kind === 'offline') return <span className="text-warn">离线{queued + save.pending ? ` · ${queued + save.pending} 项更改待同步` : ''}</span>;
  if (save.kind === 'saving' || queued) return <span>正在同步…</span>;
  return <span>所有更改已同步</span>;
}

function MoreMenu({ items, onClose }: { items: { label: string; icon: LucideIcon; onSelect(): void }[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="absolute top-12 right-0 z-20 flex w-56 animate-pop flex-col rounded-xl p-1.5" style={{ background: 'var(--color-menu)', boxShadow: '0 16px 40px rgba(0,0,0,0.3), inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.08)' }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            it.onSelect();
          }}
          className="flex h-10 items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 text-left text-[13.5px] text-ink hover:bg-ink/8 focus-visible:bg-ink/8"
        >
          <it.icon className="size-4 text-ink/62" />
          {it.label}
        </button>
      ))}
    </div>
  );
}

type DragData = { kind: 'group'; id: string } | { kind: 'item'; id: string; count?: number };
/** Droppables: a row of the tree (a group, or 未分组 for favorites), or a row / card of the list. */
type DropData = { kind: 'tree'; groupId: string } | { kind: 'item'; id: string };
interface DropHint {
  /** Changes only when what is said changes (the tree re-renders on it, not on every pointer move). */
  key: string;
  target: string;
  zone: TreeZone | null;
  /** Dropped below an open group that has subgroups: its first subgroup. */
  firstChild?: boolean;
  ok: boolean;
  /** Nothing would change (its own place, already in that group): said plainly, not as a refusal. */
  neutral?: boolean;
  text: string;
  move?: { parentId: string | null; index?: number };
}

/**
 * Over the tree: the row under the pointer (pointerWithin — the gaps between rows are no target);
 * a group never drops on 未分组 or on a favorite. Elsewhere: the nearest row of the list or the grid
 * (closestCenter), as the list sorted before. A keyboard drag only ever sorts the list.
 */
function treeAwareCollisions(treeBox: { current: HTMLElement | null }): CollisionDetection {
  return (args) => {
    const kind = (args.active.data.current as DragData | undefined)?.kind;
    const of = (k: DropData['kind']) => args.droppableContainers.filter((c) => (c.data.current as DropData | undefined)?.kind === k);
    const tree = of('tree').filter((c) => kind === 'item' || (c.data.current as { groupId: string }).groupId !== UNFILED);
    const rows = kind === 'item' ? of('item') : [];
    const p = args.pointerCoordinates;
    const box = treeBox.current?.getBoundingClientRect();
    if (p && box && p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom) return pointerWithin({ ...args, droppableContainers: tree });
    return rows.length ? closestCenter({ ...args, droppableContainers: rows }) : [];
  };
}

/**
 * Droppables are measured all along (the tree and the list scroll while dragging). The overlay is
 * measured where the dragged row is, not where it is drawn: it is drawn beside the pointer (so the
 * row it is over stays visible), while sorting the list still compares the row's own position.
 */
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always }, dragOverlay: { measure: (el: HTMLElement) => getClientRect(el, { ignoreTransform: true }) } };
/** The overlay's corner just below-right of the pointer (a keyboard drag keeps it on the row). */
const besidePointer: Modifier = ({ transform, activatorEvent, activeNodeRect }) => {
  if (!activeNodeRect || !activatorEvent || !('clientX' in activatorEvent)) return transform;
  const e = activatorEvent as PointerEvent;
  return { ...transform, x: transform.x + e.clientX - activeNodeRect.left + 14, y: transform.y + e.clientY - activeNodeRect.top + 12 };
};

/** Arrow keys move a picked-up favorite among the rows / cards only (never onto the tree beside them). */
const rowsOnlyKeyboard: KeyboardCoordinateGetter = (event, args) => {
  const all = args.context.droppableContainers;
  const rows = { getEnabled: () => all.getEnabled().filter((c) => (c.data.current as DropData | undefined)?.kind === 'item'), get: (id: string | number) => all.get(id) } as unknown as typeof all;
  return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableContainers: rows } });
};

type TreeProps = {
  tree: GroupNode[];
  view: View;
  counts: { direct: Map<string, number>; total: Map<string, number> };
  total: number;
  pinned: number;
  services: number;
  unfiled: number;
  trash: number;
  compact: boolean;
  readOnly: boolean;
  collapsed: ReadonlySet<string>;
  onCollapse(s: ReadonlySet<string>): void;
  /** Dragging is on (a desktop that may change things). */
  dnd: boolean;
  drag: DragData | null;
  hint: DropHint | null;
  boxRef(el: HTMLElement | null): void;
  onView(v: View): void;
  onNewGroup(): void;
  onGroupMenu(g: GroupNode, el: HTMLElement): void;
};

function GroupTreePanel(props: TreeProps) {
  const { tree, view, compact, drag, hint } = props;
  const rowH = compact ? 'min-h-12' : 'min-h-[38px]';
  const sys = (v: View, label: string, Icon: LucideIcon, count: number) => {
    const on = viewKey(view) === viewKey(v);
    return (
      <button key={viewKey(v)} type="button" aria-current={on ? 'page' : undefined} onClick={() => props.onView(v)} className={cn('flex w-full items-center gap-2.5 rounded-lg border-0 px-2.5 text-left', rowH, compact ? 'text-[15px]' : 'text-[13px]', on ? 'bg-amber/14 text-ink' : 'bg-transparent text-ink/72 hover:bg-ink/6')}>
        <Icon className={cn('size-4 flex-none', on ? 'text-amber' : 'text-ink/50')} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-[11.5px] text-ink/46 tabular-nums">{count}</span>
      </button>
    );
  };
  const node = (g: GroupNode) => <TreeRow key={g.id} {...props} g={g} rowH={rowH} renderChild={node} />;
  const idle = drag ? (drag.kind === 'group' ? '拖到分组的上部或下部：排在它前面或后面；拖到中间：成为它的子分组' : '拖到左侧的分组或「未分组」上，移到那里') : null;
  return (
    <nav ref={props.boxRef} aria-label="收藏分组" className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto', compact ? '' : 'p-2.5')}>
      {sys({ kind: 'all' }, VIEW_LABEL.all, Bookmark, props.total)}
      {sys({ kind: 'pinned' }, VIEW_LABEL.pinned, Pin, props.pinned)}
      {props.services > 0 && sys({ kind: 'services' }, VIEW_LABEL.services, Server, props.services)}
      <div className="mt-3 mb-1 flex items-center gap-2 px-2.5">
        <span className="flex-1 text-[11.5px] text-ink/46">我的分组</span>
        {!props.readOnly && (
          <button type="button" aria-label="新建分组" title="新建分组" onClick={props.onNewGroup} className={cn('grid place-items-center rounded-md border-0 bg-transparent text-ink/55 hover:bg-ink/10 hover:text-ink', compact ? 'size-11' : 'size-7')}>
            <Plus className="size-4" />
          </button>
        )}
      </div>
      <ul className="m-0 p-0">{tree.map(node)}</ul>
      <UnfiledRow {...props} rowH={rowH} />
      <div className="mx-2.5 my-2 h-px bg-ink/8" />
      {sys({ kind: 'trash' }, VIEW_LABEL.trash, Trash2, props.trash)}
      {drag ? (
        // Where it lands, in words (dnd-kit says the same to a screen reader).
        <p data-testid="drop-hint" className={cn('sticky bottom-0 mt-auto mb-0 rounded-lg px-2.5 py-2 text-[12px] leading-[1.55]', hint && !hint.ok && !hint.neutral ? 'text-danger-ink' : 'text-ink/80')} style={{ background: hint?.ok ? 'rgb(var(--nx-amber-rgb)/0.16)' : hint && !hint.neutral ? 'rgb(var(--nx-error-rgb)/0.14)' : 'rgb(var(--nx-s3-rgb)/0.98)' }}>
          {hint ? (hint.ok ? `松开后：${hint.text}` : hint.text) : idle}
        </p>
      ) : (
        <span className="mt-auto px-2.5 pt-3 text-[11.5px] leading-[1.6] text-ink/42">
          分组旁的数字是直属收藏数；分组可以有子分组。{props.dnd ? '分组和收藏都可以拖动。' : ''}
        </span>
      )}
    </nav>
  );
}

/** 未分组 in the tree: a view, never a parent — but a favorite dropped on it goes to 未分组. */
function UnfiledRow(props: TreeProps & { rowH: string }) {
  const { view, compact, drag, hint, rowH } = props;
  const d = useDroppable({ id: 'tree:unfiled', data: { kind: 'tree', groupId: UNFILED } satisfies DropData, disabled: !props.dnd || drag?.kind !== 'item' });
  const on = view.kind === 'unfiled';
  const target = hint?.target === UNFILED && drag?.kind === 'item';
  return (
    <div ref={d.setNodeRef} data-dnd-id="tree:unfiled" data-dnd-name="未分组" className="rounded-lg" style={target ? { boxShadow: `inset 0 0 0 2px ${hint!.ok ? 'var(--color-amber)' : 'rgb(var(--nx-ink-rgb)/0.3)'}` } : undefined}>
      <button type="button" aria-current={on ? 'page' : undefined} onClick={() => props.onView({ kind: 'unfiled' })} className={cn('flex w-full items-center gap-2.5 rounded-lg border-0 px-2.5 text-left', rowH, compact ? 'text-[15px]' : 'text-[13px]', on ? 'bg-amber/14 text-ink' : 'bg-transparent text-ink/72 hover:bg-ink/6')}>
        <Folder className={cn('size-4 flex-none', on ? 'text-amber' : 'text-ink/50')} />
        <span className="min-w-0 flex-1 truncate">{VIEW_LABEL.unfiled}</span>
        <span className="text-[11.5px] text-ink/46 tabular-nums">{props.unfiled}</span>
      </button>
    </div>
  );
}

/**
 * One group of the tree. On a desktop the row itself is dragged (a click still opens it: the drag
 * starts after 6 px); only the pointer drags here — the keyboard uses the row's ⋯ menu (上移 / 下移
 * / 移到最前 / 移到最后 / 移动到…), which stays. A locked group is neither dragged nor a parent.
 */
function TreeRow(props: TreeProps & { g: GroupNode; rowH: string; renderChild(g: GroupNode): React.ReactNode }) {
  const { g, view, counts, compact, collapsed, drag, hint, rowH } = props;
  const on = view.kind === 'group' && view.id === g.id;
  const kids = g.children.length > 0;
  const open = !collapsed.has(g.id);
  const direct = counts.direct.get(g.id) ?? 0;
  const total = counts.total.get(g.id) ?? 0;
  const drop = useDroppable({ id: `tree:${g.id}`, data: { kind: 'tree', groupId: g.id } satisfies DropData, disabled: !props.dnd });
  const dragger = useDraggable({ id: `group:${g.id}`, data: { kind: 'group', id: g.id } satisfies DragData, disabled: !props.dnd || g.locked });
  const mine = hint && hint.target === g.id && drag && !(drag.kind === 'group' && drag.id === g.id) ? hint : null;
  const tone = mine ? (mine.ok ? 'var(--color-amber)' : mine.neutral ? 'rgb(var(--nx-ink-rgb)/0.3)' : 'rgb(var(--nx-error-rgb)/0.85)') : '';
  const line = mine && (mine.zone === 'before' || mine.zone === 'after') ? mine.zone : null;
  const indent = (g.depth - 1) * 14 + (mine?.firstChild ? 14 : 0);
  const ring = mine && (mine.zone === 'inside' || !mine.zone) ? { boxShadow: `inset 0 0 0 2px ${tone}`, background: mine.ok ? 'rgb(var(--nx-amber-rgb)/0.1)' : mine.neutral ? undefined : 'rgb(var(--nx-error-rgb)/0.08)' } : {};
  return (
    <li className="list-none">
      <div
        ref={(el) => {
          drop.setNodeRef(el);
          dragger.setNodeRef(el);
        }}
        data-dnd-id={`tree:${g.id}`}
        data-dnd-name={`分组「${g.path.join(' / ')}」`}
        data-drop={mine ? `${mine.zone ?? 'into'}${mine.ok ? '' : mine.neutral ? '-same' : '-refused'}` : undefined}
        className={cn('group/row relative flex items-center rounded-lg', on ? 'bg-amber/14' : 'hover:bg-ink/6', dragger.isDragging && 'opacity-45')}
        style={{ paddingLeft: (g.depth - 1) * 14, ...ring }}
      >
        {line && <span aria-hidden className="pointer-events-none absolute right-1 h-[3px] rounded-full" style={{ left: indent + 6, background: tone, ...(line === 'before' ? { top: -2 } : { bottom: -2 }) }} />}
        {kids ? (
          <button type="button" aria-label={`${open ? '收起' : '展开'}「${g.label}」`} aria-expanded={open} onClick={() => props.onCollapse(toggleSet(collapsed, g.id, open))} className={cn('grid flex-none place-items-center rounded border-0 bg-transparent text-ink/50 hover:text-ink', compact ? 'size-11' : 'size-6')}>
            <ChevronRight className={cn('size-3.5 transition-transform duration-120', open && 'rotate-90')} />
          </button>
        ) : (
          <span className={cn('flex-none', compact ? 'w-11' : 'w-6')} />
        )}
        <button
          type="button"
          ref={dragger.setActivatorNodeRef}
          // Pointer only: Enter / Space keep opening the group (the ⋯ menu has the keyboard moves).
          onPointerDown={pointerOnly(dragger.listeners)}
          data-dnd-id={`group:${g.id}`}
          data-dnd-name={`分组「${g.label}」`}
          aria-current={on ? 'page' : undefined}
          aria-label={`${g.path.join(' / ')}，直属 ${direct} 个${kids ? `，含子分组共 ${total} 个` : ''}`}
          onClick={() => props.onView({ kind: 'group', id: g.id })}
          className={cn('flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent pr-1 text-left', rowH, compact ? 'text-[15px]' : 'text-[13px]', on ? 'text-ink' : 'text-ink/76')}
        >
          <Folder className={cn('size-4 flex-none', on ? 'text-amber' : 'text-ink/48')} />
          <span className="min-w-0 flex-1 truncate">{g.label}</span>
          <span className="text-[11.5px] text-ink/46 tabular-nums" title={kids ? `直属 ${direct} · 含子分组 ${total}` : `直属 ${direct}`}>
            {direct}
          </span>
        </button>
        {!props.readOnly && (
          <button type="button" aria-label={`「${g.label}」的操作`} onClick={(e) => props.onGroupMenu(g, e.currentTarget)} className={cn('grid flex-none place-items-center rounded-md border-0 bg-transparent text-ink/50 hover:bg-ink/10 hover:text-ink', compact ? 'size-11' : 'size-7 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100', on && !compact && 'opacity-100')}>
            <MoreHorizontal className="size-4" />
          </button>
        )}
      </div>
      {kids && open && <ul className="m-0 p-0">{g.children.map(props.renderChild)}</ul>}
    </li>
  );
}

function PinButton({ pinned, title, onPin, compact, disabled }: { pinned: boolean; title: string; onPin(): void; compact: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? `从首页取消固定「${title}」` : `固定「${title}」到首页`}
      disabled={disabled}
      onClick={onPin}
      className={cn('grid flex-none place-items-center rounded-lg border-0', compact ? 'size-11' : 'size-8', pinned ? 'bg-amber/16 text-amber' : 'bg-transparent text-ink/36 hover:bg-ink/8 hover:text-ink/70', disabled && 'opacity-40')}
    >
      <Pin className="size-4" fill={pinned ? 'currentColor' : 'none'} />
    </button>
  );
}

/** The grid shows at most this many cards (the list, windowed, shows any number). */
const GRID_MAX = 300;
/** Above this many rows the list is windowed (only what is on screen is in the document) and dragging is off (see ItemList). */
const WINDOW_AT = 120;
const ROW_H = { desk: 52, phone: 68 } as const;

/** The scrolling ancestor of an element (the list's own box, or the settings page on a phone). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

/** Which rows are on screen (with a margin), for thousands of favorites in a light document. */
function useWindowRange(count: number, rowH: number, list: React.RefObject<HTMLElement | null>, on: boolean) {
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) });
  useLayoutEffect(() => {
    if (!on) return;
    const el = list.current;
    const sc = scrollParent(el);
    if (!el || !sc) return;
    const update = () => {
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const start = Math.max(0, Math.floor((sc.scrollTop - top) / rowH) - 8);
      const end = Math.min(count, Math.ceil((sc.scrollTop + sc.clientHeight - top) / rowH) + 8);
      setRange((r) => (r.start === start && r.end === end ? r : { start, end: Math.max(end, start + 1) }));
    };
    update();
    sc.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(sc);
    return () => {
      sc.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [count, rowH, list, on]);
  return on ? range : { start: 0, end: count };
}

type ListProps = {
  items: Item[];
  label: string;
  compact: boolean;
  pinSet: ReadonlySet<string>;
  categories: readonly Category[];
  selected: ReadonlySet<string>;
  /** Manual order of one group: rows sort by drag (grip, pointer or keyboard) and by the menu. */
  reorder: boolean;
  /** Rows can be dragged onto the tree (a desktop that may change things; never in 回收站). */
  draggable: boolean;
  readOnly: boolean;
  showPath: boolean;
  onSelect(id: string, on: boolean, range: boolean): void;
  onSelectAll(on: boolean): void;
  onPin(i: Item): void;
  onMore(i: Item, el: HTMLElement): void;
  onRestore(i: Item): void;
};

/** The first column: a checkbox, or (manual order) the grip and the checkbox. */
const COLS = { plain: 'grid-cols-[36px_minmax(0,1fr)_minmax(0,0.6fr)_56px_40px]', grip: 'grid-cols-[62px_minmax(0,1fr)_minmax(0,0.6fr)_56px_40px]' } as const;

/**
 * Dragging stays off in a windowed list (more than WINDOW_AT rows), for sorting and for dropping on
 * the tree alike: dnd-kit only knows the rows that are mounted — the sorting strategy reads the
 * measured rect at each index, so with most rows unmounted (and rows mounting / unmounting as the
 * list auto-scrolls under the pointer) the gap it opens and the index the drop resolves to can jump,
 * and a drop could land somewhere other than where it was shown. Long moves there use 移到分组最前 /
 * 最后, 移动到分组… and the batch bar, which name their target exactly.
 */
function ItemList(props: ListProps) {
  const { items, compact } = props;
  const liveCount = items.filter((i) => i.deletedAt === null).length;
  const allOn = liveCount > 0 && items.every((i) => i.deletedAt !== null || props.selected.has(i.id));
  const windowed = items.length > WINDOW_AT;
  const rowH = compact ? ROW_H.phone : ROW_H.desk;
  const listRef = useRef<HTMLUListElement>(null);
  const { start, end } = useWindowRange(items.length, rowH, listRef, windowed);
  const [active, setActive] = useState(-1);
  const reorder = props.reorder && !windowed;
  const draggable = props.draggable && !windowed;
  const cols = reorder && !compact ? COLS.grip : COLS.plain;
  useEffect(() => setActive((a) => Math.min(a, items.length - 1)), [items.length]);
  /** ↑ / ↓ / Home / End move through the rows (scrolling the window), Space selects, Enter edits. */
  const onKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    const n = items.length;
    if (!n) return;
    const go = (k: number) => {
      e.preventDefault();
      const next = Math.max(0, Math.min(n - 1, k));
      setActive(next);
      const sc = scrollParent(listRef.current);
      const el = listRef.current;
      if (sc && el) {
        const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + next * rowH;
        if (top < sc.scrollTop) sc.scrollTop = top;
        else if (top + rowH > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + rowH - sc.clientHeight;
      }
    };
    if (e.key === 'ArrowDown') go(active + 1);
    else if (e.key === 'ArrowUp') go(active - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if ((e.key === ' ' || e.key === 'Enter') && active >= 0) {
      e.preventDefault();
      const it = items[active]!;
      if (e.key === 'Enter') return void (it.deletedAt === null ? openEditFavorite(it.id) : props.onRestore(it));
      if (it.deletedAt === null && !props.readOnly) props.onSelect(it.id, !props.selected.has(it.id), e.shiftKey);
    }
  };
  const visible = items.slice(start, end);
  const rows = (
    <ul
      ref={listRef}
      role="listbox"
      aria-multiselectable="true"
      aria-label={`${props.label}（${items.length} 条）`}
      aria-activedescendant={active >= 0 && items[active] ? `fav-row-${items[active]!.id}` : undefined}
      tabIndex={0}
      onKeyDown={onKey}
      className={cn('m-0 p-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-amber)]', compact ? 'flex flex-col' : 'px-3 pb-3')}
    >
      {windowed && start > 0 && <li aria-hidden className="list-none" style={{ height: start * rowH }} />}
      {visible.map((i, k) => (
        <Row key={i.id} item={i} index={start + k} active={start + k === active} rowH={rowH} windowed={windowed} cols={cols} {...props} reorder={reorder} draggable={draggable && i.deletedAt === null} />
      ))}
      {windowed && end < items.length && <li aria-hidden className="list-none" style={{ height: (items.length - end) * rowH }} />}
    </ul>
  );
  return (
    <div className="flex flex-col">
      {!compact && (
        <div className={cn('sticky top-0 z-[1] grid items-center gap-2 border-b border-ink/8 px-6 py-2 text-[12px] text-ink/50', cols)} style={{ background: 'rgb(var(--nx-s2-rgb)/0.96)' }}>
          {!props.readOnly && liveCount > 0 ? <input type="checkbox" aria-label="全选" className={cn('size-4 accent-[var(--color-amber)]', reorder && 'ml-[38px]')} checked={allOn} onChange={(e) => props.onSelectAll(e.target.checked)} /> : <span />}
          <span>名称</span>
          <span>分组</span>
          <span className="text-center">首页</span>
          <span />
        </div>
      )}
      {draggable ? (
        <SortableContext items={visible.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {rows}
        </SortableContext>
      ) : (
        rows
      )}
    </div>
  );
}

/** Only the pointer half of a drag source's listeners (its keyboard half would take Enter / Space). */
const pointerOnly = (l: Record<string, unknown> | undefined) => l?.onPointerDown as React.PointerEventHandler<HTMLElement> | undefined;

/** A row / card as a drag source and (manual order) a place to drop; inert where dragging is off. */
function useRowDrag(id: string, reorder: boolean, draggable: boolean) {
  return useSortable({ id, data: { kind: 'item', id } satisfies DropData, disabled: { draggable: !draggable, droppable: !reorder || !draggable } });
}

function Row({ item: i, index, active, rowH, cols, compact, pinSet, categories, selected, reorder, draggable, readOnly, showPath, onSelect, onPin, onMore, onRestore }: ListProps & { item: Item; index: number; active: boolean; rowH: number; windowed: boolean; cols: string }) {
  const s = useRowDrag(i.id, reorder, draggable && !compact);
  const trashed = i.deletedAt !== null;
  const app = asApp(i);
  const on = selected.has(i.id);
  const style = { height: rowH, transform: CSS.Translate.toString(s.transform), transition: s.transition };
  const path = pathLabel(categories, i.folderId);
  const svc = isService(i);
  const check = (cls: string) =>
    !readOnly && !trashed ? (
      <input
        type="checkbox"
        aria-label={`选择 ${i.title}`}
        className={cls}
        checked={on}
        onClick={(e) => {
          e.preventDefault();
          onSelect(i.id, !on, e.shiftKey);
        }}
        onChange={() => undefined}
      />
    ) : null;
  const ring = active ? { boxShadow: 'inset 0 0 0 2px rgb(var(--nx-amber-rgb)/0.7)' } : undefined;
  if (compact)
    return (
      <li ref={s.setNodeRef} id={`fav-row-${i.id}`} role="option" aria-selected={on} aria-posinset={index + 1} style={style} className="list-none pb-1">
        <div className={cn('flex h-full items-center gap-3 rounded-xl px-2', on ? 'bg-amber/10' : 'bg-ink/[0.04]')} style={ring}>
          {check('size-5 flex-none accent-[var(--color-amber)]')}
          <button type="button" onClick={(e) => (trashed ? onMore(i, e.currentTarget) : openEditFavorite(i.id))} className="flex min-w-0 flex-1 items-center gap-3 border-0 bg-transparent py-1 text-left text-ink" aria-label={`${i.title}，${path}${trashed ? '，在回收站' : '，编辑'}`}>
            <AppTile target={{ kind: 'app', app }} size={36} lazy />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[15px]">{i.title}</span>
              <span className="truncate text-[12.5px] text-ink/50">
                {hostOf(i.url)}
                {showPath ? ` · ${path}` : ''}
              </span>
            </span>
          </button>
          {trashed ? (
            <Button className="h-11" onClick={() => onRestore(i)}>
              恢复
            </Button>
          ) : (
            <>
              {!readOnly && <PinButton pinned={pinSet.has(i.id)} title={i.title} onPin={() => onPin(i)} compact disabled={!!i.app?.hidden && !pinSet.has(i.id)} />}
              {!readOnly && (
                <button type="button" aria-label={`「${i.title}」的操作`} onClick={(e) => onMore(i, e.currentTarget)} className="grid size-11 flex-none place-items-center rounded-lg border-0 bg-transparent text-ink/55">
                  <MoreHorizontal className="size-5" />
                </button>
              )}
            </>
          )}
        </div>
      </li>
    );
  // Outside a manual order the name drags (pointer only: a click still edits, the drag starts after 6 px).
  const nameDrag = draggable && !reorder && !trashed ? { ref: s.setActivatorNodeRef, onPointerDown: pointerOnly(s.listeners), 'data-dnd-id': i.id, 'data-dnd-name': i.title } : {};
  return (
    <li ref={s.setNodeRef} id={`fav-row-${i.id}`} role="option" aria-selected={on} aria-posinset={index + 1} style={{ ...style, ...ring }} className={cn('grid list-none items-center gap-2 rounded-lg px-3', cols, s.isDragging ? 'bg-amber/8 opacity-50' : 'hover:bg-ink/[0.045]', on && 'bg-amber/8')}>
      <span className="flex items-center gap-1.5">
        {reorder && draggable && (
          <button type="button" {...s.attributes} {...s.listeners} data-dnd-id={i.id} data-dnd-name={i.title} aria-label={`拖动以排序「${i.title}」（也可用空格键拿起后按方向键）`} className="grid size-7 flex-none cursor-grab place-items-center rounded border-0 bg-transparent text-ink/38 hover:text-ink/70 active:cursor-grabbing">
            <GripVertical className="size-4" />
          </button>
        )}
        {check('ml-1 size-4 accent-[var(--color-amber)]')}
      </span>
      <button type="button" {...nameDrag} onClick={() => (trashed ? undefined : openEditFavorite(i.id))} disabled={trashed} className="flex min-w-0 items-center gap-3 border-0 bg-transparent p-0 text-left text-ink disabled:cursor-default" title={i.title} aria-label={trashed ? i.title : `编辑「${i.title}」`}>
        <AppTile target={{ kind: 'app', app }} size={34} lazy />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px]">{i.title}</span>
            {svc && <span className="flex-none rounded px-1.5 text-[11px] text-ink/60" style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.18)' }}>服务</span>}
          </span>
          <span className="truncate text-[12px] text-ink/48">{hostOf(i.url)}</span>
        </span>
      </button>
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink/60" title={path}>
        <Folder className="size-3.5 flex-none text-ink/40" />
        <span className="truncate">{path}</span>
      </span>
      <span className="flex justify-center">{trashed ? null : <PinButton pinned={pinSet.has(i.id)} title={i.title} onPin={() => onPin(i)} compact={false} disabled={readOnly || (!!i.app?.hidden && !pinSet.has(i.id))} />}</span>
      <span className="flex justify-end">
        {trashed ? (
          <Button size="sm" onClick={() => onRestore(i)}>
            恢复
          </Button>
        ) : !readOnly ? (
          <button type="button" aria-label={`「${i.title}」的操作`} onClick={(e) => onMore(i, e.currentTarget)} className="grid size-8 place-items-center rounded-lg border-0 bg-transparent text-ink/50 hover:bg-ink/10 hover:text-ink">
            <MoreHorizontal className="size-4" />
          </button>
        ) : null}
      </span>
    </li>
  );
}

/**
 * A card of the grid. Manual order: the grip sorts (pointer, or Space then the arrow keys — the
 * same moveItems anchors as the list); everywhere else the name drags onto the tree (pointer only).
 */
function Card({ item: i, pinned, path, selected, reorder, draggable, onSelect, onPin, onMore, readOnly }: { item: Item; pinned: boolean; path: string; selected: boolean; reorder: boolean; draggable: boolean; onSelect(v: boolean): void; onPin(): void; onMore(el: HTMLElement): void; readOnly: boolean }) {
  const trashed = i.deletedAt !== null;
  const s = useRowDrag(i.id, reorder, draggable && !trashed);
  const nameDrag = draggable && !reorder && !trashed ? { ref: s.setActivatorNodeRef, onPointerDown: pointerOnly(s.listeners), 'data-dnd-id': i.id, 'data-dnd-name': i.title } : {};
  return (
    <li
      ref={s.setNodeRef}
      data-card={i.id}
      className={cn('relative flex list-none flex-col gap-2.5 rounded-xl p-3.5', s.isDragging ? 'opacity-50' : selected ? 'bg-amber/10' : 'bg-ink/[0.045] hover:bg-ink/[0.07]')}
      style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.07)', transform: CSS.Translate.toString(s.transform), transition: s.transition }}
    >
      <div className="flex items-start gap-2">
        <AppTile target={{ kind: 'app', app: asApp(i) }} size={40} lazy />
        <span className="flex-1" />
        {reorder && draggable && !trashed && (
          <button type="button" {...s.attributes} {...s.listeners} data-dnd-id={i.id} data-dnd-name={i.title} aria-label={`拖动以排序「${i.title}」（也可用空格键拿起后按方向键）`} className="-mt-1 grid size-7 cursor-grab place-items-center rounded border-0 bg-transparent text-ink/38 hover:text-ink/70 active:cursor-grabbing">
            <GripVertical className="size-4" />
          </button>
        )}
        {!readOnly && !trashed && <input type="checkbox" aria-label={`选择 ${i.title}`} className="size-4 accent-[var(--color-amber)]" checked={selected} onChange={(e) => onSelect(e.target.checked)} />}
      </div>
      <button type="button" {...nameDrag} onClick={() => !trashed && openEditFavorite(i.id)} className="flex min-w-0 flex-col gap-0.5 border-0 bg-transparent p-0 text-left text-ink" title={i.title}>
        <span className="truncate text-[14px]">{i.title}</span>
        <span className="truncate text-[12px] text-ink/48">{hostOf(i.url)}</span>
        <span className="truncate text-[12px] text-ink/48">{path}</span>
      </button>
      {!trashed && !readOnly && (
        <div className="flex items-center gap-1">
          <PinButton pinned={pinned} title={i.title} onPin={onPin} compact={false} disabled={!!i.app?.hidden && !pinned} />
          <span className="flex-1" />
          <button type="button" aria-label={`「${i.title}」的操作`} onClick={(e) => onMore(e.currentTarget)} className="grid size-8 place-items-center rounded-lg border-0 bg-transparent text-ink/50 hover:bg-ink/10 hover:text-ink">
            <MoreHorizontal className="size-4" />
          </button>
        </div>
      )}
    </li>
  );
}

/** What follows the pointer: the favorite (with how many go along), or the group. */
function DragChip({ drag, item, group, hint }: { drag: DragData; item?: Item; group?: GroupNode | Category; hint: DropHint | null }) {
  return (
    <div aria-hidden className="flex w-max max-w-[320px] flex-col gap-1 rounded-xl px-3 py-2 text-[13px] text-ink" style={{ background: 'var(--color-menu)', boxShadow: `0 14px 34px rgba(0,0,0,0.35), inset 0 0 0 1px ${hint && !hint.ok && !hint.neutral ? 'rgb(var(--nx-error-rgb)/0.7)' : 'rgb(var(--nx-amber-rgb)/0.55)'}` }}>
      <span className="flex min-w-0 items-center gap-2.5">
        {drag.kind === 'item' && item ? <AppTile target={{ kind: 'app', app: asApp(item) }} size={24} /> : <Folder className="size-4 flex-none text-amber" />}
        <span className="min-w-0 flex-1 truncate">{drag.kind === 'item' ? (item?.title ?? '') : (group?.label ?? '')}</span>
        {drag.kind === 'item' && (drag.count ?? 1) > 1 && <span className="flex-none rounded-md bg-amber/20 px-1.5 text-[11.5px] text-ink tabular-nums">共 {drag.count} 个</span>}
      </span>
      {hint && <span className={cn('text-[12px] leading-[1.5]', hint.ok || hint.neutral ? 'text-ink/70' : 'text-danger-ink')}>{hint.ok ? `→ ${hint.text}` : hint.text}</span>}
    </div>
  );
}

function MoveDialog({ items, categories, onClose, onMove }: { items: Item[]; categories: readonly Category[]; onClose(): void; onMove(folderId: string): void }) {
  const [to, setTo] = useState(items.length === 1 ? items[0]!.folderId || UNFILED : UNFILED);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={items.length === 1 ? `移动「${items[0]!.title}」` : `移动 ${items.length} 个收藏`}
      description="移到目标分组的最后；在分组里可以再上移、下移。"
      footer={
        <>
          <Button className="h-10 px-4" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="h-10 px-5" onClick={() => onMove(to)}>
            移动
          </Button>
        </>
      }
    >
      <GroupSelect categories={categories} value={to} onChange={setTo} label="移动到分组" />
      <p className="m-0 text-[12.5px] text-ink/56">新位置：{pathLabel(categories, to)}</p>
    </Dialog>
  );
}
