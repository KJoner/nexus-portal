import { CONFIG_LIMITS, LOCKED_CATEGORY, type Category } from './schema';

/**
 * 我的收藏的分组树 (UI v2 · v12.0.3 N2). Groups are the configuration's categories with a parent:
 * `parentId` null or absent is a root group; the array order is the order among siblings. These
 * are the only rules for the tree — the server, the browser's local collection, the extension and
 * every importer call them, so a tree one of them accepts the others accept too.
 *
 *  - a parent must exist, is never the group itself or one of its descendants, never 未分组;
 *  - depth at most GROUP_LIMITS.depth (a root group is depth 1), at most GROUP_LIMITS.total groups;
 *  - names are unique among siblings after trimming, NFKC and case folding (工作/资料 and
 *    生活/资料 are two different groups);
 *  - 全部收藏 / 已固定到首页 / 服务 / 未分组 / 回收站 are views, not groups: they are never a parent.
 * Identity is the id: moving a group changes its parent, never its id or its children.
 */
export const GROUP_LIMITS = { depth: 8, total: CONFIG_LIMITS.categories } as const;

/** The one 未分组 (legacy id `none`, label 未分类 in older documents): favorites with no group. */
export const UNFILED = LOCKED_CATEGORY.none;

/** Views of 我的收藏 that are not groups (never a parent, never a stored category). */
export const SYSTEM_VIEWS = { all: '全部收藏', pinned: '已固定到首页', services: '服务', unfiled: '未分组', trash: '回收站' } as const;
export type SystemView = keyof typeof SYSTEM_VIEWS;

/** Ids a new group may not take: the views above, 未分组, and the legacy 我的服务 id. */
export const RESERVED_GROUP_IDS: ReadonlySet<string> = new Set([UNFILED, LOCKED_CATEGORY.hosted, ...Object.keys(SYSTEM_VIEWS)]);

/** How two names compare among siblings: trimmed, NFKC, case-folded. */
export const labelKey = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase();

const parentOf = (g: Pick<Category, 'parentId'>): string | null => g.parentId ?? null;

/** Groups by id, and each parent's children in sibling order (root: key null). */
export function groupIndex(categories: readonly Category[]) {
  const byId = new Map(categories.map((k) => [k.id, k]));
  const children = new Map<string | null, Category[]>();
  for (const k of categories) {
    const p = parentOf(k);
    const key = p !== null && byId.has(p) ? p : null;
    const list = children.get(key);
    if (list) list.push(k);
    else children.set(key, [k]);
  }
  return { byId, children };
}

/** Depth of a group (root = 1); 0 for an unknown id. A broken chain counts as far as it goes. */
export function depthOf(categories: readonly Category[], id: string | null): number {
  if (id === null) return 0;
  const { byId } = groupIndex(categories);
  let d = 0;
  const seen = new Set<string>();
  for (let cur: string | null = id; cur !== null && byId.has(cur) && !seen.has(cur); cur = parentOf(byId.get(cur)!)) {
    seen.add(cur);
    d++;
  }
  return d;
}

/** All descendants of a group (children, grandchildren…), in tree order. */
export function descendantIds(categories: readonly Category[], id: string): string[] {
  const { children } = groupIndex(categories);
  const out: string[] = [];
  const walk = (p: string) => {
    for (const k of children.get(p) ?? []) {
      if (out.includes(k.id) || k.id === id) continue;
      out.push(k.id);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

/** Height of the subtree under (and including) a group: a leaf is 1. */
export function heightOf(categories: readonly Category[], id: string): number {
  const { children } = groupIndex(categories);
  const seen = new Set<string>();
  const h = (g: string): number => {
    if (seen.has(g)) return 0;
    seen.add(g);
    return 1 + Math.max(0, ...(children.get(g) ?? []).map((k) => h(k.id)));
  };
  return h(id);
}

/** Labels from the root down to the group (`['工作', '开发']`). */
export function groupPath(categories: readonly Category[], id: string): string[] {
  const { byId } = groupIndex(categories);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | null = id; cur !== null && byId.has(cur) && !seen.has(cur); cur = parentOf(byId.get(cur)!)) {
    seen.add(cur);
    out.unshift(byId.get(cur)!.label);
  }
  return out;
}

/** Whether `id` is `ancestor` itself or somewhere below it. */
export function isWithin(categories: readonly Category[], ancestor: string, id: string | null): boolean {
  return id !== null && (id === ancestor || descendantIds(categories, ancestor).includes(id));
}

/** Whether a sibling under `parentId` already uses this name (`exceptId`: the group being renamed or moved). */
export function siblingNameTaken(categories: readonly Category[], parentId: string | null, label: string, exceptId?: string): boolean {
  const key = labelKey(label);
  return categories.some((k) => k.id !== exceptId && k.id !== UNFILED && (parentOf(k) ?? null) === parentId && labelKey(k.label) === key);
}

/**
 * Why `groupId` (null: a new group of `height` 1) cannot sit under `parentId`, or null when it can.
 * The message is shown to the person as it is.
 */
export function parentProblem(categories: readonly Category[], groupId: string | null, parentId: string | null, height = 1): string | null {
  if (parentId === null) return height > GROUP_LIMITS.depth ? `分组最多 ${GROUP_LIMITS.depth} 层` : null;
  const parent = categories.find((k) => k.id === parentId);
  if (!parent) return '上级分组不存在';
  if (parent.id === UNFILED || (RESERVED_GROUP_IDS.has(parent.id) && parent.id !== LOCKED_CATEGORY.hosted)) return '「未分组」等视图不能有子分组';
  if (groupId !== null && isWithin(categories, groupId, parentId)) return '不能移到它自己或它的子分组里';
  if (depthOf(categories, parentId) + height > GROUP_LIMITS.depth) return `分组最多 ${GROUP_LIMITS.depth} 层`;
  return null;
}

/**
 * Inserts `group` as the `index`-th child of its parent (`undefined` / past the end: the last one).
 * Only the order among siblings is meaningful; the new entry is placed right before the sibling it
 * goes in front of, or right after the last one (a new root group: before 未分组).
 */
export function placeGroup(list: readonly Category[], group: Category, index?: number): Category[] {
  const out = list.filter((k) => k.id !== group.id);
  const parent = parentOf(group);
  const siblings = out.filter((k) => k.id !== UNFILED && parentOf(k) === parent);
  let at: number;
  if (index !== undefined && index >= 0 && index < siblings.length) at = out.indexOf(siblings[index]!);
  else if (siblings.length) {
    // After the last sibling and everything below it in the array.
    const last = siblings.at(-1)!;
    const below = new Set(descendantIds(out, last.id));
    at = out.indexOf(last) + 1;
    while (at < out.length && below.has(out[at]!.id)) at++;
  } else if (parent !== null && out.some((k) => k.id === parent)) at = out.findIndex((k) => k.id === parent) + 1;
  else {
    const unfiled = out.findIndex((k) => k.id === UNFILED);
    at = unfiled < 0 ? out.length : unfiled;
  }
  out.splice(at, 0, group);
  return out;
}

/**
 * The surviving group closest above `id` in the tree `before` (未分组 when none survives): where the
 * favorites and subgroups of a deleted group go.
 */
export function survivingAncestor(before: readonly Category[], id: string, survivors: ReadonlySet<string>): string {
  const byId = new Map(before.map((k) => [k.id, k]));
  const seen = new Set<string>();
  let cur = byId.get(id) ? parentOf(byId.get(id)!) : null;
  while (cur !== null && !seen.has(cur)) {
    if (survivors.has(cur)) return cur;
    seen.add(cur);
    const k = byId.get(cur);
    if (!k) break;
    cur = parentOf(k);
  }
  return UNFILED;
}

/** A free name among the siblings: `资料`, `资料 2`, `资料 3`… (at most 16 characters). */
export function freeSiblingName(categories: readonly Category[], parentId: string | null, label: string, exceptId?: string): string {
  if (!siblingNameTaken(categories, parentId, label, exceptId)) return label;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const candidate = [...label].slice(0, 16 - suffix.length).join('').trim() + suffix;
    if (!siblingNameTaken(categories, parentId, candidate, exceptId)) return candidate;
  }
}

/**
 * A document's groups as a valid tree, whatever wrote it: missing or invalid parents become roots,
 * a cycle is cut where it closes, a group deeper than the limit is attached to the deepest allowed
 * ancestor, 未分组 is a root and nobody's parent. Nothing is renamed or dropped; ids never change.
 */
export function repairGroupTree(categories: readonly Category[]): Category[] {
  const ids = new Set(categories.map((k) => k.id));
  let out = categories.map((k) => {
    const p = parentOf(k);
    if (k.id === UNFILED) return k.parentId === undefined || k.parentId === null ? k : { ...k, parentId: null };
    if (p !== null && (!ids.has(p) || p === k.id || p === UNFILED)) return { ...k, parentId: null };
    return k;
  });
  // Cycles: follow each chain; the group whose parent closes a loop becomes a root.
  const byId = () => new Map(out.map((k) => [k.id, k]));
  for (const start of out.map((k) => k.id)) {
    const map = byId();
    const seen: string[] = [];
    let cur: string | null = start;
    while (cur !== null) {
      if (seen.includes(cur)) {
        const cut = seen.at(-1)!;
        out = out.map((k) => (k.id === cut ? { ...k, parentId: null } : k));
        break;
      }
      seen.push(cur);
      cur = map.get(cur) ? parentOf(map.get(cur)!) : null;
    }
  }
  // Depth: a group below the limit hangs from its deepest allowed ancestor.
  for (const k of [...out]) {
    if (depthOf(out, k.id) <= GROUP_LIMITS.depth) continue;
    const chain: string[] = [];
    const map = byId();
    for (let cur: string | null = parentOf(k); cur !== null && map.has(cur); cur = parentOf(map.get(cur)!)) chain.unshift(cur);
    const newParent = chain[GROUP_LIMITS.depth - 2] ?? null;
    out = out.map((x) => (x.id === k.id ? { ...x, parentId: newParent } : x));
  }
  return out;
}

/** Problems of a tree (for importers and tests); empty when it follows every rule above. */
export function treeProblems(categories: readonly Category[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const k of categories) {
    if (ids.has(k.id)) problems.push(`分组 ${k.id} 重复`);
    ids.add(k.id);
  }
  if (categories.length > GROUP_LIMITS.total) problems.push(`分组超过 ${GROUP_LIMITS.total} 个`);
  for (const k of categories) {
    const p = parentOf(k);
    if (p === null) continue;
    if (k.id === UNFILED) problems.push('「未分组」不能有上级分组');
    else if (!ids.has(p)) problems.push(`分组 ${k.id} 的上级 ${p} 不存在`);
    else if (p === UNFILED) problems.push(`分组 ${k.id} 不能放在「未分组」下`);
    else if (isWithin(categories, k.id, p)) problems.push(`分组 ${k.id} 形成循环`);
  }
  if (!problems.length) {
    for (const k of categories) if (depthOf(categories, k.id) > GROUP_LIMITS.depth) problems.push(`分组 ${k.id} 超过 ${GROUP_LIMITS.depth} 层`);
    const { children } = groupIndex(categories);
    for (const [parent, list] of children) {
      const seen = new Set<string>();
      for (const k of list) {
        if (k.id === UNFILED) continue;
        const key = labelKey(k.label);
        if (seen.has(key)) problems.push(`「${groupPath(categories, parent ?? '').join(' / ') || '根'}」下有两个「${k.label}」`);
        seen.add(key);
      }
    }
  }
  return problems;
}

/** One group of the tree as a page shows it. */
export interface GroupNode {
  id: string;
  label: string;
  parentId: string | null;
  depth: number;
  path: string[];
  locked: boolean;
  children: GroupNode[];
}

/** The groups as a tree (未分组 left out: it is a view), siblings in their order. */
export function groupTree(categories: readonly Category[]): GroupNode[] {
  const { children } = groupIndex(categories);
  const build = (parent: string | null, depth: number, path: string[], seen: Set<string>): GroupNode[] =>
    (children.get(parent) ?? [])
      .filter((k) => k.id !== UNFILED && !seen.has(k.id))
      .map((k) => {
        const p = [...path, k.label];
        const next = new Set(seen).add(k.id);
        return { id: k.id, label: k.label, parentId: parent, depth, path: p, locked: !!k.locked, children: build(k.id, depth + 1, p, next) };
      });
  return build(null, 1, [], new Set());
}

/** What deleting a group does (shown before it is done; the content is kept, never deleted). */
export interface GroupDeleteImpact {
  groupId: string;
  label: string;
  path: string[];
  /** Direct subgroups (they move up one level, keeping their own subgroups). */
  childGroups: { id: string; label: string }[];
  /** All groups below it. */
  descendantGroups: number;
  /** Favorites directly in it (they move to `moveTo`). */
  directItems: number;
  /** Favorites in it and every group below it (those below stay where they are). */
  totalItems: number;
  /** Where its favorites and subgroups go: the parent group, or 未分组 / the root. */
  moveTo: { id: string | null; label: string };
  /** Subgroups renamed because their parent already has one with that name. */
  renamed: { id: string; from: string; to: string }[];
}

export function groupDeleteImpact(categories: readonly Category[], items: readonly { folderId: string; deletedAt?: number | null }[], groupId: string): GroupDeleteImpact | null {
  const g = categories.find((k) => k.id === groupId);
  if (!g) return null;
  const parent = parentOf(g);
  const below = descendantIds(categories, groupId);
  const live = items.filter((i) => !i.deletedAt);
  const { children } = groupIndex(categories);
  const kids = (children.get(groupId) ?? []).filter((k) => k.id !== UNFILED);
  const remaining = categories.filter((k) => k.id !== groupId);
  const renamed: GroupDeleteImpact['renamed'] = [];
  let names = remaining;
  for (const k of kids) {
    const to = freeSiblingName(names, parent, k.label, k.id);
    if (to !== k.label) renamed.push({ id: k.id, from: k.label, to });
    names = names.map((x) => (x.id === k.id ? { ...x, label: to, parentId: parent } : x));
  }
  const parentGroup = parent ? categories.find((k) => k.id === parent) : undefined;
  return {
    groupId,
    label: g.label,
    path: groupPath(categories, groupId),
    childGroups: kids.map((k) => ({ id: k.id, label: k.label })),
    descendantGroups: below.length,
    directItems: live.filter((i) => i.folderId === groupId).length,
    totalItems: live.filter((i) => i.folderId === groupId || below.includes(i.folderId)).length,
    moveTo: parentGroup ? { id: parentGroup.id, label: parentGroup.label } : { id: null, label: SYSTEM_VIEWS.unfiled },
    renamed,
  };
}
