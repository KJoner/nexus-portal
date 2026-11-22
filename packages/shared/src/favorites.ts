import { z } from 'zod';
import { extraOf } from './collection';
import { UNFILED } from './groups';
import { ITEM_LIMITS, ItemUrl, OpIdSchema } from './items';
import { AppSchema, HealthSchema, IconSchema, isPinnable, LOCKED_CATEGORY, MAX_PINS, type AppEntry, type Category, type Config } from './schema';

/**
 * 我的收藏的统一保存 (UI v2 · v12.0.3 N1 data contract). A favorite is one Item; what the home page
 * stores besides its own columns (icon, search aliases, how it opens, service options…) lives in the
 * item's `extra`. The unified editor changes all of it — and the pin — in ONE write: validated and
 * committed in one server transaction or one IndexedDB transaction, or not at all.
 *
 * The rules are here, once, for the server (items/api.ts) and the browser's local collection
 * (local-engine.ts): what a patch may change, which fields it touches (field-level CAS against the
 * version the editor started from), and where moved favorites go in their group.
 */

/** What the editor may set besides the item's own columns (stored in `extra`, field by field). */
export const FAVORITE_APP_KEYS = ['kind', 'description', 'lanUrl', 'prefer', 'hidden', 'showInServices', 'aliases', 'icon', 'openIn', 'health', 'catalogVersion'] as const;
export type FavoriteAppKey = (typeof FAVORITE_APP_KEYS)[number];
export type FavoriteApp = Partial<Pick<AppEntry, FavoriteAppKey>>;

const FolderId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const ItemIdRef = z.string().min(1).max(64);
const Title = z.string().trim().min(1).max(ITEM_LIMITS.title);
const Tags = z.array(z.string().trim().min(1).max(ITEM_LIMITS.tag)).max(ITEM_LIMITS.tags);
const CatalogId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

export const FavoriteAppSchema = z
  .object({
    /** `service`: a self-hosted service (内网地址, 打开偏好, 服务状态). */
    kind: z.enum(['site', 'service']).optional(),
    description: z.string().trim().max(40).optional(),
    lanUrl: z.union([AppSchema.shape.url, z.literal('')]).optional(),
    prefer: z.enum(['ext', 'lan']).optional(),
    hidden: z.boolean().optional(),
    showInServices: z.boolean().optional(),
    aliases: z.array(z.string().trim().max(32)).max(12).optional(),
    icon: IconSchema.optional(),
    openIn: z.enum(['same', 'new']).optional(),
    /** Probing an address is the operator's tool: forced off for everyone else (server rule). */
    health: HealthSchema.optional(),
    catalogVersion: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

/** One favorite to create (手动添加, 应用商店, the extension's popup). */
export const FavoriteInputSchema = z.object({
  /** `app`: listed with the home page's apps (快速打开); `page`: a saved page. Both are favorites. */
  kind: z.enum(['app', 'page']).default('page'),
  title: Title,
  url: ItemUrl,
  folderId: FolderId.optional(),
  tags: Tags.default([]),
  note: z.string().max(ITEM_LIMITS.note).default(''),
  iconRef: z.string().max(256).default(''),
  catalogId: CatalogId.optional(),
  app: FavoriteAppSchema.optional(),
});
export type FavoriteInput = z.input<typeof FavoriteInputSchema>;

/**
 * 添加收藏 (one or many, e.g. 「添加 N 个网站」 from 应用商店), in one transaction.
 *  - `folderId`: the group for entries that name none (default 未分组);
 *  - `pin`: also pin them to the home page — pins over the limit are reported per entry, the
 *    favorites are saved either way (the add dialog says so before it is sent);
 *  - `duplicatePolicy`: `prompt` refuses the whole request when an address is already saved
 *    (409 DUPLICATE, nothing written); `skip` leaves those out and reports them; `update` updates
 *    the saved one; `create` saves another.
 */
export const CreateFavoritesSchema = z.object({
  opId: OpIdSchema,
  source: z.enum(['manual', 'catalog', 'extension', 'import']).default('manual'),
  items: z.array(FavoriteInputSchema).min(1).max(100),
  folderId: FolderId.optional(),
  pin: z.boolean().default(false),
  duplicatePolicy: z.enum(['prompt', 'skip', 'update', 'create']).default('prompt'),
});
export type CreateFavoritesRequest = z.input<typeof CreateFavoritesSchema>;

/** What the unified editor may change in one save. `pin`: pinned or not after the save. */
export const FavoritePatchSchema = z
  .object({
    title: Title,
    url: ItemUrl,
    folderId: FolderId,
    tags: Tags,
    note: z.string().max(ITEM_LIMITS.note),
    iconRef: z.string().max(256),
    kind: z.enum(['app', 'page']),
    app: FavoriteAppSchema,
    pin: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, '没有要修改的字段');
export type FavoritePatch = z.infer<typeof FavoritePatchSchema>;

/** 保存 of the unified editor: field-level CAS against the version the editor started from. */
export const SaveFavoriteSchema = z.object({ opId: OpIdSchema, baseVersion: z.number().int().min(1), patch: FavoritePatchSchema });
export type SaveFavoriteRequest = z.input<typeof SaveFavoriteSchema>;

/**
 * 移动 / 排序 of favorites (drag, 上移 / 下移, 移动到…, batch 移动到分组): the ids, in the order they
 * should have, go into `folderId` right after `afterId` (null: first in the group; absent: last).
 * `baseVersions`: what the client saw; a favorite moved or regrouped elsewhere since is FIELD_CONFLICT.
 */
export const MoveItemsSchema = z.object({
  opId: OpIdSchema,
  ids: z.array(ItemIdRef).min(1).max(200),
  folderId: FolderId,
  afterId: ItemIdRef.nullable().optional(),
  baseVersions: z.record(z.string(), z.number().int().min(1)).optional(),
});
export type MoveItemsRequest = z.input<typeof MoveItemsSchema>;

/** A refusal of a favorites write, shaped like the v2 API errors (status, code, message, details). */
export class FavoriteRefused extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'FavoriteRefused';
  }
}

/** The stored columns a favorite write reads (server row or local row, same meaning). */
export interface FavoriteRow {
  id: string;
  kind: 'app' | 'page';
  title: string;
  url: string;
  folderId: string;
  tags: string[];
  note: string;
  iconRef: string;
  catalogId: string | null;
  extra: string;
  version: number;
  fieldVersions: Record<string, number>;
  deletedAt: number | null;
}

/** Column changes of one favorite write, the field-version keys they touch, and the pin intent. */
export interface FavoritePlan {
  set: Partial<{ title: string; url: string; folderId: string; tags: string[]; note: string; iconRef: string; kind: 'app' | 'page'; extra: string }>;
  /** Keys recorded in field_versions: item columns, `app.<field>` and `extra` for `extra` changes. */
  fields: string[];
  pin: boolean | undefined;
  /** A non-administrator asked for 服务状态: saved switched off (the server never probes for them). */
  healthForcedOff: boolean;
}

const parseJson = <T>(s: string, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const clip = (s: string, n: number) => [...s].slice(0, n).join('').trim();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The home-page entry a favorite stands for (ItemStore.toApp / rowToApp), or null. */
export function favoriteApp(row: Pick<FavoriteRow, 'id' | 'title' | 'url' | 'folderId' | 'catalogId' | 'extra' | 'version'>): AppEntry | null {
  const extra = parseJson<Partial<AppEntry>>(row.extra, {});
  const parsed = AppSchema.safeParse({
    kind: 'site',
    icon: { source: 'auto', ref: '', letter: '', tone: 0 },
    ...extra,
    id: row.id,
    name: clip(row.title, 32) || clip(row.url, 32),
    url: row.url,
    categoryId: row.folderId || LOCKED_CATEGORY.none,
    ...(row.catalogId ? { catalogId: row.catalogId } : {}),
    version: row.version,
  });
  return parsed.success ? parsed.data : null;
}

/** The extra fields as the editor shows them (what `extra` holds, read leniently). */
export function favoriteAppFields(extra: string): FavoriteApp | null {
  const raw = parseJson<Record<string, unknown> | null>(extra, null);
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const k of FAVORITE_APP_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
  return Object.keys(out).length ? (out as FavoriteApp) : null;
}

/**
 * Plans one save of the unified editor: validates the patch against the row and the groups,
 * returns the columns to write and the fields they touch. Throws FavoriteRefused; nothing is
 * written then. A field set to the value it already has is not a change.
 */
export function planFavoriteUpdate(row: FavoriteRow, patch: FavoritePatch, ctx: { admin: boolean; groups: readonly Pick<Category, 'id'>[] }): FavoritePlan {
  const set: FavoritePlan['set'] = {};
  const fields: string[] = [];
  const take = <K extends keyof FavoritePlan['set'] & keyof FavoriteRow>(k: K, v: FavoritePlan['set'][K] | undefined) => {
    if (v === undefined || same(v, row[k])) return;
    (set as Record<string, unknown>)[k] = v;
    fields.push(k);
  };
  if (patch.folderId !== undefined && !ctx.groups.some((g) => g.id === patch.folderId)) throw new FavoriteRefused(422, 'VALIDATION', '分组不存在');
  take('title', patch.title);
  take('url', patch.url);
  take('folderId', patch.folderId);
  take('tags', patch.tags);
  take('note', patch.note);
  take('iconRef', patch.iconRef);
  take('kind', patch.kind);
  let healthForcedOff = false;
  const current = parseJson<Record<string, unknown>>(row.extra, {});
  let extraNext = current;
  if (patch.app) {
    const app = { ...patch.app };
    if (app.health?.enabled && !ctx.admin) {
      app.health = { ...app.health, enabled: false };
      healthForcedOff = true;
    }
    extraNext = { ...current };
    for (const k of FAVORITE_APP_KEYS) {
      const v = (app as Record<string, unknown>)[k];
      if (v === undefined || same(v, current[k])) continue;
      extraNext[k] = v;
      fields.push(`app.${k}`);
    }
  }
  // The result must still be a valid home-page entry (the same check every reader makes).
  const title = set.title ?? row.title;
  const url = set.url ?? row.url;
  const entry = AppSchema.safeParse({ kind: 'site', icon: { source: 'auto', ref: '', letter: '', tone: 0 }, ...extraNext, id: row.id, name: clip(title, 32) || clip(url, 32), url, categoryId: set.folderId ?? row.folderId ?? UNFILED, ...(row.catalogId ? { catalogId: row.catalogId } : {}) });
  if (!entry.success) {
    const i = entry.error.issues[0];
    throw new FavoriteRefused(422, 'VALIDATION', i ? `${i.path.join('.') || '收藏'}：${i.message}` : '收藏不正确');
  }
  if (fields.some((f) => f.startsWith('app.'))) {
    set.extra = extraOf(entry.data);
    fields.push('extra');
  }
  if (patch.pin && !isPinnable(entry.data)) throw new FavoriteRefused(409, 'NOT_PINNABLE', '隐藏的收藏不能固定到首页，先取消隐藏');
  return { set, fields, pin: patch.pin, healthForcedOff };
}

/**
 * Fields of a save that were changed elsewhere after `baseVersion` (FIELD_CONFLICT). An `extra`
 * change by an older writer (the home page's ops record `extra` as a whole) conflicts with every
 * `app.*` field of the save; writers of this release record the field itself as well.
 */
export function favoriteConflicts(fieldVersions: Record<string, number>, fields: readonly string[], baseVersion: number): string[] {
  const extraAt = fieldVersions.extra ?? 0;
  const legacyExtra = extraAt > baseVersion && !Object.entries(fieldVersions).some(([k, v]) => k.startsWith('app.') && v === extraAt);
  return fields.filter((f) => {
    if (f === 'extra') return false;
    if ((fieldVersions[f] ?? 0) > baseVersion) return true;
    return f.startsWith('app.') && legacyExtra;
  });
}

/** What a new favorite stores in `extra`: its home-page entry, when it has one worth keeping. */
export function extraForNew(input: { title: string; url: string; folderId: string; catalogId?: string | null; app?: FavoriteApp }, admin: boolean): { extra: string; healthForcedOff: boolean } {
  if (!input.app || !Object.keys(input.app).length) return { extra: '', healthForcedOff: false };
  let healthForcedOff = false;
  const app = { ...input.app };
  if (app.health?.enabled && !admin) {
    app.health = { ...app.health, enabled: false };
    healthForcedOff = true;
  }
  const entry = AppSchema.safeParse({ kind: 'site', icon: { source: 'auto', ref: '', letter: '', tone: 0 }, ...app, id: 'new', name: clip(input.title, 32) || clip(input.url, 32), url: input.url, categoryId: input.folderId || UNFILED, ...(input.catalogId ? { catalogId: input.catalogId } : {}) });
  if (!entry.success) {
    const i = entry.error.issues[0];
    throw new FavoriteRefused(422, 'VALIDATION', i ? `${i.path.join('.') || '收藏'}：${i.message}` : '收藏不正确');
  }
  return { extra: extraOf(entry.data), healthForcedOff };
}

// ── order within a group (UI v2 N2: positions compare only within a group) ──────────────────
export interface Placed {
  id: string;
  position: number;
}

const GAP_MIN = 1e-6;
const byPosition = (a: Placed, b: Placed) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Positions for `count` favorites put into a group after `afterId` (null: first; undefined: last).
 * `group`: the favorites already in the group (the moving ones left out), any order. When the gap
 * there is used up, `renumber` gives the whole group new, evenly spaced positions in the new order
 * (moved ones included, as `moved[i]`).
 */
export function placeInGroup(group: readonly Placed[], count: number, afterId: string | null | undefined): { positions: number[]; renumber: Placed[] | null } {
  const sorted = [...group].sort(byPosition);
  let at: number;
  if (afterId === undefined) at = sorted.length;
  else if (afterId === null) at = 0;
  else {
    const i = sorted.findIndex((p) => p.id === afterId);
    if (i < 0) throw new FavoriteRefused(409, 'ORDER_CONFLICT', '要放在它后面的那条收藏已不在这个分组里，请刷新后再移动', { order: sorted.map((p) => p.id) });
    at = i + 1;
  }
  const prev = at > 0 ? sorted[at - 1]!.position : null;
  const next = at < sorted.length ? sorted[at]!.position : null;
  let lo: number;
  let hi: number;
  if (prev === null && next === null) [lo, hi] = [0, count + 1];
  else if (prev === null) [lo, hi] = [next! - count - 1, next!];
  else if (next === null) [lo, hi] = [prev, prev + count + 1];
  else [lo, hi] = [prev, next];
  const step = (hi - lo) / (count + 1);
  if (step > GAP_MIN) return { positions: Array.from({ length: count }, (_, i) => lo + step * (i + 1)), renumber: null };
  // No room left between the neighbours: the whole group gets fresh positions, 1, 2, 3…
  const order: (Placed | number)[] = [...sorted.slice(0, at), ...Array.from({ length: count }, (_, i) => i), ...sorted.slice(at)];
  const renumber: Placed[] = [];
  const positions: number[] = [];
  order.forEach((p, i) => {
    if (typeof p === 'number') positions[p] = i + 1;
    else renumber.push({ id: p.id, position: i + 1 });
  });
  return { positions, renumber };
}

/**
 * New positions for the favorites of ONE group after the home page's ops changed their order
 * (`target`: in the order they must have; position NaN for a new one). Those that already are in
 * order keep their position (a longest increasing run); only the others are written, between their
 * neighbours. Favorites of the group the view does not show (pages) are not touched.
 */
export function reorderedPositions(target: readonly { id: string; position: number }[]): Map<string, number> {
  const n = target.length;
  const pos = target.map((t) => t.position);
  // Longest strictly increasing subsequence over the known positions (O(n log n)).
  const tails: number[] = [];
  const prevIdx = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = pos[i]!;
    if (!Number.isFinite(p)) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pos[tails[mid]!]! < p) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevIdx[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prevIdx[k]!) keep.add(k);
  const out = new Map<string, number>();
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (keep.has(i)) {
      last = pos[i]!;
      continue;
    }
    let nextKept: number | null = null;
    for (let j = i + 1; j < n; j++) {
      if (keep.has(j)) {
        nextKept = pos[j]!;
        break;
      }
    }
    // Between the previous one and the next one that stays; after the last, one step further.
    const value = last === -Infinity ? (nextKept === null ? 1 : nextKept - 1) : nextKept === null ? last + 1 : last + (nextKept - last) / 2;
    out.set(target[i]!.id, value);
    last = value;
  }
  return out;
}

/**
 * Positions after the home page's ops (UI v2 N2): per group, the view's apps keep theirs where they
 * already are in order and only the others get one between their neighbours — favorites the view
 * does not show (pages) keep their place. Ids the batch only named (`extra`) are not reordered.
 */
export function viewPositions(apps: readonly AppEntry[], extra: ReadonlySet<string>, positionOf: (id: string) => number | undefined): Map<string, number> {
  const groups = new Map<string, { id: string; position: number }[]>();
  for (const a of apps) {
    if (extra.has(a.id)) continue;
    const list = groups.get(a.categoryId) ?? [];
    list.push({ id: a.id, position: positionOf(a.id) ?? Number.NaN });
    groups.set(a.categoryId, list);
  }
  const out = new Map<string, number>();
  for (const list of groups.values()) for (const [id, p] of reorderedPositions(list)) out.set(id, p);
  return out;
}

// ── 新空间的常用网站 (UI v2 N3) ───────────────────────────────────────────────────────────
/**
 * Seeded once into a NEW space (a new account, a new local collection of a browser or of the
 * extension) with starterVersion 1, in the transaction that creates the space — never into an
 * existing one, never again because the collection is empty, never back after being deleted.
 * Copies of the public catalog (packages/shared/src/catalog/catalog.json, checked by a test):
 * real favorites, editable and deletable like any other, all pinned in this order.
 */
export const STARTER_VERSION = 1;
export const STARTER_GROUPS = [
  { id: 'common', label: '常用' },
  { id: 'work', label: '工作' },
  { id: 'life', label: '生活' },
] as const;
export interface StarterSite {
  catalogId: string;
  catalogVersion: number;
  name: string;
  url: string;
  iconRef: string;
  aliases: string[];
  description: string;
  group: (typeof STARTER_GROUPS)[number]['id'];
}
export const STARTER_SITES: readonly StarterSite[] = [
  { catalogId: 'google', catalogVersion: 1, name: 'Google', url: 'https://www.google.com', iconRef: 'di:google', aliases: ['谷歌', '谷歌搜索'], description: '', group: 'common' },
  { catalogId: 'youtube', catalogVersion: 1, name: 'YouTube', url: 'https://www.youtube.com', iconRef: 'di:youtube', aliases: ['油管'], description: '', group: 'life' },
  { catalogId: 'github', catalogVersion: 1, name: 'GitHub', url: 'https://github.com', iconRef: 'di:github', aliases: ['gh'], description: '', group: 'work' },
  { catalogId: 'gmail', catalogVersion: 1, name: 'Gmail', url: 'https://mail.google.com', iconRef: 'di:gmail', aliases: ['谷歌邮箱', 'google mail'], description: '', group: 'work' },
  { catalogId: 'bing', catalogVersion: 1, name: '必应', url: 'https://www.bing.com', iconRef: 'di:bing', aliases: ['bing', '必应搜索', 'microsoft bing'], description: '', group: 'common' },
  { catalogId: 'bilibili', catalogVersion: 1, name: '哔哩哔哩', url: 'https://www.bilibili.com', iconRef: 'si:bilibili', aliases: ['b站', 'bilibili'], description: '', group: 'life' },
  { catalogId: 'chatgpt', catalogVersion: 1, name: 'ChatGPT', url: 'https://chatgpt.com', iconRef: 'di:chatgpt', aliases: ['openai', 'gpt'], description: '', group: 'common' },
  { catalogId: 'wikipedia', catalogVersion: 1, name: '维基百科', url: 'https://zh.wikipedia.org', iconRef: 'di:wikipedia', aliases: ['wikipedia', 'wiki'], description: '', group: 'common' },
];

/** The home-page entry of a starter site (what its item stores in `extra`). */
export function starterApp(site: StarterSite): AppEntry {
  const icon = site.iconRef.startsWith('di:') ? { source: 'library' as const, ref: site.iconRef.slice(3), letter: '', tone: 0 } : { source: 'library' as const, ref: site.iconRef, letter: '', tone: 0 };
  return {
    id: site.catalogId,
    kind: 'site',
    name: site.name,
    description: site.description,
    url: site.url,
    lanUrl: '',
    prefer: 'ext',
    categoryId: site.group,
    hidden: false,
    showInServices: true,
    aliases: site.aliases,
    icon,
    openIn: 'same',
    health: { enabled: false, target: '/', intervalSec: 60 },
    catalogId: site.catalogId,
    catalogVersion: site.catalogVersion,
  };
}

/**
 * 首页 of a new space (UI v2 N3): the eight starter sites all visible — four in the Dock and one
 * always-open row of four below (4×2; a phone shows two rows of four). Existing spaces keep the
 * layout they have; MAX_PINS stays the limit of what can be pinned at all.
 */
export function starterHome(home: Config['settings']['home']): Config['settings']['home'] {
  return { ...home, dockSize: 4, mobileRows: 2, showServices: false, shortcuts: { ...home.shortcuts, mode: 'double', pageRows: 1 } };
}

// ── 一次性迁移：分组树与服务 (UI v2 N2) ─────────────────────────────────────────────────────
/**
 * What the tree migration did for one space (kept with it: server user_config.tree_migration,
 * local state.migrations.tree). Runs once per space, before anything of this release reads it.
 */
export interface TreeMigration {
  version: 1;
  at: string | null;
  /** The space was created with this release: there was nothing to migrate. */
  fresh?: boolean;
  /** 我的服务 became an ordinary group (same id, same favorites, now movable / renamable / deletable). */
  hostedGroup: { id: string; label: string } | null;
  /** Whether the home page showed its services strip (settings.home.showServices). */
  showServices: boolean;
  /** Services that strip showed, now pinned after the pinned sites (in the strip's order). */
  servicesPinned: string[];
  /** Services it showed that did not fit (pins full): still favorites, not pinned — listed, not lost. */
  servicesNotPinned: string[];
  pinsBefore: string[];
  pinsAfter: string[];
}

/**
 * The tree migration of one space, planned from its home view (`config.apps` = the view, pins in
 * order): 我的服务 unlocked; the services the home page showed are pinned after the sites, as far as
 * the limit allows. Hidden services stay hidden and unpinned; services the strip did not show are
 * not pinned; nothing is unpinned, nothing is moved between groups, no id changes.
 */
export function planTreeMigration(config: Pick<Config, 'apps' | 'pins' | 'categories' | 'settings'>, at: string | null): { categories: Category[]; pins: string[]; record: TreeMigration } {
  const hosted = config.categories.find((k) => k.id === LOCKED_CATEGORY.hosted);
  const categories = config.categories.map((k) => (k.id === LOCKED_CATEGORY.hosted ? { ...k, locked: false, parentId: k.parentId ?? null } : k));
  const showServices = !!config.settings.home.showServices;
  const shown = showServices ? config.apps.filter((a) => a.kind === 'service' && !a.hidden && a.showInServices).map((a) => a.id) : [];
  const pins = [...config.pins];
  const servicesPinned: string[] = [];
  const servicesNotPinned: string[] = [];
  for (const id of shown) {
    if (pins.includes(id)) continue;
    if (pins.length >= MAX_PINS) servicesNotPinned.push(id);
    else {
      pins.push(id);
      servicesPinned.push(id);
    }
  }
  return {
    categories,
    pins,
    record: { version: 1, at, hostedGroup: hosted ? { id: hosted.id, label: hosted.label } : null, showServices, servicesPinned, servicesNotPinned, pinsBefore: [...config.pins], pinsAfter: pins },
  };
}

// ── answers (the server's and the local collection's are the same shape) ───────────────────
/** What 添加收藏 answers: each entry's fate, and what became of the pins asked for. */
export interface CreateFavoritesAnswer {
  results: { index: number; result: 'created' | 'updated' | 'skipped'; item: import('./items').Item; duplicateOf?: string }[];
  pin: { pinned: string[]; notPinned: { id: string; code: 'PINS_FULL' | 'NOT_PINNABLE' }[]; limit: number; used: number };
  /** A non-administrator asked for 服务状态: saved switched off. */
  healthForcedOff?: boolean;
  ownerRevision: number;
}

/** What 保存 of the unified editor answers (the favorite as it is now). */
export type SaveFavoriteAnswer = import('./items').ItemWriteResult & { healthForcedOff?: boolean };

/** What 移动 / 排序 answers: the moved favorites as they are now (folderId, position, version). */
export interface MoveItemsAnswer {
  items: import('./items').Item[];
  ownerRevision: number;
}
