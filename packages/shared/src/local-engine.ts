import type { ConfigResponse, UploadedWallpaper } from './api';
import { COLLECTION_FORMAT, COLLECTION_VERSION, CollectionFileSchema, extraOf, newItemId, planRestore, restoreSummary, type DuplicatePolicy } from './collection';
import { newUserConfig } from './defaults';
import { CreateFavoritesSchema, extraForNew, FavoriteRefused, favoriteAppFields, favoriteConflicts, MoveItemsSchema, placeInGroup, planFavoriteUpdate, planTreeMigration, SaveFavoriteSchema, STARTER_SITES, STARTER_VERSION, starterApp, type CreateFavoritesRequest, type MoveItemsRequest, type SaveFavoriteRequest, type TreeMigration, viewPositions } from './favorites';
import { BookmarkImportSchema, bookmarkGroup, newGroupId, planBookmarkTree, type BookmarkImportRequest } from './bookmarks';
import { survivingAncestor, UNFILED } from './groups';
import { ITEM_LIMITS, ItemInputSchema, ItemPatchSchema, itemUrlKey, OpIdSchema, type ChangesResponse, type Item, type ItemChange, type ItemInput, type ItemKind, type ItemPatch, type ItemSource, type ItemWriteResult, type SnapshotResponse } from './items';
import { applyOps, normalizeConfig, OpError, type Op, type OpBatch } from './ops';
import { AppSchema, ConfigSchema, isPinnable, LOCKED_CATEGORY, MAX_PINS, type AppEntry, type Config, type Snapshot } from './schema';

/**
 * 本地收藏 (v0.5 · UI 焕新 U1): the collection of one browser (or one browser extension) when
 * nobody is signed in — or when the person chose to keep using it after signing in.
 *
 * It is the server's data model, run in the browser: items (all saved pages and apps, deleted ones
 * as tombstones), the pin order, and the configuration document (categories, engines, settings);
 * the home page's `config.apps` / `config.pins` are a view over the items exactly as on the server
 * (ItemStore.homeView, NEX-07's one pin rule, NEX-04's explicit restores). Pure: no storage, no
 * network, no clock of its own — the caller (apps/web/src/data/local) runs each function inside one
 * IndexedDB transaction over a fresh copy of the state and writes it back only when it returns.
 *
 * Identical rules mean identical behaviour for the person, and that a local collection merged into an
 * account (a `nexus-collection` export restored on the server) lands exactly as it looked here.
 */
export const LOCAL_FORMAT = 'nexus-local';
export const LOCAL_SCHEMA = 1;
/** The same item limit as an ordinary account (DEFAULT_QUOTAS), so a merge never surprises. */
export const LOCAL_LIMITS = { items: 5000, wallpapers: 50, icons: 200, changes: 2000, ops: 400, batches: 300 } as const;

/** An answer the local collection refuses with, shaped like the server's v2 errors. */
export class LocalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'LocalApiError';
  }
}

export interface LocalRow {
  id: string;
  kind: ItemKind;
  source: ItemSource;
  catalogId: string | null;
  title: string;
  url: string;
  urlKey: string;
  folderId: string;
  tags: string[];
  note: string;
  iconRef: string;
  /** The home page's entry besides the item's own columns (JSON, as the server stores it). */
  extra: string;
  position: number;
  version: number;
  /** Version at which each field last changed (field-level CAS), and `restored`. */
  fieldVersions: Record<string, number>;
  importId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface LocalChange {
  seq: number;
  entity: 'item' | 'pins' | 'folders';
  id: string;
  version: number;
  action: ItemChange['action'];
}

export interface LocalState {
  format: typeof LOCAL_FORMAT;
  schema: typeof LOCAL_SCHEMA;
  /** `local:<installation id>` — never an account, never shared with one. */
  workspace: string;
  revision: number;
  updatedAt: string;
  /** The configuration document without apps and pins (those are the items' view). */
  doc: Omit<Config, 'apps' | 'pins'>;
  rows: Record<string, LocalRow>;
  /** Pin order as written; readers go through pinnedIds (live, pinnable, at most MAX_PINS). */
  pins: string[];
  seq: number;
  changes: LocalChange[];
  /** Uploaded wallpapers; their files live next to the state (asset store). */
  wallpapers: UploadedWallpaper[];
  /** Answers of item writes by opId (a retry is answered, never applied twice). */
  ops: Record<string, { hash: string; status: number; result: unknown; at: number }>;
  /** Configuration batches already applied (newest last). */
  batches: string[];
  /** What a restore added, for 撤销本次导入. */
  imports: Record<string, { folders: { id: string; label: string }[]; pins: string[]; at: number }>;
  /**
   * UI v2 (N3): the starter set this collection was created with (STARTER_VERSION), or absent for a
   * collection created before — never inferred from an empty collection.
   */
  starterVersion?: number;
  /** One-time migrations of this collection (N2: the group tree and the services). */
  migrations?: { tree?: TreeMigration };
}

/**
 * A fresh collection: the public new-space template (no private services). UI v2 (N3): with the
 * eight starter sites as real favorites, pinned, and starterVersion 1 — created here, in the
 * transaction that creates the collection, and never again (`starter: false`: an empty one, for
 * tests and tools).
 */
export function emptyLocalState(workspace: string, now: number, opts: { starter?: boolean } = {}): LocalState {
  const { apps: _apps, pins: _pins, ...doc } = newUserConfig();
  const at = new Date(now).toISOString();
  const s: LocalState = { format: LOCAL_FORMAT, schema: LOCAL_SCHEMA, workspace, revision: 1, updatedAt: at, doc, rows: {}, pins: [], seq: 0, changes: [], wallpapers: [], ops: {}, batches: [], imports: {} };
  if (opts.starter !== false) {
    STARTER_SITES.forEach((site, i) => {
      insert(s, { id: site.catalogId, kind: 'app', source: 'catalog', catalogId: site.catalogId, title: site.name, url: site.url, folderId: site.group, extra: extraOf(starterApp(site)), position: i + 1 }, now);
    });
    s.pins = STARTER_SITES.map((site) => site.catalogId);
    change(s, 'pins', 'shared', s.seq, 'pins');
    s.starterVersion = STARTER_VERSION;
  }
  s.migrations = { tree: { version: 1, at, fresh: true, hostedGroup: null, showServices: false, servicesPinned: [], servicesNotPinned: [], pinsBefore: [], pinsAfter: [...s.pins] } };
  return s;
}

/**
 * N2, once per collection created before the tree: 我的服务 becomes an ordinary group and the
 * services its home page showed are pinned after the sites (planTreeMigration). Deterministic, so a
 * read that has not been written back yet gives the same result; recorded in migrations.tree.
 */
function migrateLocalTree(s: LocalState): void {
  const view = homeView(s);
  const plan = planTreeMigration({ ...s.doc, apps: view.apps, pins: view.pins }, s.updatedAt);
  if (JSON.stringify(plan.categories) !== JSON.stringify(s.doc.categories)) {
    s.doc = { ...s.doc, categories: plan.categories };
    change(s, 'folders', 'shared', s.seq, 'folders');
  }
  if (plan.record.servicesPinned.length) {
    s.pins = plan.pins;
    change(s, 'pins', 'shared', s.seq, 'pins');
  }
  s.migrations = { ...s.migrations, tree: plan.record };
}

/** A stored state that still reads (an older or damaged record reads as null, never as data). */
export function readLocalState(raw: unknown): LocalState | null {
  const s = raw as Partial<LocalState> | null;
  if (!s || s.format !== LOCAL_FORMAT || s.schema !== LOCAL_SCHEMA || typeof s.workspace !== 'string' || !s.doc || !s.rows || typeof s.rows !== 'object') return null;
  const doc = ConfigSchema.safeParse({ ...s.doc, apps: [], pins: [] });
  if (!doc.success) return null;
  const { apps: _a, pins: _p, ...rest } = normalizeConfig(doc.data);
  const state: LocalState = {
    format: LOCAL_FORMAT,
    schema: LOCAL_SCHEMA,
    workspace: s.workspace,
    revision: Number(s.revision) || 1,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date(0).toISOString(),
    doc: rest,
    rows: s.rows,
    pins: Array.isArray(s.pins) ? s.pins : [],
    seq: Number(s.seq) || 0,
    changes: Array.isArray(s.changes) ? s.changes : [],
    wallpapers: Array.isArray(s.wallpapers) ? s.wallpapers : [],
    ops: s.ops && typeof s.ops === 'object' ? s.ops : {},
    batches: Array.isArray(s.batches) ? s.batches : [],
    imports: s.imports && typeof s.imports === 'object' ? s.imports : {},
    ...(typeof s.starterVersion === 'number' ? { starterVersion: s.starterVersion } : {}),
    ...(s.migrations && typeof s.migrations === 'object' ? { migrations: s.migrations } : {}),
  };
  if (!state.migrations?.tree) migrateLocalTree(state);
  return state;
}

// ── rows ───────────────────────────────────────────────────────────────────
const APP_NAME_MAX = 32;
const clip = (s: string, n: number) => [...s].slice(0, n).join('').trim();
const parse = <T>(s: string, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function toItem(r: LocalRow, pinned: ReadonlySet<string>): Item {
  return { id: r.id, kind: r.kind, source: r.source, catalogId: r.catalogId, title: r.title, url: r.url, folderId: r.folderId, tags: [...r.tags], note: r.note, iconRef: r.iconRef, version: r.version, pinned: pinned.has(r.id), position: r.position, createdAt: r.createdAt, updatedAt: r.updatedAt, deletedAt: r.deletedAt, importId: r.importId, app: favoriteAppFields(r.extra) };
}

/** The home page's view of an item (ItemStore.toApp); null when it cannot be shown there. */
export function rowToApp(r: LocalRow): AppEntry | null {
  const extra = parse<Partial<AppEntry>>(r.extra, {});
  const parsed = AppSchema.safeParse({
    kind: 'site',
    icon: { source: 'auto', ref: '', letter: '', tone: 0 },
    ...extra,
    id: r.id,
    name: clip(r.title, APP_NAME_MAX) || clip(r.url, APP_NAME_MAX),
    url: r.url,
    categoryId: r.folderId || LOCKED_CATEGORY.none,
    ...(r.catalogId ? { catalogId: r.catalogId } : {}),
    version: r.version,
  });
  return parsed.success ? parsed.data : null;
}

const ordered = (s: LocalState) => Object.values(s.rows).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const liveRows = (s: LocalState) => ordered(s).filter((r) => r.deletedAt === null);

/** The pins every reader sees (NEX-07): live, pinnable, at most MAX_PINS, in order. */
export function pinnedIds(s: LocalState): string[] {
  return s.pins
    .filter((id) => {
      const r = s.rows[id];
      if (!r || r.deletedAt !== null) return false;
      const app = rowToApp(r);
      return !!app && isPinnable(app);
    })
    .slice(0, MAX_PINS);
}

function change(s: LocalState, entity: LocalChange['entity'], id: string, version: number, action: LocalChange['action']): void {
  s.seq += 1;
  s.changes.push({ seq: s.seq, entity, id, version, action });
  if (s.changes.length > LOCAL_LIMITS.changes) s.changes.splice(0, s.changes.length - LOCAL_LIMITS.changes);
}

class PinRefused extends Error {
  constructor(
    readonly code: 'PINS_FULL' | 'NOT_PINNABLE' | 'NOT_FOUND' | 'ITEM_DELETED',
    message: string,
    readonly used: number,
  ) {
    super(message);
  }
}

/** The one rule for every way of pinning (ItemStore.writePins). */
function writePins(s: LocalState, ids: readonly string[]): string[] {
  const list = [...new Set(ids)];
  const before = pinnedIds(s);
  if (list.length > MAX_PINS) throw new PinRefused('PINS_FULL', `首页最多固定 ${MAX_PINS} 个`, before.length);
  for (const id of list) {
    const r = s.rows[id];
    if (!r) throw new PinRefused('NOT_FOUND', '收藏不存在', before.length);
    if (r.deletedAt !== null) throw new PinRefused('ITEM_DELETED', `「${r.title}」已被删除，不能固定`, before.length);
    const app = rowToApp(r);
    if (!app || !isPinnable(app)) throw new PinRefused('NOT_PINNABLE', `「${r.title}」不能固定到首页（隐藏的收藏先取消隐藏）`, before.length);
  }
  const same = list.length === before.length && list.every((id, i) => id === before[i]);
  if (same && s.pins.length === list.length) return before;
  s.pins = list;
  change(s, 'pins', 'shared', s.seq, 'pins');
  return list;
}

function pin(s: LocalState, id: string, position?: number): string[] {
  const pins = pinnedIds(s);
  const rest = pins.filter((x) => x !== id);
  if (!pins.includes(id) && pins.length >= MAX_PINS) throw new PinRefused('PINS_FULL', `首页最多固定 ${MAX_PINS} 个`, pins.length);
  if (pins.includes(id) && position === undefined) return pins;
  rest.splice(Math.min(position ?? rest.length, rest.length), 0, id);
  return writePins(s, rest);
}

function unpin(s: LocalState, id: string): string[] {
  const pins = pinnedIds(s);
  return pins.includes(id) ? writePins(s, pins.filter((x) => x !== id)) : pins;
}

interface Draft {
  id?: string;
  kind: ItemKind;
  source: ItemSource;
  catalogId?: string | null;
  title: string;
  url: string;
  folderId: string;
  tags?: string[];
  note?: string;
  iconRef?: string;
  extra?: string;
  position?: number;
  importId?: string | null;
  createdAt?: number;
}

const maxPosition = (s: LocalState) => Object.values(s.rows).reduce((m, r) => Math.max(m, r.position), 0);

function insert(s: LocalState, d: Draft, now: number): LocalRow {
  const id = d.id ?? freeItemId(s);
  const row: LocalRow = {
    id,
    kind: d.kind,
    source: d.source,
    catalogId: d.catalogId ?? null,
    title: d.title,
    url: d.url,
    urlKey: itemUrlKey(d.url),
    folderId: d.folderId || LOCKED_CATEGORY.none,
    tags: d.tags ?? [],
    note: d.note ?? '',
    iconRef: d.iconRef ?? '',
    extra: d.extra ?? '',
    position: d.position ?? maxPosition(s) + 1,
    version: 1,
    fieldVersions: {},
    importId: d.importId ?? null,
    createdAt: d.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
  };
  s.rows[id] = row;
  change(s, 'item', id, 1, 'upsert');
  return row;
}

type RowSet = Partial<{ title: string; url: string; folderId: string; tags: string[]; note: string; iconRef: string; extra: string; position: number; kind: ItemKind; catalogId: string | null }>;

function update(s: LocalState, id: string, set: RowSet, now: number, action: 'upsert' | 'restore' = 'upsert', extraFields: readonly string[] = []): LocalRow {
  const r = s.rows[id]!;
  const version = r.version + 1;
  const fields = { ...r.fieldVersions };
  if (action === 'restore') fields.restored = version;
  // UI v2 (N1): the unified editor records which `extra` fields it changed (app.icon, app.aliases…).
  for (const f of extraFields) fields[f] = version;
  const next: LocalRow = { ...r, version, updatedAt: now, ...(action === 'restore' ? { deletedAt: null } : {}) };
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    (next as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
    if (k === 'url') next.urlKey = itemUrlKey(v as string);
    fields[k] = version;
  }
  next.fieldVersions = fields;
  s.rows[id] = next;
  change(s, 'item', id, version, action);
  return next;
}

function tombstone(s: LocalState, id: string, now: number): LocalRow {
  const r = s.rows[id]!;
  const version = r.version + 1;
  s.rows[id] = { ...r, deletedAt: now, version, updatedAt: now };
  const wasPinned = s.pins.includes(id);
  if (wasPinned) s.pins = s.pins.filter((x) => x !== id);
  change(s, 'item', id, version, 'delete');
  if (wasPinned) change(s, 'pins', 'shared', version, 'pins');
  return s.rows[id]!;
}

function restorable(s: LocalState, id: string, baseVersion: number | undefined): boolean {
  const r = s.rows[id];
  if (!r || r.deletedAt === null) return false;
  return baseVersion === undefined || (r.fieldVersions.restored ?? 0) <= baseVersion;
}

function freeItemId(s: LocalState): string {
  let id = newItemId();
  while (s.rows[id]) id = newItemId();
  return id;
}

// ── the configuration and its home-page view ───────────────────────────────
/** Items the home page shows: every live `app`, plus pinned pages; and the pins in order. */
export function homeView(s: LocalState): { apps: AppEntry[]; pins: string[] } {
  const pins = pinnedIds(s);
  const pinned = new Set(pins);
  // In position order, pinned pages among the apps (UI v2 N2: the order of a group is the
  // position order of all its favorites).
  const rows = liveRows(s);
  const apps = rows.filter((r) => r.kind === 'app' || pinned.has(r.id)).map(rowToApp).filter((a): a is AppEntry => !!a);
  return { apps, pins: pins.filter((id) => apps.some((a) => a.id === id)) };
}

export function localSnapshot(s: LocalState): Snapshot {
  const view = homeView(s);
  return { revision: s.revision, updatedAt: s.updatedAt, config: normalizeConfig({ ...s.doc, apps: view.apps, pins: view.pins } as Config) };
}

export function localConfigResponse(s: LocalState): ConfigResponse {
  return { ...localSnapshot(s), wallpapers: s.wallpapers.map((w) => ({ ...w })) };
}

function bump(s: LocalState, now: number): void {
  s.revision += 1;
  s.updatedAt = new Date(now).toISOString();
}

function idsOf(op: Op): string[] {
  const id = (v: unknown) => (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? [(v as { id: string }).id] : []);
  switch (op.type) {
    case 'app.upsert':
    case 'app.restore':
      return id(op.app);
    case 'app.delete':
      return [op.appId];
    case 'config.replace': {
      const apps = (op.config as { apps?: unknown } | null)?.apps;
      return Array.isArray(apps) ? apps.flatMap(id) : [];
    }
    default:
      return [];
  }
}

function remapped(op: Op, map: ReadonlyMap<string, string>): Op {
  if (!map.size) return op;
  const m = (id: string) => map.get(id) ?? id;
  switch (op.type) {
    case 'pin.add':
    case 'pin.remove':
    case 'pin.move':
    case 'app.setHidden':
    case 'service.setShown':
    case 'app.move':
    case 'app.delete':
      return { ...op, appId: m(op.appId) };
    case 'pin.reorder':
      return { ...op, order: op.order.map(m) };
    case 'app.upsert':
    case 'app.restore': {
      const id = (op.app as { id?: unknown } | null)?.id;
      return typeof id === 'string' && map.has(id) ? { ...op, app: { ...op.app, id: m(id) } } : op;
    }
    default:
      return op;
  }
}

/** ItemStore.prepare: deleted items, explicit restores and taken ids, before the reducer runs. */
function prepare(s: LocalState, view: Config, ops: readonly Op[]): { config: Config; ops: Op[]; restores: Set<string>; extra: Set<string> } {
  let config = view;
  const restores = new Set<string>();
  const extra = new Set<string>();
  const map = new Map<string, string>();
  const shown = (id: string) => config.apps.some((a) => a.id === id);
  const addToView = (r: LocalRow) => {
    const app = rowToApp(r);
    if (!app) return;
    config = { ...config, apps: [...config.apps, app] };
    extra.add(r.id);
  };
  const gone = (r: LocalRow, message: string, code: 'deleted' | 'stale') => new OpError(code, message, undefined, { appId: r.id, name: r.title, item: toItem(r, new Set()), current: rowToApp(r) });
  const free = (id: string) => {
    const stem = id.replace(/-\d+$/, '').slice(0, 56) || 'app';
    const used = new Set([...config.apps.map((a) => a.id), ...map.values()]);
    for (let i = 2; ; i++) {
      const candidate = `${stem}-${i}`;
      if (!used.has(candidate) && !s.rows[candidate]) return candidate;
    }
  };
  const out: Op[] = [];
  for (const raw of ops) {
    let op = remapped(raw, map);
    if (op.type === 'app.upsert') {
      const id = idsOf(op)[0];
      const row = id ? s.rows[id] : undefined;
      if (id && op.base === null && (row || shown(id))) {
        const fresh = free(id);
        map.set(id, fresh);
        op = { ...op, app: { ...op.app, id: fresh } };
      } else if (row && row.deletedAt !== null && !restores.has(row.id)) throw gone(row, `「${row.title}」已被删除（在回收站中），这次修改没有应用`, 'deleted');
      else if (row && row.deletedAt === null && !shown(row.id)) addToView(row);
    } else if (op.type === 'app.delete') {
      const row = s.rows[op.appId];
      if (row && row.deletedAt === null && !shown(row.id)) addToView(row);
    } else if (op.type === 'app.restore') {
      const id = idsOf(op)[0];
      const row = id ? s.rows[id] : undefined;
      if (!row) throw new OpError('not_found', '这条收藏不存在，无法恢复');
      if (row.deletedAt === null) continue;
      if (!restorable(s, row.id, op.baseVersion)) throw gone(row, `「${row.title}」在你删除之后已被恢复过、又被再次删除，所以没有自动恢复；需要时请到「我的收藏」的回收站恢复`, 'stale');
      const app = rowToApp(row);
      if (!app) throw new OpError('invalid', `「${row.title}」不能显示在首页，请在「我的收藏」中恢复`);
      restores.add(row.id);
      op = { ...op, app };
    } else if (op.type === 'config.replace') {
      for (const id of idsOf(op)) if (s.rows[id]?.deletedAt != null) restores.add(id);
    }
    out.push(op);
  }
  return { config, ops: out, restores, extra };
}

function changesOf(old: AppEntry, app: AppEntry): RowSet {
  const set: RowSet = {};
  if (app.name !== old.name) set.title = app.name;
  if (app.url !== old.url) set.url = app.url;
  if (app.categoryId !== old.categoryId) set.folderId = app.categoryId;
  if ((app.catalogId ?? null) !== (old.catalogId ?? null)) set.catalogId = app.catalogId ?? null;
  if (extraOf(app) !== extraOf(old)) set.extra = extraOf(app);
  return set;
}

/** ItemStore.applyHomeView: the difference between two home views, written back to the items. */
function applyHomeView(s: LocalState, before: Config, after: Config, plan: { restores: Set<string>; extra: Set<string> }, now: number): void {
  const pinsChanged = JSON.stringify(before.pins) !== JSON.stringify(after.pins);
  if (before.apps === after.apps && !pinsChanged) return;
  const prev = new Map(before.apps.map((a) => [a.id, a]));
  const next = new Map(after.apps.map((a) => [a.id, a]));
  const fresh = after.apps.filter((a) => !prev.has(a.id));
  if (fresh.length) {
    const used = liveRows(s).length;
    if (used + fresh.length > LOCAL_LIMITS.items) throw new OpError('quota_exceeded', `收藏最多 ${LOCAL_LIMITS.items} 条，请先删除一些`, { kind: 'items', limit: LOCAL_LIMITS.items, used });
  }
  const positions = before.apps === after.apps ? new Map<string, number>() : viewPositions(after.apps, plan.extra, (id) => s.rows[id]?.position);
  for (const app of before.apps === after.apps ? [] : after.apps) {
    const old = prev.get(app.id);
    const row = s.rows[app.id];
    const position = positions.get(app.id);
    if (!row) {
      insert(s, { id: app.id, kind: 'app', source: app.catalogId ? 'catalog' : 'manual', catalogId: app.catalogId ?? null, title: app.name, url: app.url, folderId: app.categoryId, note: app.description, extra: extraOf(app), position: position ?? maxPosition(s) + 1 }, now);
      continue;
    }
    const was = old ?? rowToApp(row);
    const set: RowSet = was ? changesOf(was, app) : { title: app.name, url: app.url, folderId: app.categoryId, extra: extraOf(app) };
    if (position !== undefined && row.position !== position) set.position = position;
    if (row.deletedAt !== null) {
      if (!plan.restores.has(app.id)) throw new OpError('deleted', `「${app.name}」已被删除（在回收站中），这次修改没有应用`, undefined, { appId: app.id, name: app.name });
      update(s, app.id, set, now, 'restore');
    } else if (Object.keys(set).length) update(s, app.id, set, now);
  }
  for (const id of before.apps === after.apps ? [] : prev.keys()) {
    if (next.has(id)) continue;
    const row = s.rows[id];
    if (row && row.deletedAt === null) tombstone(s, id, now);
  }
  if (pinsChanged) {
    try {
      writePins(s, after.pins);
    } catch (e) {
      if (e instanceof PinRefused) throw e.code === 'PINS_FULL' ? new OpError('pins_full', e.message, { kind: 'pins', limit: MAX_PINS, used: e.used }) : new OpError(e.code === 'NOT_PINNABLE' ? 'not_pinnable' : 'not_found', e.message);
      throw e;
    }
  }
}

/**
 * Favorites of groups that no longer exist (deleted, or dropped by an older client's whole-list
 * replace) go to the nearest surviving ancestor, else 未分组 — the ones outside the home view too.
 */
function reassignRemovedGroups(s: LocalState, before: Config['categories'], after: Config['categories'], now: number): void {
  const kept = new Set(after.map((k) => k.id));
  const gone = new Set(before.filter((k) => !kept.has(k.id)).map((k) => k.id));
  if (!gone.size) return;
  for (const r of Object.values(s.rows)) {
    if (!gone.has(r.folderId)) continue;
    const to = survivingAncestor(before, r.folderId, kept);
    if (r.deletedAt !== null) s.rows[r.id] = { ...r, folderId: to };
    else update(s, r.id, { folderId: to }, now);
  }
}

/** Health checks probe addresses from a server; nobody does that for a local collection. */
const sanitize = (c: Config): Config => (c.apps.some((a) => a.health.enabled) ? { ...c, apps: c.apps.map((a) => (a.health.enabled ? { ...a, health: { ...a.health, enabled: false } } : a)) } : c);

/**
 * ConfigRepo.apply: one batch, atomically (throws OpError — the caller writes nothing then).
 * A batch already applied answers the current state, like the server.
 */
export function localPostOps(s: LocalState, batch: OpBatch, now: number): ConfigResponse {
  if (s.batches.includes(batch.batchId)) return localConfigResponse(s);
  const current = localSnapshot(s);
  const plan = prepare(s, current.config, batch.ops);
  const applied = applyOps(plan.config, plan.ops);
  s.batches.push(batch.batchId);
  if (s.batches.length > LOCAL_LIMITS.batches) s.batches.splice(0, s.batches.length - LOCAL_LIMITS.batches);
  if (applied === plan.config) return localConfigResponse(s);
  const check = ConfigSchema.safeParse(applied);
  if (!check.success) {
    const issue = check.error.issues[0];
    throw new OpError('invalid', issue ? `${issue.path.join('.') || 'config'}: ${issue.message}` : 'invalid');
  }
  const next = sanitize(applied);
  applyHomeView(s, plan.config, next, plan, now);
  reassignRemovedGroups(s, current.config.categories, next.categories, now);
  if (JSON.stringify(current.config.categories) !== JSON.stringify(next.categories)) change(s, 'folders', 'shared', s.seq, 'folders');
  const { apps: _apps, pins: _pins, ...doc } = next;
  s.doc = doc;
  bump(s, now);
  return localConfigResponse(s);
}

// ── 我的收藏 (the v2 item interfaces, answered locally) ─────────────────────
const folders = (s: LocalState) => s.doc.categories.map((k) => ({ id: k.id, label: k.label, locked: !!k.locked, parentId: k.parentId ?? null }));
const folderOf = (s: LocalState, folderId: string | undefined) => {
  if (!folderId) return LOCKED_CATEGORY.none;
  if (!s.doc.categories.some((k) => k.id === folderId)) throw new LocalApiError(422, 'VALIDATION', '分组不存在');
  return folderId;
};
const admitItems = (s: LocalState, n: number) => {
  const used = liveRows(s).length;
  if (used + n > LOCAL_LIMITS.items) throw new LocalApiError(409, 'QUOTA_EXCEEDED', `收藏最多 ${LOCAL_LIMITS.items} 条，请先删除一些`, { kind: 'items', limit: LOCAL_LIMITS.items, used });
};
const itemOf = (s: LocalState, id: string) => (s.rows[id] ? toItem(s.rows[id]!, new Set(pinnedIds(s))) : null);
const live = (s: LocalState, id: string): Item => {
  const item = itemOf(s, id);
  if (!item) throw new LocalApiError(404, 'NOT_FOUND', '收藏不存在');
  if (item.deletedAt !== null) throw new LocalApiError(409, 'ITEM_DELETED', '这条收藏已被删除；需要时先恢复', { item });
  return item;
};
const answer = (item: Item, result: ItemWriteResult['result']): ItemWriteResult => ({ item, result, ownerRevision: 0 });
const pinIfRoom = (s: LocalState, id: string): NonNullable<ItemWriteResult['pin']> => {
  try {
    pin(s, id);
    return { pinned: true };
  } catch (e) {
    if (!(e instanceof PinRefused) || (e.code !== 'PINS_FULL' && e.code !== 'NOT_PINNABLE')) throw e;
    return e.code === 'PINS_FULL' ? { pinned: false, code: 'PINS_FULL', limit: MAX_PINS, used: e.used } : { pinned: false, code: 'NOT_PINNABLE' };
  }
};
const pinError = (e: unknown): never => {
  if (e instanceof PinRefused) {
    if (e.code === 'PINS_FULL') throw new LocalApiError(409, 'QUOTA_EXCEEDED', e.message, { kind: 'pins', limit: MAX_PINS, used: e.used });
    if (e.code === 'NOT_PINNABLE') throw new LocalApiError(409, 'NOT_PINNABLE', e.message);
    if (e.code === 'ITEM_DELETED') throw new LocalApiError(409, 'ITEM_DELETED', e.message);
    throw new LocalApiError(404, 'NOT_FOUND', e.message);
  }
  throw e;
};
const validate = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new LocalApiError(422, 'VALIDATION', i ? `${i.path.join('.') || '请求'}：${i.message}` : '请求格式不正确');
  }
  return r.data;
};
/** Stable text of a request, for the idempotency check (key order as written by the caller). */
const hashOf = (v: unknown) => JSON.stringify(v);

/**
 * One item write: idempotency by opId (a retry answers the stored result; another request with the
 * same opId is refused), the change, a new revision. A refusal (thrown) writes nothing.
 */
function write<T>(s: LocalState, opId: string, request: unknown, now: number, run: () => T): T {
  validate(OpIdSchema, opId);
  const hash = hashOf(request);
  const seen = s.ops[opId];
  if (seen) {
    if (seen.hash !== hash) throw new LocalApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一个 opId 已用于另一个请求');
    return structuredClone(seen.result) as T;
  }
  const out = run();
  bump(s, now);
  const stored = out && typeof out === 'object' && 'ownerRevision' in (out as object) ? ({ ...(out as object), ownerRevision: s.revision } as T) : out;
  s.ops[opId] = { hash, status: 200, result: structuredClone(stored), at: now };
  const keys = Object.keys(s.ops);
  if (keys.length > LOCAL_LIMITS.ops) {
    for (const k of keys.sort((a, b) => s.ops[a]!.at - s.ops[b]!.at).slice(0, keys.length - LOCAL_LIMITS.ops)) delete s.ops[k];
  }
  return stored;
}

/** A shared rule's refusal as the local collection's answer. */
function refused<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof FavoriteRefused) throw new LocalApiError(e.status, e.code, e.message, e.details);
    throw e;
  }
}

/** planFavoriteUpdate over a local row (a local collection never probes services: not admin). */
function favoritePlan(s: LocalState, id: string, patch: Parameters<typeof planFavoriteUpdate>[1]) {
  const r = s.rows[id]!;
  return refused(() => planFavoriteUpdate({ id: r.id, kind: r.kind, title: r.title, url: r.url, folderId: r.folderId, tags: r.tags, note: r.note, iconRef: r.iconRef, catalogId: r.catalogId, extra: r.extra, version: r.version, fieldVersions: r.fieldVersions, deletedAt: r.deletedAt }, patch, { admin: false, groups: s.doc.categories }));
}

const CURSOR = /^l(\d+)$/;
const CONTENT_FIELDS = ['title', 'url', 'folderId', 'tags', 'note', 'iconRef', 'extra', 'kind', 'catalogId'];

export const localItems = {
  /** The whole collection at once (it is this browser's own, and small). */
  snapshot(s: LocalState): SnapshotResponse {
    const pinned = new Set(pinnedIds(s));
    return { items: liveRows(s).map((r) => toItem(r, pinned)), pins: [...pinned], folders: folders(s), watermark: s.seq, cursor: `l${s.seq}`, nextPage: null, starterVersion: s.starterVersion ?? 0 };
  },

  changes(s: LocalState, cursor: string): ChangesResponse & { pins?: string[]; folders?: SnapshotResponse['folders'] } {
    const m = CURSOR.exec(cursor);
    if (!m) throw new LocalApiError(400, 'INVALID_CURSOR', '游标无效');
    const after = Number(m[1]);
    const oldest = s.changes[0]?.seq ?? null;
    if (after > s.seq || (oldest !== null && after < oldest - 1)) throw new LocalApiError(410, 'CURSOR_EXPIRED', '游标太旧，请重新获取全部收藏');
    const LIMIT = 500;
    const rows = s.changes.filter((c) => c.seq > after);
    const page = rows.slice(0, LIMIT);
    const pinned = new Set(pinnedIds(s));
    const changes: ItemChange[] = page.map((c) => ({ seq: c.seq, entity: c.entity, id: c.id, version: c.version, action: c.action, ...(c.entity === 'item' && s.rows[c.id] ? { item: toItem(s.rows[c.id]!, pinned) } : {}) }));
    const last = page.at(-1);
    return { changes, nextCursor: `l${last ? last.seq : after}`, hasMore: rows.length > LIMIT, ...(page.some((c) => c.entity === 'pins') ? { pins: [...pinned] } : {}), ...(page.some((c) => c.entity === 'folders') ? { folders: folders(s) } : {}) };
  },

  /** Lookup by address (the extension asks whether a page is already saved). */
  findByUrl(s: LocalState, url: string): Item | null {
    const key = itemUrlKey(url);
    const r = liveRows(s)
      .filter((x) => x.urlKey === key)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    return r ? toItem(r, new Set(pinnedIds(s))) : null;
  },

  folders,

  create(s: LocalState, raw: { opId: string; source?: 'manual' | 'catalog' | 'extension' | 'import'; item: ItemInput; pinToHome?: boolean; duplicatePolicy?: 'prompt' | 'update' | 'create' }, now: number): ItemWriteResult {
    const input = validate(ItemInputSchema, raw.item);
    const req = { opId: raw.opId, source: raw.source ?? 'manual', item: input, pinToHome: !!raw.pinToHome, duplicatePolicy: raw.duplicatePolicy ?? 'prompt' };
    return write(s, req.opId, ['create', req], now, () => {
      const existing = localItems.findByUrl(s, input.url);
      if (existing && req.duplicatePolicy === 'prompt') throw new LocalApiError(409, 'DUPLICATE', '这个网址已经在收藏里', { item: existing });
      if (existing && req.duplicatePolicy === 'update') {
        update(s, existing.id, { title: input.title, folderId: folderOf(s, input.folderId), tags: input.tags, note: input.note || existing.note }, now);
        const p = req.pinToHome ? pinIfRoom(s, existing.id) : undefined;
        return { ...answer(itemOf(s, existing.id)!, 'updated'), ...(p ? { pin: p } : {}) };
      }
      admitItems(s, 1);
      const row = insert(s, { kind: input.kind ?? 'page', source: req.source, catalogId: input.catalogId ?? null, title: input.title, url: input.url, folderId: folderOf(s, input.folderId), tags: input.tags, note: input.note, iconRef: input.iconRef }, now);
      const p = req.pinToHome ? pinIfRoom(s, row.id) : undefined;
      return { ...answer(itemOf(s, row.id)!, 'created'), ...(p ? { pin: p } : {}) };
    });
  },

  patch(s: LocalState, id: string, raw: { opId: string; baseVersion: number; patch: ItemPatch }, now: number): ItemWriteResult {
    const patchIn = validate(ItemPatchSchema, raw.patch);
    const req = { opId: raw.opId, baseVersion: raw.baseVersion, patch: patchIn };
    return write(s, req.opId, ['patch', id, req], now, () => {
      const item = live(s, id);
      const fields = s.rows[id]!.fieldVersions;
      const conflictFields = Object.keys(req.patch).filter((f) => (fields[f] ?? 0) > req.baseVersion);
      if (conflictFields.length) throw new LocalApiError(409, 'FIELD_CONFLICT', '这些字段在别处已被修改，请先合并', { currentVersion: item.version, conflictFields, item });
      const set: RowSet = { ...req.patch, ...(req.patch.folderId !== undefined ? { folderId: folderOf(s, req.patch.folderId) } : {}) };
      update(s, id, set, now);
      return answer(itemOf(s, id)!, 'updated');
    });
  },

  remove(s: LocalState, id: string, opId: string, baseVersion: number | undefined, now: number): ItemWriteResult {
    return write(s, opId, baseVersion === undefined ? ['delete', id, null] : ['delete', id, null, baseVersion], now, () => {
      const item = itemOf(s, id);
      if (!item) throw new LocalApiError(404, 'NOT_FOUND', '收藏不存在');
      if (item.deletedAt !== null) return answer(item, 'unchanged');
      if (baseVersion !== undefined) {
        const changed = CONTENT_FIELDS.filter((f) => (s.rows[id]!.fieldVersions[f] ?? 0) > baseVersion);
        if (changed.length) throw new LocalApiError(409, 'REVISION_CONFLICT', '这条收藏在你上次看到之后被修改过，没有删除；请确认后再删除', { currentVersion: item.version, conflictFields: changed, item });
      }
      tombstone(s, id, now);
      return answer(itemOf(s, id)!, 'deleted');
    });
  },

  restore(s: LocalState, id: string, opId: string, baseVersion: number | undefined, now: number): ItemWriteResult {
    return write(s, opId, baseVersion === undefined ? ['restore', id] : ['restore', id, baseVersion], now, () => {
      const item = itemOf(s, id);
      if (!item) throw new LocalApiError(404, 'NOT_FOUND', '收藏不存在');
      if (item.deletedAt === null) return answer(item, 'unchanged');
      if (!restorable(s, id, baseVersion)) throw new LocalApiError(409, 'REVISION_CONFLICT', '这条收藏在你上次看到之后已被恢复过、又被再次删除；请刷新回收站后再决定', { currentVersion: item.version, item });
      admitItems(s, 1);
      update(s, id, {}, now, 'restore');
      return answer(itemOf(s, id)!, 'restored');
    });
  },

  /** Deleted items (回收站), newest first. */
  trash(s: LocalState): Item[] {
    return ordered(s)
      .filter((r) => r.deletedAt !== null)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .map((r) => toItem(r, new Set()));
  },

  pin(s: LocalState, id: string, opId: string, position: number | undefined, now: number): { pins: string[]; ownerRevision: number } {
    return write(s, opId, ['pin', id, position ?? null], now, () => {
      live(s, id);
      let pins: string[] = [];
      try {
        pins = pin(s, id, position);
      } catch (e) {
        pinError(e);
      }
      return { pins, ownerRevision: 0 };
    });
  },

  unpin(s: LocalState, id: string, opId: string, now: number): { pins: string[]; ownerRevision: number } {
    return write(s, opId, ['unpin', id, null], now, () => {
      live(s, id);
      return { pins: unpin(s, id), ownerRevision: 0 };
    });
  },

  /**
   * A browser's bookmark file (BookmarkImportSchema): `single` puts the pages into one group;
   * `tree` (UI v2 N2) makes the file's folders nested groups under `parentId`. Addresses already
   * here are skipped. `dryRun`: the preview, nothing written.
   */
  importItems(s: LocalState, raw: BookmarkImportRequest | { opId: string; folderId?: string; items: ItemInput[]; skipDuplicates?: boolean }, now: number) {
    const req = validate(BookmarkImportSchema, raw);
    const plan = () => {
      const known = new Set(liveRows(s).map((r) => r.urlKey));
      const seen = new Set<string>();
      const fresh = req.items.filter((i) => {
        const k = itemUrlKey(i.url);
        if (seen.has(k) || (req.skipDuplicates && known.has(k))) return false;
        seen.add(k);
        return true;
      });
      const tree = req.folderMode === 'tree' ? planBookmarkTree(s.doc.categories, req.items.map((i) => i.path ?? []), req.parentId ?? null, () => newGroupId(new Set(s.doc.categories.map((k) => k.id)))) : null;
      return { fresh, tree };
    };
    if (req.dryRun) throw new LocalApiError(422, 'VALIDATION', '预览请用 previewImportItems');
    return write(s, req.opId, ['import', req], now, () => {
      const single = folderOf(s, req.folderId);
      const { fresh, tree } = plan();
      admitItems(s, fresh.length);
      if (tree?.created.length) {
        s.doc = { ...s.doc, categories: tree.categories };
        change(s, 'folders', 'shared', s.seq, 'folders');
      }
      const importId = `imp-${req.opId.slice(-16)}`;
      let position = maxPosition(s) + 1;
      for (const i of fresh) {
        const folderId = tree ? bookmarkGroup(tree, i.path) : i.folderId && s.doc.categories.some((k) => k.id === i.folderId) ? i.folderId : single;
        insert(s, { kind: i.kind ?? 'page', source: 'import', title: i.title, url: i.url, folderId, tags: tree ? i.tags : i.tags, note: i.note, iconRef: i.iconRef, position: position++, importId }, now);
      }
      const created = tree?.created.map((g) => ({ id: g.id, label: g.label })) ?? [];
      if (created.length) s.imports[importId] = { folders: created, pins: [], at: now };
      return { importId, imported: fresh.length, skipped: req.items.length - fresh.length, ...(tree ? { folders: { create: tree.created, matched: tree.matched, overDepth: tree.overDepth, overLimit: tree.overLimit } } : {}), ...(created.length ? { undo: { folders: created, pins: [] } } : {}), ownerRevision: 0 };
    });
  },

  /** The preview of a bookmark import (`dryRun`): what would be created and where, nothing written. */
  previewImportItems(s: LocalState, raw: BookmarkImportRequest) {
    const req = validate(BookmarkImportSchema, { ...raw, dryRun: true });
    const known = new Set(liveRows(s).map((r) => r.urlKey));
    const seen = new Set<string>();
    const fresh = req.items.filter((i) => {
      const k = itemUrlKey(i.url);
      if (seen.has(k) || (req.skipDuplicates && known.has(k))) return false;
      seen.add(k);
      return true;
    });
    const tree = req.folderMode === 'tree' ? planBookmarkTree(s.doc.categories, req.items.map((i) => i.path ?? []), req.parentId ?? null, () => newGroupId(new Set(s.doc.categories.map((k) => k.id)))) : null;
    return { dryRun: true as const, importId: null, imported: fresh.length, skipped: req.items.length - fresh.length, folders: tree ? { create: tree.created, matched: tree.matched, overDepth: tree.overDepth, overLimit: tree.overLimit } : null, basis: s.revision };
  },

  /**
   * 添加收藏 (UI v2 N1/N3): one or many favorites with all their fields, in one transaction
   * (CreateFavoritesSchema). Pins over the limit are reported per favorite; the favorites are saved.
   */
  createFavorites(s: LocalState, raw: CreateFavoritesRequest, now: number) {
    const req = validate(CreateFavoritesSchema, raw);
    return write(s, req.opId, ['create-favorites', req], now, () => {
      const results: { index: number; result: 'created' | 'updated' | 'skipped'; item: Item; duplicateOf?: string }[] = [];
      const dupes = req.duplicatePolicy === 'create' ? [] : req.items.flatMap((input, index) => {
        const item = localItems.findByUrl(s, input.url);
        return item ? [{ index, item }] : [];
      });
      if (dupes.length && req.duplicatePolicy === 'prompt') throw new LocalApiError(409, 'DUPLICATE', dupes.length === 1 ? '这个网址已经在收藏里' : `其中 ${dupes.length} 个网址已经在收藏里`, { item: dupes[0]!.item, duplicates: dupes.map((d) => ({ index: d.index, id: d.item.id, title: d.item.title })) });
      admitItems(s, req.items.length - dupes.length);
      const toPin: string[] = [];
      req.items.forEach((input, index) => {
        const folderId = folderOf(s, input.folderId ?? req.folderId);
        const existing = req.duplicatePolicy === 'create' ? null : localItems.findByUrl(s, input.url);
        if (existing && req.duplicatePolicy === 'skip') {
          results.push({ index, result: 'skipped', item: existing, duplicateOf: existing.id });
          return;
        }
        if (existing) {
          const planned = favoritePlan(s, existing.id, { title: input.title, folderId, tags: input.tags, ...(input.note ? { note: input.note } : {}), ...(input.app ? { app: input.app } : {}) });
          update(s, existing.id, planned.set, now, 'upsert', planned.fields.filter((f) => f.startsWith('app.')));
          results.push({ index, result: 'updated', item: itemOf(s, existing.id)!, duplicateOf: existing.id });
          if (req.pin) toPin.push(existing.id);
          return;
        }
        const extra = refused(() => extraForNew({ title: input.title, url: input.url, folderId, catalogId: input.catalogId ?? null, app: input.app }, false));
        const row = insert(s, { kind: input.kind ?? 'page', source: req.source, catalogId: input.catalogId ?? null, title: input.title, url: input.url, folderId, tags: input.tags, note: input.note, iconRef: input.iconRef, extra: extra.extra }, now);
        results.push({ index, result: 'created', item: itemOf(s, row.id)! });
        if (req.pin) toPin.push(row.id);
      });
      const pinned: string[] = [];
      const notPinned: { id: string; code: 'PINS_FULL' | 'NOT_PINNABLE' }[] = [];
      for (const id of toPin) {
        const p = pinIfRoom(s, id);
        if (p.pinned) pinned.push(id);
        else notPinned.push({ id, code: p.code ?? 'NOT_PINNABLE' });
      }
      const pinnedNow = new Set(pinnedIds(s));
      return { results: results.map((r) => ({ ...r, item: toItem(s.rows[r.item.id]!, pinnedNow) })), pin: { pinned, notPinned, limit: MAX_PINS, used: pinnedNow.size }, ownerRevision: 0 };
    });
  },

  /**
   * 保存 of the unified editor (UI v2 N1): every field and the pin in one transaction; fields changed
   * elsewhere after `baseVersion` are FIELD_CONFLICT (nothing written, the current favorite comes
   * back); a pin the rule refuses fails the whole save.
   */
  saveFavorite(s: LocalState, id: string, raw: SaveFavoriteRequest, now: number) {
    const req = validate(SaveFavoriteSchema, raw);
    return write(s, req.opId, ['save-favorite', id, req], now, () => {
      const item = live(s, id);
      const planned = favoritePlan(s, id, req.patch);
      const conflictFields = favoriteConflicts(s.rows[id]!.fieldVersions, planned.fields, req.baseVersion);
      if (conflictFields.length) throw new LocalApiError(409, 'FIELD_CONFLICT', '这些字段在别处已被修改，请先合并', { currentVersion: item.version, conflictFields, item });
      if (Object.keys(planned.set).length) update(s, id, planned.set, now, 'upsert', planned.fields.filter((f) => f.startsWith('app.')));
      if (planned.pin === true) {
        try {
          pin(s, id);
        } catch (e) {
          pinError(e);
        }
      } else if (planned.pin === false) unpin(s, id);
      return { ...answer(itemOf(s, id)!, Object.keys(planned.set).length || planned.pin !== undefined ? 'updated' : 'unchanged'), ...(planned.healthForcedOff ? { healthForcedOff: true } : {}) };
    });
  },

  /** 移动 / 排序 (UI v2 N2): the favorites, in this order, into `folderId` after `afterId`. */
  moveItems(s: LocalState, raw: MoveItemsRequest, now: number) {
    const req = validate(MoveItemsSchema, raw);
    return write(s, req.opId, ['move-items', req], now, () => {
      const folderId = folderOf(s, req.folderId);
      const ids = [...new Set(req.ids)];
      for (const id of ids) {
        const item = live(s, id);
        const base = req.baseVersions?.[id];
        if (base !== undefined) {
          const f = s.rows[id]!.fieldVersions;
          const moved = ['position', 'folderId'].filter((k) => (f[k] ?? 0) > base);
          if (moved.length) throw new LocalApiError(409, 'FIELD_CONFLICT', `「${item.title}」在别处已被移动，请刷新后再移动`, { currentVersion: item.version, conflictFields: moved, item });
        }
      }
      const moving = new Set(ids);
      const group = liveRows(s).filter((r) => r.folderId === folderId && !moving.has(r.id)).map((r) => ({ id: r.id, position: r.position }));
      const placed = refused(() => placeInGroup(group, ids.length, req.afterId));
      if (placed.renumber) for (const p of placed.renumber) if (s.rows[p.id]!.position !== p.position) update(s, p.id, { position: p.position }, now);
      ids.forEach((id, i) => {
        const r = s.rows[id]!;
        const set: RowSet = { position: placed.positions[i]! };
        if (r.folderId !== folderId) set.folderId = folderId;
        update(s, id, set, now);
      });
      const pinned = new Set(pinnedIds(s));
      return { items: ids.map((id) => toItem(s.rows[id]!, pinned)), ownerRevision: 0 };
    });
  },

  /** 撤销本次导入: only what that import added and nobody changed since. */
  undoImport(s: LocalState, importId: string, opId: string, now: number) {
    return write(s, opId, ['undo-import', importId], now, () => {
      const pinnedBefore = pinnedIds(s);
      let removed = 0;
      let kept = 0;
      for (const r of liveRows(s).filter((x) => x.importId === importId)) {
        if (r.version > 1) kept++;
        else {
          tombstone(s, r.id, now);
          removed++;
        }
      }
      const record = s.imports[importId];
      let unpinned = 0;
      let removedFolders = 0;
      let keptFolders = 0;
      if (record) {
        const take = new Set(record.pins);
        const pins = pinnedIds(s);
        if (pins.some((id) => take.has(id))) writePins(s, pins.filter((id) => !take.has(id)));
        const nowPinned = new Set(pinnedIds(s));
        unpinned = record.pins.filter((id) => pinnedBefore.includes(id) && !nowPinned.has(id)).length;
        const inUse = new Set(liveRows(s).map((r) => r.folderId));
        const drop = new Set(record.folders.filter((f) => !inUse.has(f.id) && s.doc.categories.some((k) => k.id === f.id && k.label === f.label)).map((f) => f.id));
        keptFolders = record.folders.filter((f) => s.doc.categories.some((k) => k.id === f.id)).length - drop.size;
        if (drop.size) {
          s.doc = { ...s.doc, categories: s.doc.categories.filter((k) => !drop.has(k.id)) };
          change(s, 'folders', 'shared', s.seq, 'folders');
        }
        removedFolders = drop.size;
      }
      return { importId, removed, kept, unpinned, removedFolders, keptFolders, ownerRevision: 0 };
    });
  },

  /**
   * 产品 JSON 恢复 (NEX-06) into this collection — the server's planner. `storeIcon` keeps an uploaded
   * icon of the backup in the asset store (same transaction) and returns its new reference.
   */
  restoreCollection(s: LocalState, raw: { opId: string; file: unknown; duplicates: DuplicatePolicy; dryRun: boolean; basis?: number }, now: number, storeIcon: (dataUrl: string) => string) {
    const file = collectionFileOf(raw.file);
    const basisOf = () => {
      const pins = pinnedIds(s);
      const live = liveRows(s);
      return {
        admin: false,
        categories: s.doc.categories,
        live: live.map((r) => toItem(r, new Set(pins))),
        takenIds: new Set(Object.keys(s.rows)),
        pins,
        pinnableIds: new Set(
          live
            .filter((r) => {
              const app = rowToApp(r);
              return !!app && isPinnable(app);
            })
            .map((r) => r.id),
        ),
      };
    };
    if (raw.dryRun) return { dryRun: true, importId: null, summary: restoreSummary(planRestore(file, basisOf(), raw.duplicates)), basis: s.revision };
    return write(s, raw.opId, ['restore-collection', raw], now, () => {
      if (raw.basis !== undefined && raw.basis !== s.revision) throw new LocalApiError(409, 'PLAN_STALE', '收藏在预览之后有了变化，请重新预览后再恢复', { basis: s.revision });
      const basis = basisOf();
      const plan = planRestore(file, basis, raw.duplicates);
      admitItems(s, plan.create.length);
      const importId = `imp-${raw.opId.slice(-16)}`;
      if (plan.createdFolders.length) {
        s.doc = { ...s.doc, categories: plan.categories };
        change(s, 'folders', 'shared', s.seq, 'folders');
      }
      let position = maxPosition(s) + 1;
      for (const it of plan.create) {
        let app = it.app;
        if (app && it.icon) app = { ...app, icon: { ...app.icon, source: 'upload', ref: storeIcon(it.icon.dataUrl) } };
        insert(s, { id: it.id, kind: it.kind, source: 'import', catalogId: it.catalogId, title: it.title, url: it.url, folderId: it.folderId, tags: it.tags, note: it.note, iconRef: it.iconRef, extra: app ? extraOf(app) : '', position: position++, importId, ...(it.createdAt ? { createdAt: it.createdAt } : {}) }, now);
      }
      for (const u of plan.update) update(s, u.id, { title: u.title, folderId: u.folderId, tags: u.tags, note: u.note, kind: u.kind, catalogId: u.catalogId, ...(u.extra !== null ? { extra: u.extra } : {}) }, now);
      const addedPins = plan.pins.filter((id) => !basis.pins.includes(id));
      if (addedPins.length) writePins(s, plan.pins);
      s.imports[importId] = { folders: plan.createdFolders.map((k) => ({ id: k.id, label: k.label })), pins: addedPins, at: now };
      return { importId, summary: restoreSummary(plan), undo: { folders: plan.createdFolders.map((k) => ({ id: k.id, label: k.label })), pins: addedPins }, ownerRevision: 0 };
    });
  },
};

/** A `nexus-collection` file, checked like the server does (LocalApiError otherwise). */
export function collectionFileOf(raw: unknown) {
  const v = (raw as { version?: unknown } | null)?.version;
  if ((raw as { format?: unknown } | null)?.format !== COLLECTION_FORMAT) throw new LocalApiError(422, 'VALIDATION', '不是 Nexus 收藏导出的文件');
  if (typeof v === 'number' && v > COLLECTION_VERSION) throw new LocalApiError(422, 'UNSUPPORTED_VERSION', `这个文件来自更新版本的 Nexus（格式第 ${v} 版），请先升级再恢复`, { version: v, supported: COLLECTION_VERSION });
  const r = CollectionFileSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new LocalApiError(422, 'VALIDATION', i ? `文件格式不正确（${i.path.join('.') || '文件'}：${i.message}）` : '文件格式不正确');
  }
  return r.data;
}

/** Uploaded icons the live items use (their files go into an export). */
export function uploadedIconRefs(s: LocalState): string[] {
  const refs = new Set<string>();
  for (const r of liveRows(s)) {
    const icon = parse<{ icon?: { source?: string; ref?: string } }>(r.extra, {}).icon;
    if (icon?.source === 'upload' && icon.ref) refs.add(icon.ref);
  }
  return [...refs];
}

/**
 * 导出 (`nexus-collection` version 2, the server's format): restores here, in another browser or
 * extension, and into an account. `icons`: data URLs of the uploaded icons (uploadedIconRefs).
 * `exportedAt` is passed in, so the same collection exports to the same bytes (a merge retried with
 * the same request is recognised by the server).
 */
export function exportCollection(s: LocalState, icons: Record<string, string>, exportedAt: string, opts: { onlyUsedFolders?: boolean } = {}) {
  const pins = pinnedIds(s);
  const pinned = new Set(pins);
  const live = liveRows(s);
  // A merge into an account carries the folders that hold something — not the empty ones every new
  // collection starts with; a backup keeps them all.
  const used = new Set(live.map((r) => r.folderId));
  const items = live.map((r) => {
    const extra = parse<Record<string, unknown>>(r.extra, {});
    return { id: r.id, kind: r.kind, title: r.title, url: r.url, folderId: r.folderId, tags: [...r.tags], note: r.note, catalogId: r.catalogId, pinned: pinned.has(r.id), createdAt: new Date(r.createdAt).toISOString(), position: r.position, ...(r.iconRef ? { iconRef: r.iconRef } : {}), ...(Object.keys(extra).length ? { app: extra } : {}) };
  });
  return { format: COLLECTION_FORMAT, version: COLLECTION_VERSION, exportedAt, folders: opts.onlyUsedFolders ? folders(s).filter((f) => used.has(f.id)) : folders(s), pins, items, icons };
}

/** What the local collection holds, for the 账号与同步 choice and 数据与备份. */
export function localCounts(s: LocalState): { items: number; pins: number; folders: number; deleted: number; wallpapers: number } {
  const rows = Object.values(s.rows);
  const custom = s.doc.categories.filter((k) => !k.locked).length;
  return { items: rows.filter((r) => r.deletedAt === null).length, pins: pinnedIds(s).length, folders: custom, deleted: rows.filter((r) => r.deletedAt !== null).length, wallpapers: s.wallpapers.length };
}

// ── wallpapers (the files are the caller's; these are the library entries) ──
export function addLocalWallpaper(s: LocalState, w: UploadedWallpaper, now: number): UploadedWallpaper {
  if (s.wallpapers.length >= LOCAL_LIMITS.wallpapers) throw new LocalApiError(409, 'QUOTA_EXCEEDED', `最多保存 ${LOCAL_LIMITS.wallpapers} 张壁纸，请先删除一些`, { kind: 'wallpapers', limit: LOCAL_LIMITS.wallpapers, used: s.wallpapers.length });
  s.wallpapers = [...s.wallpapers, w];
  bump(s, now);
  return w;
}

/** Removes a library wallpaper; the home page falls back to the built-in one if it was showing it. */
export function removeLocalWallpaper(s: LocalState, id: string, now: number): boolean {
  if (!s.wallpapers.some((w) => w.id === id)) return false;
  s.wallpapers = s.wallpapers.filter((w) => w.id !== id);
  const look = s.doc.settings.look;
  if (look.wallpaper === id || look.favorites.includes(id) || look.blocked.includes(id)) {
    s.doc = { ...s.doc, settings: { ...s.doc.settings, look: { ...look, wallpaper: look.wallpaper === id ? 'fallingwater' : look.wallpaper, favorites: look.favorites.filter((x) => x !== id), blocked: look.blocked.filter((x) => x !== id) } } };
  }
  bump(s, now);
  return true;
}

/** Every asset id the state still refers to (wallpapers and uploaded icons, deleted items included). */
export function referencedAssets(s: LocalState): Set<string> {
  const refs = new Set<string>(s.wallpapers.map((w) => w.id));
  for (const r of Object.values(s.rows)) {
    const icon = parse<{ icon?: { source?: string; ref?: string } }>(r.extra, {}).icon;
    if (icon?.source === 'upload' && icon.ref) refs.add(icon.ref);
  }
  return refs;
}

