import { descendantIds, groupPath, hostOf, LOCKED_CATEGORY, matchApp, UNFILED, type AppEntry, type Category, type Item, type PinyinFn } from '@nexus/shared';

/**
 * 我的收藏的视图 (UI v2 · spec 02 N2, 03 §4–§5): which favorites a view shows, how many, in which
 * order. Only reads: every change goes through libraryApi / the group ops. The system views are not
 * groups (nothing can be moved into 「全部收藏」 or made a child of 「服务」).
 */
export type View = { kind: 'all' } | { kind: 'pinned' } | { kind: 'services' } | { kind: 'unfiled' } | { kind: 'trash' } | { kind: 'group'; id: string };
export type SortMode = 'manual' | 'name' | 'added' | 'updated';

export const SORT_LABEL: Record<SortMode, string> = { manual: '手动顺序', name: '按名称', added: '最近添加', updated: '最近修改' };

export const viewKey = (v: View) => (v.kind === 'group' ? `group:${v.id}` : v.kind);
export function parseView(s: string | null): View {
  if (!s) return { kind: 'all' };
  if (s.startsWith('group:')) return { kind: 'group', id: s.slice(6) };
  return (['all', 'pinned', 'services', 'unfiled', 'trash'] as const).includes(s as never) ? ({ kind: s } as View) : { kind: 'all' };
}

const clip = (s: string, n: number) => [...s].slice(0, n).join('').trim();
export const isService = (i: Item) => i.app?.kind === 'service';

/** A favorite as the home page and the icon renderer see it (its stored extra, or a plain site). */
export function asApp(i: Item): AppEntry {
  const a = i.app ?? {};
  return {
    id: i.id,
    kind: a.kind ?? 'site',
    name: clip(i.title, 32) || clip(hostOf(i.url), 32) || '收藏',
    description: a.description ?? '',
    url: i.url,
    lanUrl: a.lanUrl ?? '',
    prefer: a.prefer ?? 'ext',
    categoryId: i.folderId || UNFILED,
    hidden: a.hidden ?? false,
    showInServices: a.showInServices ?? true,
    aliases: a.aliases ?? [],
    icon: a.icon ?? { source: 'auto', ref: '', letter: '', tone: 0 },
    // As the home page and 快速打开 open it (AppSchema's default): a saved page opens in place too.
    openIn: a.openIn ?? 'same',
    health: a.health ?? { enabled: false, target: '/', intervalSec: 60 },
    ...(i.catalogId ? { catalogId: i.catalogId } : {}),
  };
}

/** 「工作 / 开发」, or 未分组. */
export function pathLabel(categories: readonly Category[], folderId: string): string {
  if (!folderId || folderId === UNFILED) return '未分组';
  const p = groupPath(categories, folderId);
  return p.length ? p.join(' / ') : '未分组';
}

export function groupExists(categories: readonly Category[], id: string) {
  return id !== UNFILED && id !== LOCKED_CATEGORY.hosted ? categories.some((c) => c.id === id) : categories.some((c) => c.id === id);
}

/** Direct and total (with every subgroup) counts of live favorites per group. */
export function groupCounts(categories: readonly Category[], live: readonly Item[]) {
  const direct = new Map<string, number>();
  for (const i of live) direct.set(i.folderId || UNFILED, (direct.get(i.folderId || UNFILED) ?? 0) + 1);
  const total = new Map<string, number>();
  for (const c of categories) {
    const below = descendantIds(categories, c.id);
    total.set(c.id, (direct.get(c.id) ?? 0) + below.reduce((n, id) => n + (direct.get(id) ?? 0), 0));
  }
  return { direct, total };
}

export function inView(i: Item, v: View, ctx: { pins: ReadonlySet<string>; categories: readonly Category[]; withSub: boolean }): boolean {
  switch (v.kind) {
    case 'trash':
      return i.deletedAt !== null;
    case 'all':
      return i.deletedAt === null;
    case 'pinned':
      return i.deletedAt === null && ctx.pins.has(i.id);
    case 'services':
      return i.deletedAt === null && isService(i);
    case 'unfiled':
      return i.deletedAt === null && (!i.folderId || i.folderId === UNFILED || !ctx.categories.some((c) => c.id === i.folderId));
    case 'group':
      if (i.deletedAt !== null) return false;
      if (i.folderId === v.id) return true;
      return ctx.withSub && descendantIds(ctx.categories, v.id).includes(i.folderId);
  }
}

/** Search over name (and its pinyin), address, aliases and tags; the whole collection by default. */
export function matches(i: Item, q: string, pinyin: PinyinFn | null): boolean {
  const s = q.trim();
  if (!s) return true;
  const app = asApp(i);
  if (matchApp({ ...app, name: clip(i.title, 64) || app.name, aliases: [...app.aliases, ...i.tags].slice(0, 40) }, s, pinyin)) return true;
  const low = s.toLowerCase();
  return i.title.toLowerCase().includes(low) || i.url.toLowerCase().includes(low) || i.tags.some((t) => t.toLowerCase().includes(low));
}

/** The manual order inside one group (position, then id) — the order 上移 / 下移 and drag change. */
export const byPosition = (a: Item, b: Item) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The order a view shows. 名称 / 最近添加 / 最近修改 are views only — never written. In views made of
 * several groups the manual order is: group by group (in tree order), then the group's own order.
 */
export function sortItems(list: Item[], mode: SortMode, ctx: { pins: readonly string[]; categories: readonly Category[]; view: View }): Item[] {
  const out = [...list];
  if (mode === 'name') return out.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  if (mode === 'added') return out.sort((a, b) => b.createdAt - a.createdAt);
  if (mode === 'updated') return out.sort((a, b) => b.updatedAt - a.updatedAt);
  if (ctx.view.kind === 'pinned') {
    const at = new Map(ctx.pins.map((id, k) => [id, k]));
    return out.sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9));
  }
  const rank = new Map<string, number>();
  ctx.categories.forEach((c, k) => rank.set(c.id, k));
  return out.sort((a, b) => (rank.get(a.folderId) ?? 1e6) - (rank.get(b.folderId) ?? 1e6) || byPosition(a, b));
}

/** Manual ordering is possible where the order belongs to one group (spec 03 §5). */
export const canReorder = (v: View, mode: SortMode, query: string, withSub: boolean) => mode === 'manual' && !query.trim() && (v.kind === 'unfiled' || (v.kind === 'group' && !withSub));
