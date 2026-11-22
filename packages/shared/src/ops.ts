import { z } from 'zod';
import { freeSiblingName, GROUP_LIMITS, groupIndex, heightOf, parentProblem, placeGroup, repairGroupTree, RESERVED_GROUP_IDS, siblingNameTaken, survivingAncestor, UNFILED } from './groups';
import {
  AppSchema,
  CategorySchema,
  CONFIG_LIMITS,
  ConfigSchema,
  EngineSchema,
  isPinnable,
  LOCKED_CATEGORY,
  MAX_PINS,
  SettingsSchema,
  type AppEntry,
  type Category,
  type Config,
  type ConfigQuotaKind,
  type Engine,
  type Settings,
  type SettingsSection,
} from './schema';

/**
 * Intent-based configuration changes. The same reducer runs in the browser (optimistic update)
 * and on the server (authoritative write), so concurrent edits from two devices merge by intent
 * instead of overwriting each other.
 */
export type Op =
  | { type: 'pin.add'; appId: string; index?: number }
  | { type: 'pin.remove'; appId: string }
  | { type: 'pin.move'; appId: string; toIndex: number }
  | { type: 'pin.reorder'; order: string[] }
  | { type: 'app.setHidden'; appId: string; hidden: boolean }
  | { type: 'service.setShown'; appId: string; shown: boolean }
  /**
   * `base` (v0.4.1, NEX-04) is the entry as the sending client saw it before this change: `null` for
   * a new app, the old entry for an edit. With it, an edit merges field by field with changes made
   * elsewhere (same field changed on both sides → `conflict`) and never brings back a deleted app.
   * Without it (older clients) an edit of a deleted app is refused as well.
   */
  | { type: 'app.upsert'; app: AppEntry; index?: number; base?: AppEntry | null }
  /** `base`: the entry the client deleted; deleting what was changed elsewhere since is `stale`. */
  | { type: 'app.delete'; appId: string; base?: AppEntry }
  /**
   * The only way back from 回收站 through the home page (撤销删除): explicit, and only for a deletion
   * that happened after `baseVersion` (the version the client saw) and has not been undone since.
   * The server restores its own copy of the entry; `app` places it in the client's optimistic view.
   */
  | { type: 'app.restore'; app: AppEntry; index?: number; baseVersion?: number }
  /** Moves an app to `toIndex` among the apps of `categoryId` (default: its own category). */
  | { type: 'app.move'; appId: string; toIndex: number; categoryId?: string }
  /**
   * Older clients rename, add, reorder and delete groups by sending the whole list. They know nothing
   * of the tree (UI v2): a group they send without `parentId` keeps the parent it has; 我的服务, which
   * their normalizeConfig puts back, is not recreated once deleted (see the reducer).
   */
  | { type: 'categories.replace'; categories: Category[] }
  | { type: 'category.move'; categoryId: string; toIndex: number }
  /**
   * 分组树 (UI v2 · v12.0.3 N2): one change of one group, checked against the rules in groups.ts.
   * `index` is the position among the siblings under `parentId` (absent: last).
   */
  | { type: 'group.create'; group: { id: string; label: string; parentId: string | null }; index?: number }
  | { type: 'group.rename'; groupId: string; label: string }
  | { type: 'group.move'; groupId: string; parentId: string | null; index?: number }
  /** Deletes a group, keeping its content: subgroups and favorites move to its parent (未分组 at the root). */
  | { type: 'group.delete'; groupId: string }
  | { type: 'engine.upsert'; engine: Engine; index?: number }
  | { type: 'engine.delete'; engineId: string }
  | { type: 'engine.move'; engineId: string; toIndex: number }
  | { type: 'settings.patch'; section: SettingsSection; patch: Record<string, unknown> }
  | { type: 'config.replace'; config: Config };

const IdRef = z.string().min(1).max(64);
const Index = z.number().int().min(-1000).max(1000);

/**
 * Structural check for ops arriving over the network. Payloads (app, engine, categories, config)
 * stay `unknown` here because `applyOp` validates them against their full schemas.
 */
export const OpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pin.add'), appId: IdRef, index: Index.optional() }),
  z.object({ type: z.literal('pin.remove'), appId: IdRef }),
  z.object({ type: z.literal('pin.move'), appId: IdRef, toIndex: Index }),
  z.object({ type: z.literal('pin.reorder'), order: z.array(IdRef).max(200) }),
  z.object({ type: z.literal('app.setHidden'), appId: IdRef, hidden: z.boolean() }),
  z.object({ type: z.literal('service.setShown'), appId: IdRef, shown: z.boolean() }),
  z.object({ type: z.literal('app.upsert'), app: z.unknown(), index: Index.optional(), base: z.unknown().optional() }),
  z.object({ type: z.literal('app.delete'), appId: IdRef, base: z.unknown().optional() }),
  z.object({ type: z.literal('app.restore'), app: z.unknown(), index: Index.optional(), baseVersion: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('app.move'), appId: IdRef, toIndex: Index, categoryId: IdRef.optional() }),
  z.object({ type: z.literal('categories.replace'), categories: z.array(z.unknown()).max(50) }),
  z.object({ type: z.literal('category.move'), categoryId: IdRef, toIndex: Index }),
  z.object({ type: z.literal('group.create'), group: z.object({ id: IdRef, label: z.string().max(64), parentId: IdRef.nullable() }), index: Index.optional() }),
  z.object({ type: z.literal('group.rename'), groupId: IdRef, label: z.string().max(64) }),
  z.object({ type: z.literal('group.move'), groupId: IdRef, parentId: IdRef.nullable(), index: Index.optional() }),
  z.object({ type: z.literal('group.delete'), groupId: IdRef }),
  z.object({ type: z.literal('engine.upsert'), engine: z.unknown(), index: Index.optional() }),
  z.object({ type: z.literal('engine.delete'), engineId: IdRef }),
  z.object({ type: z.literal('engine.move'), engineId: IdRef, toIndex: Index }),
  z.object({ type: z.literal('settings.patch'), section: z.enum(['search', 'home', 'look', 'privacy', 'ui']), patch: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('config.replace'), config: z.unknown() }),
]);

export const OpBatchSchema = z.object({
  clientId: z.string().min(1).max(64),
  batchId: z.string().min(1).max(64),
  ops: z.array(OpSchema).min(1).max(100),
});
export type OpBatch = { clientId: string; batchId: string; ops: Op[] };

/**
 * `deleted`, `conflict` and `stale` (v0.4.1, NEX-04) mean another device got there first: the change
 * is not applied, and the client keeps it for the person to decide (never dropped, never forced).
 *  - deleted   an edit of an app deleted elsewhere (it stays in 回收站)
 *  - conflict  a field this edit changes was changed elsewhere too
 *  - stale     a delete of something changed elsewhere since, or a restore of a deletion already undone
 */
export type OpErrorCode = 'not_found' | 'pins_full' | 'not_pinnable' | 'invalid' | 'locked' | 'quota_exceeded' | 'deleted' | 'conflict' | 'stale';

/** The codes above that are a disagreement with another device rather than a bad request. */
export const CONFLICT_CODES: readonly OpErrorCode[] = ['deleted', 'conflict', 'stale'];
/** How the server reports them (the same codes as the 我的收藏 v2 interfaces). */
export const CONFLICT_HTTP_CODE = { deleted: 'ITEM_DELETED', conflict: 'FIELD_CONFLICT', stale: 'REVISION_CONFLICT' } as const;

/** What a quota error says about the limit (same shape as the server's QUOTA_EXCEEDED details). */
export interface QuotaDetails {
  kind: string;
  limit: number;
  used: number;
}

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    /** Present when a per-account limit refused the op (`pins_full` and `quota_exceeded`). */
    readonly quota?: QuotaDetails,
    /** Conflicts: which app, which fields, and what it looks like now (shown to the person). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

/** Deep equality of plain JSON values, key order ignored. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameValue(x, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Every field of an entry except its identity and the version it was read at. */
const contentKeys = (...entries: AppEntry[]) => [...new Set(entries.flatMap((e) => Object.keys(e)))].filter((k) => k !== 'id' && k !== 'version') as (keyof AppEntry)[];

/** Same content (the version an entry was read at does not count). */
export function sameContent(a: AppEntry, b: AppEntry): boolean {
  return contentKeys(a, b).every((k) => sameValue(a[k], b[k]));
}

/** Fields whose value differs between two entries. */
export function changedFields(a: AppEntry, b: AppEntry): string[] {
  return contentKeys(a, b).filter((k) => !sameValue(a[k], b[k]));
}

/** People read these, not the field names. */
export const APP_FIELD_LABELS: Record<string, string> = {
  name: '名称',
  url: '地址',
  categoryId: '分类',
  description: '描述',
  icon: '图标',
  lanUrl: '内网地址',
  prefer: '默认打开方式',
  hidden: '隐藏',
  showInServices: '服务区显示',
  aliases: '别名',
  openIn: '打开位置',
  health: '健康检查',
  kind: '类型',
  catalogId: '目录来源',
  catalogVersion: '目录版本',
};
export const fieldLabels = (fields: readonly string[]) => fields.map((f) => APP_FIELD_LABELS[f] ?? f).join('、');

/**
 * Three-way merge of an edit (NEX-04): `mine` was made from `base`; `current` is what is there now.
 * A field I did not touch keeps the current value; a field I changed takes mine unless it was
 * changed elsewhere to something else too — then it is a conflict and nothing is merged.
 */
export function mergeApp(base: AppEntry, current: AppEntry, mine: AppEntry): { app: AppEntry; conflicts: string[] } {
  const out: Record<string, unknown> = { ...current };
  const conflicts: string[] = [];
  for (const k of contentKeys(base, current, mine)) {
    if (sameValue(mine[k], base[k])) continue;
    if (sameValue(current[k], base[k]) || sameValue(current[k], mine[k])) out[k] = mine[k];
    else conflicts.push(k);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return { app: { ...(out as AppEntry), id: current.id, ...(current.version !== undefined ? { version: current.version } : {}) }, conflicts };
}

const QUOTA_TEXT: Record<ConfigQuotaKind, (limit: number) => string> = {
  apps: (n) => `我的收藏最多 ${n} 个应用，请先删除一些`,
  categories: (n) => `最多 ${n} 个分组`,
  engines: (n) => `最多 ${n} 个搜索引擎`,
  pins: (n) => `首页最多固定 ${n} 个网站`,
};

function quota(kind: ConfigQuotaKind, used: number): OpError {
  const limit = CONFIG_LIMITS[kind];
  return new OpError(kind === 'pins' ? 'pins_full' : 'quota_exceeded', QUOTA_TEXT[kind](limit), { kind, limit, used });
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function findApp(c: Config, id: string): AppEntry {
  const a = c.apps.find((x) => x.id === id);
  if (!a) throw new OpError('not_found', `应用 ${id} 不存在`);
  return a;
}

function insertAt<T>(list: readonly T[], item: T, index: number | undefined): T[] {
  const out = [...list];
  out.splice(index === undefined ? out.length : clamp(index, 0, out.length), 0, item);
  return out;
}

/**
 * Stable sort of `apps` into contiguous blocks following the category order. Within a block the
 * array order is the user's manual order; keeping the blocks contiguous makes every move (and its
 * undo) land at one well-defined array position.
 */
export function groupByCategory(apps: readonly AppEntry[], categories: readonly Category[]): AppEntry[] {
  const rank = new Map(categories.map((k, i) => [k.id, i]));
  const r = (a: AppEntry) => rank.get(a.categoryId) ?? categories.length;
  const sorted = apps.map((a, i) => ({ a, i })).sort((x, y) => r(x.a) - r(y.a) || x.i - y.i);
  return sorted.every((x, i) => x.i === i) ? [...apps] : sorted.map((x) => x.a);
}

/** Inserts `app` as the `index`-th app of its category (clamped; `Infinity` = last) in grouped `apps`. */
function placeIn(apps: AppEntry[], app: AppEntry, index: number, categories: readonly Category[]): AppEntry[] {
  const peers = apps.filter((a) => a.categoryId === app.categoryId);
  const j = Math.max(0, Math.min(index, peers.length));
  let at: number;
  if (j < peers.length) at = apps.indexOf(peers[j]!);
  else if (peers.length) at = apps.indexOf(peers.at(-1)!) + 1;
  else {
    // Empty category: its block starts before the first app of a later category.
    const rank = new Map(categories.map((k, i) => [k.id, i]));
    const mine = rank.get(app.categoryId) ?? categories.length;
    at = apps.findIndex((a) => (rank.get(a.categoryId) ?? categories.length) > mine);
    if (at < 0) at = apps.length;
  }
  const out = [...apps];
  out.splice(at, 0, app);
  return out;
}

/** A group name as stored: trimmed, 1–16 characters. */
function groupLabel(raw: string): string {
  const label = (raw ?? '').trim();
  if (!label) throw new OpError('invalid', '请填写分组名称');
  if ([...label].length > 16) throw new OpError('invalid', '分组名称最多 16 个字符');
  return label;
}

/** The parent a group keeps when its parent goes: the nearest surviving ancestor (none: the root). */
function survivingParent(before: readonly Category[], parentId: string, kept: ReadonlySet<string>): string | null {
  const to = survivingAncestor(before, parentId, kept);
  return to === UNFILED ? null : to;
}

/** Where a favorite goes when its group goes: the nearest surviving ancestor, else 未分组. */
function survivingAncestorOf(before: readonly Category[], id: string, kept: ReadonlySet<string>): string {
  return before.some((k) => k.id === id) ? survivingAncestor(before, id, kept) : UNFILED;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new OpError('invalid', i ? `${i.path.join('.') || 'value'}: ${i.message}` : 'invalid');
  }
  return r.data;
}

/** Applies one op immutably. Throws `OpError` when the op cannot apply; no-ops return the same object. */
export function applyOp(c: Config, op: Op): Config {
  switch (op.type) {
    case 'pin.add': {
      const app = findApp(c, op.appId);
      if (!isPinnable(app)) throw new OpError('not_pinnable', `${app.name} 不能固定到首页`);
      if (c.pins.includes(app.id)) return c;
      if (c.pins.length >= MAX_PINS) throw quota('pins', c.pins.length);
      return { ...c, pins: insertAt(c.pins, app.id, op.index) };
    }
    case 'pin.remove':
      return c.pins.includes(op.appId) ? { ...c, pins: c.pins.filter((x) => x !== op.appId) } : c;
    case 'pin.move': {
      const i = c.pins.indexOf(op.appId);
      if (i < 0) return c;
      const j = clamp(op.toIndex, 0, c.pins.length - 1);
      if (i === j) return c;
      const pins = c.pins.filter((x) => x !== op.appId);
      pins.splice(j, 0, op.appId);
      return { ...c, pins };
    }
    case 'pin.reorder': {
      // Keep only ids that are still pinned, then append pins this client did not know about.
      const known = op.order.filter((id, k) => c.pins.includes(id) && op.order.indexOf(id) === k);
      const pins = [...known, ...c.pins.filter((id) => !known.includes(id))];
      return pins.every((id, k) => id === c.pins[k]) ? c : { ...c, pins };
    }
    case 'app.setHidden': {
      const app = findApp(c, op.appId);
      if (app.hidden === op.hidden) return c;
      return {
        ...c,
        apps: c.apps.map((a) => (a.id === app.id ? { ...a, hidden: op.hidden } : a)),
        pins: op.hidden ? c.pins.filter((x) => x !== app.id) : c.pins,
      };
    }
    case 'service.setShown': {
      const app = findApp(c, op.appId);
      if (app.kind !== 'service' || app.showInServices === op.shown) return c;
      return { ...c, apps: c.apps.map((a) => (a.id === app.id ? { ...a, showInServices: op.shown } : a)) };
    }
    case 'app.upsert': {
      let app = parse(AppSchema, op.app);
      const base = op.base === undefined || op.base === null ? op.base : parse(AppSchema, op.base);
      const prev = c.apps.find((a) => a.id === app.id);
      if (base && !prev) {
        // An edit of something no longer here: deleted elsewhere. Re-adding it would bring it back.
        throw new OpError('deleted', `「${base.name}」已在别处删除，这次修改没有应用`, undefined, { appId: app.id, name: base.name });
      }
      if (base && prev) {
        const merged = mergeApp(base, prev, app);
        if (merged.conflicts.length) throw new OpError('conflict', `「${prev.name}」的${fieldLabels(merged.conflicts)}在别处也被修改了，这次修改没有应用`, undefined, { appId: app.id, name: prev.name, conflictFields: merged.conflicts, current: prev });
        app = merged.app;
        if (sameContent(app, prev)) return c;
      }
      if (!c.categories.some((k) => k.id === app.categoryId)) app.categoryId = LOCKED_CATEGORY.none;
      if (!prev && c.apps.length >= CONFIG_LIMITS.apps) throw quota('apps', c.apps.length);
      let apps: AppEntry[];
      if (prev && prev.categoryId === app.categoryId) apps = c.apps.map((a) => (a.id === app.id ? app : a));
      // An explicit index is an exact array position (undo of a delete).
      else if (!prev && op.index !== undefined) apps = insertAt(c.apps, app, op.index);
      // New app, or a new category: join the end of that category.
      else apps = placeIn(prev ? c.apps.filter((a) => a.id !== app.id) : c.apps, app, Infinity, c.categories);
      const unpin = app.kind !== 'site' || app.hidden;
      return { ...c, apps, pins: unpin ? c.pins.filter((x) => x !== app.id) : c.pins };
    }
    case 'app.delete': {
      const prev = c.apps.find((a) => a.id === op.appId);
      if (!prev) return c;
      if (op.base !== undefined) {
        const base = parse(AppSchema, op.base);
        // Deleting what someone changed after I last saw it: ask first (it is not deleted).
        if (!sameContent(base, prev)) throw new OpError('stale', `「${prev.name}」在别处被修改过（${fieldLabels(changedFields(base, prev))}），没有删除`, undefined, { appId: op.appId, name: prev.name, changedFields: changedFields(base, prev), current: prev });
      }
      return { ...c, apps: c.apps.filter((a) => a.id !== op.appId), pins: c.pins.filter((x) => x !== op.appId) };
    }
    case 'app.restore': {
      const app = parse(AppSchema, op.app);
      // Already back (restored elsewhere, or this is a retry): nothing to do.
      if (c.apps.some((a) => a.id === app.id)) return c;
      if (!c.categories.some((k) => k.id === app.categoryId)) app.categoryId = LOCKED_CATEGORY.none;
      if (c.apps.length >= CONFIG_LIMITS.apps) throw quota('apps', c.apps.length);
      // An explicit index is the exact array position it had (undo of a delete).
      const apps = op.index !== undefined ? insertAt(c.apps, app, op.index) : placeIn(c.apps, app, Infinity, c.categories);
      return { ...c, apps };
    }
    case 'app.move': {
      const app = findApp(c, op.appId);
      const categoryId = op.categoryId ?? app.categoryId;
      // UI v2 (N2): a service is a favorite with service options and may sit in any group.
      if (categoryId !== app.categoryId && !c.categories.some((k) => k.id === categoryId)) throw new OpError('not_found', '分组不存在');
      const moved = categoryId === app.categoryId ? app : { ...app, categoryId };
      const apps = placeIn(
        c.apps.filter((a) => a.id !== app.id),
        moved,
        op.toIndex,
        c.categories,
      );
      return apps.every((a, k) => a === c.apps[k]) ? c : { ...c, apps };
    }
    case 'category.move': {
      const i = c.categories.findIndex((k) => k.id === op.categoryId);
      if (i < 0) return c;
      const j = clamp(op.toIndex, 0, c.categories.length - 1);
      if (i === j) return c;
      const categories = [...c.categories];
      const [k] = categories.splice(i, 1);
      categories.splice(j, 0, k!);
      return { ...c, categories, apps: groupByCategory(c.apps, categories) };
    }
    case 'categories.replace': {
      if (op.categories.length > CONFIG_LIMITS.categories) throw quota('categories', c.categories.length);
      const current = new Map(c.categories.map((k) => [k.id, k]));
      // Groups that are locked now (未分组) cannot be dropped by a client.
      for (const k of c.categories) {
        if (k.locked && !op.categories.some((x) => (x as { id?: unknown } | null)?.id === k.id)) throw new OpError('locked', k.id === UNFILED ? '「未分组」不能删除' : `「${k.label}」不能删除`);
      }
      const incoming = op.categories
        .map((raw) => parse(CategorySchema, raw))
        // An older client's normalizeConfig puts 我的服务 back after it was deleted: not recreated.
        .filter((k) => !(k.id === LOCKED_CATEGORY.hosted && !current.has(k.id)));
      // Old clients send no parentId: such a group keeps its place in the tree. The server, not the
      // client, decides what is locked.
      let categories = incoming.map((k) => {
        const was = current.get(k.id);
        return { ...k, locked: was ? !!was.locked : k.id === UNFILED, ...(k.parentId === undefined && was?.parentId !== undefined ? { parentId: was.parentId } : {}) };
      });
      // A parent that is not in the list any more: the nearest one of its ancestors that is.
      const kept = new Set(categories.map((k) => k.id));
      categories = categories.map((k) => (k.parentId && !kept.has(k.parentId) ? { ...k, parentId: survivingParent(c.categories, k.parentId, kept) } : k));
      categories = repairGroupTree(categories);
      const ids = new Set(categories.map((k) => k.id));
      const apps = c.apps.map((a) => (ids.has(a.categoryId) ? a : { ...a, categoryId: survivingAncestorOf(c.categories, a.categoryId, ids) }));
      return { ...c, categories, apps: groupByCategory(apps, categories) };
    }
    case 'group.create': {
      const label = groupLabel(op.group.label);
      const id = op.group.id;
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || id.length > 64) throw new OpError('invalid', '分组 id 不正确');
      if (RESERVED_GROUP_IDS.has(id) || c.categories.some((k) => k.id === id)) throw new OpError('invalid', '分组已存在');
      if (c.categories.length >= GROUP_LIMITS.total) throw quota('categories', c.categories.length);
      const parentId = op.group.parentId ?? null;
      const problem = parentProblem(c.categories, null, parentId);
      if (problem) throw new OpError(parentId && !c.categories.some((k) => k.id === parentId) ? 'not_found' : 'invalid', problem);
      if (siblingNameTaken(c.categories, parentId, label)) throw new OpError('invalid', `这一层已经有「${label}」了`);
      return { ...c, categories: placeGroup(c.categories, { id, label, locked: false, parentId }, op.index) };
    }
    case 'group.rename': {
      const g = c.categories.find((k) => k.id === op.groupId);
      if (!g) throw new OpError('not_found', '分组不存在');
      if (g.locked) throw new OpError('locked', `「${g.label}」不能改名`);
      const label = groupLabel(op.label);
      if (label === g.label) return c;
      if (siblingNameTaken(c.categories, g.parentId ?? null, label, g.id)) throw new OpError('invalid', `这一层已经有「${label}」了`);
      return { ...c, categories: c.categories.map((k) => (k.id === g.id ? { ...k, label } : k)) };
    }
    case 'group.move': {
      const g = c.categories.find((k) => k.id === op.groupId);
      if (!g) throw new OpError('not_found', '分组不存在');
      if (g.locked) throw new OpError('locked', `「${g.label}」不能移动`);
      const parentId = op.parentId ?? null;
      const problem = parentProblem(c.categories, g.id, parentId, heightOf(c.categories, g.id));
      if (problem) throw new OpError(parentId && !c.categories.some((k) => k.id === parentId) ? 'not_found' : 'invalid', problem);
      if (siblingNameTaken(c.categories, parentId, g.label, g.id)) throw new OpError('invalid', `目标位置已经有「${g.label}」了`);
      const siblings = c.categories.filter((k) => k.id !== UNFILED && (k.parentId ?? null) === parentId && k.id !== g.id);
      const at = op.index === undefined ? siblings.length : clamp(op.index, 0, siblings.length);
      const now = c.categories.filter((k) => k.id !== UNFILED && (k.parentId ?? null) === (g.parentId ?? null));
      if ((g.parentId ?? null) === parentId && now.indexOf(g) === at) return c;
      const categories = placeGroup(c.categories, { ...g, parentId }, at);
      return { ...c, categories, apps: groupByCategory(c.apps, categories) };
    }
    case 'group.delete': {
      const g = c.categories.find((k) => k.id === op.groupId);
      if (!g) return c;
      if (g.locked) throw new OpError('locked', `「${g.label}」不能删除`);
      const parentId = g.parentId ?? null;
      // Subgroups move up one level into its place (keeping their own subgroups and their order);
      // one whose name the new level already has gets a free one (资料 → 资料 2).
      const { children } = groupIndex(c.categories);
      const kids = (children.get(g.id) ?? []).filter((k) => k.id !== UNFILED);
      const slot = c.categories.filter((k) => k.id !== UNFILED && (k.parentId ?? null) === parentId).indexOf(g);
      let categories = c.categories.filter((k) => k.id !== g.id);
      kids.forEach((k, i) => {
        const label = freeSiblingName(categories, parentId, k.label, k.id);
        categories = placeGroup(categories, { ...k, label, parentId }, slot + i);
      });
      categories = repairGroupTree(categories);
      // Its favorites go to the parent group, or to 未分组 at the root (the content is kept).
      const target = parentId ?? UNFILED;
      const apps = c.apps.map((a) => (a.categoryId === g.id ? { ...a, categoryId: target } : a));
      return { ...c, categories, apps: groupByCategory(apps, categories) };
    }
    case 'engine.upsert': {
      const engine = parse(EngineSchema, op.engine);
      const exists = c.engines.some((e) => e.id === engine.id);
      if (!exists && c.engines.length >= CONFIG_LIMITS.engines) throw quota('engines', c.engines.length);
      const engines = exists ? c.engines.map((e) => (e.id === engine.id ? engine : e)) : insertAt(c.engines, engine, op.index);
      return { ...c, engines };
    }
    case 'engine.delete': {
      const engine = c.engines.find((e) => e.id === op.engineId);
      if (!engine) return c;
      if (engine.builtin) throw new OpError('locked', '内置引擎不能删除');
      const engines = c.engines.filter((e) => e.id !== op.engineId);
      const search = c.settings.search.defaultEngine === op.engineId ? { ...c.settings.search, defaultEngine: engines[0]!.id } : c.settings.search;
      return { ...c, engines, settings: { ...c.settings, search } };
    }
    case 'engine.move': {
      const i = c.engines.findIndex((e) => e.id === op.engineId);
      if (i < 0) return c;
      const j = clamp(op.toIndex, 0, c.engines.length - 1);
      if (i === j) return c;
      const engines = [...c.engines];
      const [e] = engines.splice(i, 1);
      engines.splice(j, 0, e!);
      return { ...c, engines };
    }
    case 'settings.patch': {
      const shape = SettingsSchema.shape[op.section];
      if (!shape) throw new OpError('invalid', `未知设置分组 ${String(op.section)}`);
      const next = parse(shape as z.ZodType<Settings[typeof op.section]>, { ...c.settings[op.section], ...op.patch });
      if (op.section === 'search') {
        const s = next as Settings['search'];
        if (!c.engines.some((e) => e.id === s.defaultEngine)) throw new OpError('invalid', '默认引擎不存在');
      }
      return { ...c, settings: { ...c.settings, [op.section]: next } };
    }
    case 'config.replace': {
      // An import over a limit says which one, instead of a schema message.
      const raw = (op.config ?? {}) as Partial<Record<ConfigQuotaKind, unknown>>;
      for (const kind of ['apps', 'categories', 'engines', 'pins'] as const) {
        const list = raw[kind];
        if (Array.isArray(list) && list.length > CONFIG_LIMITS[kind]) throw new OpError('quota_exceeded', `导入的配置超过上限：${QUOTA_TEXT[kind](CONFIG_LIMITS[kind])}`, { kind, limit: CONFIG_LIMITS[kind], used: list.length });
      }
      return normalizeConfig(parse(ConfigSchema, op.config));
    }
  }
}

export function applyOps(c: Config, ops: readonly Op[]): Config {
  return ops.reduce(applyOp, c);
}

/**
 * Records what the client saw (NEX-04) on an op it is about to apply: the entry an edit or a delete
 * starts from (`null` for a new app). Ops that already carry a base keep it (a retried or resolved
 * change keeps the base it was made from).
 */
export function withBase(c: Config, op: Op): Op {
  if (op.type === 'app.upsert' && op.base === undefined) return { ...op, base: c.apps.find((a) => a.id === op.app.id) ?? null };
  if (op.type === 'app.delete' && op.base === undefined) {
    const prev = c.apps.find((a) => a.id === op.appId);
    return prev ? { ...op, base: prev } : op;
  }
  return op;
}

/** Repairs cross references that the schema alone cannot express. */
export function normalizeConfig(c: Config): Config {
  const ids = new Set(c.apps.map((a) => a.id));
  const catIds = new Set(c.categories.map((k) => k.id));
  // UI v2 (N2): 未分组 always exists (it is the view of favorites without a group); 我的服务 is an
  // ordinary group since the tree migration and is not put back once deleted.
  let categories = [...c.categories];
  if (!catIds.has(LOCKED_CATEGORY.none)) categories.push({ id: LOCKED_CATEGORY.none, label: '未分组', locked: true, parentId: null });
  categories = repairGroupTree(categories);
  const allCats = new Set(categories.map((k) => k.id));
  const apps = groupByCategory(
    c.apps.map((a) => (allCats.has(a.categoryId) ? a : { ...a, categoryId: LOCKED_CATEGORY.none })),
    categories,
  );
  const pinnable = new Set(apps.filter(isPinnable).map((a) => a.id));
  const pins = [...new Set(c.pins)].filter((id) => ids.has(id) && pinnable.has(id)).slice(0, MAX_PINS);
  const engines = c.engines.length ? c.engines : [];
  const defaultEngine = engines.some((e) => e.id === c.settings.search.defaultEngine) ? c.settings.search.defaultEngine : (engines[0]?.id ?? 'google');
  return { ...c, apps, categories, pins, settings: { ...c.settings, search: { ...c.settings.search, defaultEngine } } };
}

/** Moves `app` back to the category and position it has in `before`. */
function restorePlace(before: Config, app: AppEntry): Op {
  const index = before.apps.filter((a) => a.categoryId === app.categoryId).indexOf(app);
  return { type: 'app.move', appId: app.id, categoryId: app.categoryId, toIndex: index };
}

/**
 * Ops that undo `op` when applied after it. Computed from the state *before* `op` ran,
 * so that undo is itself an ordinary op that syncs like any other change.
 */
export function invertOp(before: Config, op: Op): Op[] {
  switch (op.type) {
    case 'pin.add':
      return before.pins.includes(op.appId) ? [] : [{ type: 'pin.remove', appId: op.appId }];
    case 'pin.remove': {
      const i = before.pins.indexOf(op.appId);
      return i < 0 ? [] : [{ type: 'pin.add', appId: op.appId, index: i }];
    }
    case 'pin.move': {
      const i = before.pins.indexOf(op.appId);
      return i < 0 ? [] : [{ type: 'pin.move', appId: op.appId, toIndex: i }];
    }
    case 'pin.reorder':
      return [{ type: 'pin.reorder', order: [...before.pins] }];
    case 'app.setHidden': {
      const app = before.apps.find((a) => a.id === op.appId);
      if (!app || app.hidden === op.hidden) return [];
      const out: Op[] = [{ type: 'app.setHidden', appId: op.appId, hidden: app.hidden }];
      const i = before.pins.indexOf(op.appId);
      if (i >= 0) out.push({ type: 'pin.add', appId: op.appId, index: i });
      return out;
    }
    case 'service.setShown': {
      const app = before.apps.find((a) => a.id === op.appId);
      return app ? [{ type: 'service.setShown', appId: op.appId, shown: app.showInServices }] : [];
    }
    case 'app.upsert': {
      const i = before.apps.findIndex((a) => a.id === op.app.id);
      if (i < 0) return [{ type: 'app.delete', appId: op.app.id }];
      const prev = before.apps[i]!;
      const out: Op[] = [{ type: 'app.upsert', app: prev }];
      // A category change moved it to the end of the new category; put it back where it was.
      if (op.app.categoryId !== prev.categoryId) out.push(restorePlace(before, prev));
      const p = before.pins.indexOf(op.app.id);
      if (p >= 0) out.push({ type: 'pin.add', appId: op.app.id, index: p });
      return out;
    }
    case 'app.move': {
      const app = before.apps.find((a) => a.id === op.appId);
      return app ? [restorePlace(before, app)] : [];
    }
    case 'category.move': {
      const i = before.categories.findIndex((k) => k.id === op.categoryId);
      return i < 0 ? [] : [{ type: 'category.move', categoryId: op.categoryId, toIndex: i }];
    }
    case 'group.create':
      return before.categories.some((k) => k.id === op.group.id) ? [] : [{ type: 'group.delete', groupId: op.group.id }];
    case 'group.rename': {
      const g = before.categories.find((k) => k.id === op.groupId);
      return g ? [{ type: 'group.rename', groupId: g.id, label: g.label }] : [];
    }
    case 'group.move': {
      const g = before.categories.find((k) => k.id === op.groupId);
      if (!g) return [];
      const parentId = g.parentId ?? null;
      const index = before.categories.filter((k) => k.id !== UNFILED && (k.parentId ?? null) === parentId).indexOf(g);
      return [{ type: 'group.move', groupId: g.id, parentId, index }];
    }
    // Deleting a group is confirmed first (its favorites outside the home view move in the tables):
    // there is no automatic undo.
    case 'group.delete':
      return [];
    case 'app.delete': {
      const i = before.apps.findIndex((a) => a.id === op.appId);
      if (i < 0) return [];
      const prev = before.apps[i]!;
      // 撤销删除 is an explicit restore of this deletion (NEX-04), never an upsert of the old entry.
      const out: Op[] = [{ type: 'app.restore', app: prev, index: i, ...(prev.version !== undefined ? { baseVersion: prev.version } : {}) }];
      const p = before.pins.indexOf(op.appId);
      if (p >= 0) out.push({ type: 'pin.add', appId: op.appId, index: p });
      return out;
    }
    case 'app.restore':
      return before.apps.some((a) => a.id === op.app.id) ? [] : [{ type: 'app.delete', appId: op.app.id }];
    case 'categories.replace': {
      const ids = new Set(op.categories.map((k) => k.id));
      const moved = before.apps.filter((a) => !ids.has(a.categoryId));
      return [{ type: 'categories.replace', categories: before.categories }, ...moved.flatMap((a): Op[] => [{ type: 'app.upsert', app: a }, restorePlace(before, a)])];
    }
    case 'engine.upsert': {
      const i = before.engines.findIndex((e) => e.id === op.engine.id);
      return i < 0 ? [{ type: 'engine.delete', engineId: op.engine.id }] : [{ type: 'engine.upsert', engine: before.engines[i]! }];
    }
    case 'engine.delete': {
      const i = before.engines.findIndex((e) => e.id === op.engineId);
      if (i < 0) return [];
      const out: Op[] = [{ type: 'engine.upsert', engine: before.engines[i]!, index: i }];
      if (before.settings.search.defaultEngine === op.engineId) out.push({ type: 'settings.patch', section: 'search', patch: { defaultEngine: op.engineId } });
      return out;
    }
    case 'engine.move': {
      const i = before.engines.findIndex((e) => e.id === op.engineId);
      return i < 0 ? [] : [{ type: 'engine.move', engineId: op.engineId, toIndex: i }];
    }
    case 'settings.patch': {
      const prev = before.settings[op.section] as Record<string, unknown>;
      const patch = Object.fromEntries(Object.keys(op.patch).map((k) => [k, prev[k]]));
      return [{ type: 'settings.patch', section: op.section, patch }];
    }
    case 'config.replace':
      return [{ type: 'config.replace', config: before }];
  }
}
