import { z } from 'zod';
import { type Item, ITEM_LIMITS, itemUrlKey } from './items';
import { depthOf, GROUP_LIMITS, labelKey, placeGroup } from './groups';
import { AppSchema, CONFIG_LIMITS, isPinnable, LOCKED_CATEGORY, MAX_PINS, type AppEntry, type Category } from './schema';
import { canonicalUrl } from './url';

/**
 * v0.5 (UI 焕新 U1): moved here from the server unchanged in behaviour, so the browser's local
 * collection (本地收藏) restores a backup with exactly the server's rules, and a local collection
 * merged into an account is planned by the very same function on the server.
 *
 * 产品 JSON 恢复 (NEX-06): a Nexus collection backup (`GET /api/v2/export`) restores its structure —
 * folders, item ids, kinds, catalog links, the home-page settings of apps, uploaded icons and the
 * pin order — instead of being flattened into pages of the inbox like a browser bookmark file.
 *
 * Format `nexus-collection`:
 *  - version 1 (v0.4.0): folders, pins, items {id, kind, title, url, folderId, tags, note, catalogId, pinned};
 *  - version 2 (v0.4.1): also `app` per item (what the home page stores besides title / address /
 *    folder: site or service, icon, LAN address, aliases, hidden…), `position`, `iconRef`, and
 *    `icons`: every uploaded icon an app uses, as a PNG data URL — so a backup carries its icons
 *    (库图标、网站图标、字母图标 are references that need no data).
 *  - version 3 (UI v2 · v12.0.3 N2): `parentId` per folder (the group tree; folders in sibling
 *    order), items keep `position` (their order within a group), `pins` the home order, `app` the
 *    advanced fields and the catalog version. Versions 1 and 2 still restore: their folders become
 *    root groups.
 * Anything newer is refused (UNSUPPORTED_VERSION) rather than half-read.
 */
export const COLLECTION_FORMAT = 'nexus-collection';
export const COLLECTION_VERSION = 3;

export const CollectionFileSchema = z.object({
  format: z.literal(COLLECTION_FORMAT),
  version: z.number().int().min(1),
  folders: z.array(z.object({ id: z.string().min(1).max(64), label: z.string().max(200), locked: z.boolean().optional(), parentId: z.string().max(64).nullable().optional() })).max(200).default([]),
  pins: z.array(z.string().max(64)).max(500).default([]),
  items: z.array(z.unknown()).max(5000),
  icons: z.record(z.string().max(64), z.string().max(2_000_000)).default({}),
});
export type CollectionFile = z.infer<typeof CollectionFileSchema>;

export type DuplicatePolicy = 'skip' | 'update' | 'keep-both';

const Id = /^[a-z0-9][a-z0-9_-]*$/i;
const CatalogId = /^[a-z0-9][a-z0-9-]{0,47}$/;
const clip = (s: string, n: number) => [...s.trim()].slice(0, n).join('');

/** One backup entry after checking it; null when it cannot become an item here. */
interface FileEntry {
  fileId: string | null;
  kind: 'app' | 'page';
  title: string;
  url: string;
  folderId: string | null;
  tags: string[];
  note: string;
  catalogId: string | null;
  pinned: boolean;
  createdAt: number | null;
  iconRef: string;
  app: Record<string, unknown> | null;
}

function readEntry(raw: unknown): FileEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url || url.length > ITEM_LIMITS.url || !canonicalUrl(url)) return null;
  const title = clip(typeof r.title === 'string' && r.title.trim() ? r.title : url, ITEM_LIMITS.title) || clip(url, ITEM_LIMITS.title);
  const tags = Array.isArray(r.tags) ? [...new Set(r.tags.filter((t): t is string => typeof t === 'string').map((t) => clip(t, ITEM_LIMITS.tag)).filter(Boolean))].slice(0, ITEM_LIMITS.tags) : [];
  const created = typeof r.createdAt === 'number' ? r.createdAt : typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
  return {
    fileId: typeof r.id === 'string' && Id.test(r.id) && r.id.length <= 64 ? r.id : null,
    kind: r.kind === 'app' ? 'app' : 'page',
    title,
    url,
    folderId: typeof r.folderId === 'string' ? r.folderId : null,
    tags,
    note: typeof r.note === 'string' ? r.note.slice(0, ITEM_LIMITS.note) : '',
    catalogId: typeof r.catalogId === 'string' && CatalogId.test(r.catalogId) ? r.catalogId : null,
    pinned: r.pinned === true,
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
    iconRef: typeof r.iconRef === 'string' ? r.iconRef.slice(0, 256) : '',
    app: r.app && typeof r.app === 'object' && !Array.isArray(r.app) ? (r.app as Record<string, unknown>) : null,
  };
}

/** What the account has now (read inside its transaction). */
export interface RestoreBasis {
  admin: boolean;
  categories: Category[];
  /** Live items, for duplicates by address. */
  live: Item[];
  /** Every id the account uses, deleted ones included (ids are never reused). */
  takenIds: Set<string>;
  pins: string[];
  /** Live items the home page could show pinned (sites that are not hidden). */
  pinnableIds: Set<string>;
}

export interface PlannedItem {
  id: string;
  fileId: string | null;
  kind: 'app' | 'page';
  title: string;
  url: string;
  folderId: string;
  tags: string[];
  note: string;
  catalogId: string | null;
  createdAt: number | null;
  iconRef: string;
  /** The home-page entry it carries (validated), or null. */
  app: AppEntry | null;
  /** Its uploaded icon (PNG / WebP / SVG bytes and the data URL they came from), to be stored under a new id. */
  icon: { data: Uint8Array; dataUrl: string } | null;
}

export interface RestorePlan {
  categories: Category[];
  createdFolders: Category[];
  mappedFolders: { from: string; to: string; label: string }[];
  /** Folders beyond the group limit: their items go to the nearest planned ancestor (or 未分组). */
  foldersOverLimit: number;
  /** Folders deeper than the depth limit (their paths): their items go to the deepest allowed ancestor. */
  foldersOverDepth: string[];
  create: PlannedItem[];
  update: { id: string; title: string; url: string; folderId: string; tags: string[]; note: string; kind: 'app' | 'page'; catalogId: string | null; extra: string | null }[];
  duplicates: { fileId: string | null; title: string; url: string; existingId: string; existingTitle: string }[];
  skipped: number;
  repeated: number;
  unsupported: number;
  /** Pins after the restore (existing first, then the backup's, in its order, within the limit). */
  pins: string[];
  pinsRestored: number;
  pinsNotPinned: number;
  iconsMissing: number;
  kinds: { app: number; page: number };
}

const decodePng = (data: string): Uint8Array | null => {
  const m = /^data:image\/(png|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return null;
  try {
    const bin = atob(m[2]!);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** What an app entry stores besides the item's own columns (service kind, LAN address, health…). */
export function extraOf(app: AppEntry): string {
  const { id: _id, name: _name, url: _url, categoryId: _c, catalogId: _k, version: _v, ...rest } = app;
  return JSON.stringify(rest);
}

/** `it-` + 12 lowercase letters / digits, the shape of the server's ids (any runtime with Web Crypto). */
export function newItemId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `it-${s}`;
}

/**
 * Works out what restoring `file` into the account does, without changing anything (the preview
 * and the real thing use the same plan; the real one re-plans inside the transaction).
 */
export function planRestore(file: CollectionFile, basis: RestoreBasis, duplicates: DuplicatePolicy): RestorePlan {
  // ── folders (UI v2 N2: a tree). Each backup folder is, in this order: the same group (same id);
  // else the group with the same name at the same place (same parent — never a same-named group
  // elsewhere: 工作/资料 is not 生活/资料); else created there. Parents are planned before children;
  // version 1 and 2 folders have no parent and become root groups. A folder deeper than the limit
  // goes to its deepest allowed ancestor and one over the group limit to its nearest planned
  // ancestor — both are listed in the preview (nothing is flattened without saying so).
  let categories = [...basis.categories];
  const byId = new Map(categories.map((k) => [k.id, k]));
  const folderMap = new Map<string, string>();
  const createdFolders: Category[] = [];
  const mappedFolders: RestorePlan['mappedFolders'] = [];
  const foldersOverDepth: string[] = [];
  let foldersOverLimit = 0;
  const fileById = new Map(file.folders.map((f) => [f.id, f]));
  const fileParent = (f: CollectionFile['folders'][number]) => (file.version >= 3 && f.parentId && fileById.has(f.parentId) && f.parentId !== f.id ? f.parentId : null);
  const filePath = (f: CollectionFile['folders'][number]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let cur: CollectionFile['folders'][number] | undefined = f; cur && !seen.has(cur.id); cur = fileParent(cur) ? fileById.get(fileParent(cur)!) : undefined) {
      seen.add(cur.id);
      out.unshift(clip(cur.label, 16) || cur.id.slice(0, 16));
    }
    return out;
  };
  // Parents first (a cycle in a damaged file is planned as roots).
  const folderOrder: CollectionFile['folders'] = [];
  const placed = new Set<string>();
  const visit = (f: CollectionFile['folders'][number], stack: Set<string>) => {
    if (placed.has(f.id) || stack.has(f.id)) return;
    stack.add(f.id);
    const p = fileParent(f);
    if (p) visit(fileById.get(p)!, stack);
    placed.add(f.id);
    folderOrder.push(f);
  };
  for (const f of file.folders) visit(f, new Set());
  for (const f of folderOrder) {
    const label = clip(f.label, 16) || f.id.slice(0, 16);
    if (f.id === LOCKED_CATEGORY.none) {
      folderMap.set(f.id, f.id);
      continue;
    }
    if (byId.has(f.id)) {
      folderMap.set(f.id, f.id);
      if (byId.get(f.id)!.label !== label) mappedFolders.push({ from: f.id, to: f.id, label: byId.get(f.id)!.label });
      continue;
    }
    const fp = fileParent(f);
    const parent = fp ? (folderMap.get(fp) ?? null) : null;
    const parentId = parent === LOCKED_CATEGORY.none ? null : parent;
    const sameName = categories.find((k) => k.id !== LOCKED_CATEGORY.none && (k.parentId ?? null) === parentId && labelKey(k.label) === labelKey(label));
    if (sameName) {
      folderMap.set(f.id, sameName.id);
      mappedFolders.push({ from: f.id, to: sameName.id, label: sameName.label });
    } else if (depthOf(categories, parentId) + 1 > GROUP_LIMITS.depth) {
      folderMap.set(f.id, parentId ?? LOCKED_CATEGORY.none);
      foldersOverDepth.push(filePath(f).join(' / '));
    } else if (categories.length >= CONFIG_LIMITS.categories) {
      folderMap.set(f.id, parentId ?? LOCKED_CATEGORY.none);
      foldersOverLimit++;
    } else {
      // (The legacy 我的服务 of an old backup, id `hosted`, becomes an ordinary group of that name.)
      let id = Id.test(f.id) && f.id.length <= 64 ? f.id : `g${createdFolders.length}${Date.now().toString(36)}`;
      for (let i = 2; byId.has(id); i++) id = `${f.id.slice(0, 56)}-${i}`;
      const k: Category = { id, label, locked: false, parentId };
      categories = placeGroup(categories, k);
      byId.set(id, k);
      folderMap.set(f.id, id);
      createdFolders.push(k);
    }
  }
  const folderOf = (id: string | null) => (id && folderMap.has(id) ? folderMap.get(id)! : id && byId.has(id) ? id : LOCKED_CATEGORY.none);

  // ── items ──
  const liveByUrl = new Map<string, Item>();
  for (const i of basis.live) if (!liveByUrl.has(itemUrlKey(i.url))) liveByUrl.set(itemUrlKey(i.url), i);
  // UI v2 (N3): the same catalog entry is the same favorite even when its address was changed (a
  // starter site of a local collection merged into an account that has it too).
  const liveByCatalog = new Map<string, Item>();
  for (const i of basis.live) if (i.catalogId && !liveByCatalog.has(i.catalogId)) liveByCatalog.set(i.catalogId, i);
  const taken = new Set(basis.takenIds);
  const seen = new Set<string>();
  /** Backup id → the item it is now (created or existing), for the pins. */
  const target = new Map<string, string>();
  const plan: RestorePlan = { categories, createdFolders, mappedFolders, foldersOverLimit, foldersOverDepth, create: [], update: [], duplicates: [], skipped: 0, repeated: 0, unsupported: 0, pins: [], pinsRestored: 0, pinsNotPinned: 0, iconsMissing: 0, kinds: { app: 0, page: 0 } };
  const pinnedInFile: string[] = [];
  for (const raw of file.items) {
    const e = readEntry(raw);
    if (!e) {
      plan.unsupported++;
      continue;
    }
    const key = itemUrlKey(e.url);
    if (seen.has(key)) {
      plan.repeated++;
      continue;
    }
    seen.add(key);
    const folderId = folderOf(e.folderId);
    const app = appOf(e, folderId, basis.admin);
    if (e.pinned && e.fileId) pinnedInFile.push(e.fileId);
    const existing = liveByUrl.get(key) ?? (e.catalogId ? liveByCatalog.get(e.catalogId) : undefined);
    // The same address is already here: listed in the preview; skipped, updated, or kept as both.
    if (existing) plan.duplicates.push({ fileId: e.fileId, title: e.title, url: e.url, existingId: existing.id, existingTitle: existing.title });
    if (existing && duplicates !== 'keep-both') {
      if (e.fileId) target.set(e.fileId, existing.id);
      if (duplicates === 'update') plan.update.push({ id: existing.id, title: e.title, url: e.url, folderId, tags: e.tags, note: e.note, kind: e.kind, catalogId: e.catalogId, extra: app ? extraOf(app.entry) : null });
      else plan.skipped++;
      continue;
    }
    let id = e.fileId && !taken.has(e.fileId) ? e.fileId : newItemId();
    while (taken.has(id)) id = newItemId();
    taken.add(id);
    if (e.fileId) target.set(e.fileId, id);
    let icon: PlannedItem['icon'] = null;
    if (app?.entry.icon.source === 'upload') {
      const data = file.icons[app.entry.icon.ref];
      const png = data ? decodePng(data) : null;
      if (png) icon = { data: png, dataUrl: data! };
      else {
        // The backup has no data for this icon (a version 1 file, or a damaged one): the site's own icon instead.
        app.entry = { ...app.entry, icon: { source: 'auto', ref: '', letter: '', tone: 0 } };
        plan.iconsMissing++;
      }
    }
    plan.create.push({ id, fileId: e.fileId, kind: e.kind, title: e.title, url: e.url, folderId, tags: e.tags, note: e.note, catalogId: e.catalogId, createdAt: e.createdAt, iconRef: e.iconRef, app: app ? { ...app.entry, id } : null, icon });
    plan.kinds[e.kind]++;
  }

  // ── pins: what is pinned stays first; the backup's follow in its order, within the one rule ──
  const order = (file.pins.length ? file.pins : pinnedInFile).map((id) => target.get(id)).filter((x): x is string => !!x);
  const pinnable = new Map<string, boolean>();
  for (const c of plan.create) pinnable.set(c.id, isPinnable(c.app ?? { kind: 'site', hidden: false }));
  for (const id of basis.pinnableIds) if (!pinnable.has(id)) pinnable.set(id, true);
  const pins = [...basis.pins];
  for (const id of [...new Set(order)]) {
    if (pins.includes(id)) continue;
    if (!pinnable.get(id) || pins.length >= MAX_PINS) {
      plan.pinsNotPinned++;
      continue;
    }
    pins.push(id);
    plan.pinsRestored++;
  }
  plan.pins = pins;
  return plan;
}

/**
 * The home-page entry an item carries (`app` in a version 2 backup): checked like any app entry,
 * health checks off for accounts that are not the operator's (the server would probe the address).
 */
function appOf(e: FileEntry, folderId: string, admin: boolean): { entry: AppEntry } | null {
  if (!e.app) return null;
  const parsed = AppSchema.safeParse({ kind: 'site', icon: { source: 'auto', ref: '', letter: '', tone: 0 }, ...e.app, id: e.fileId ?? 'restored', name: clip(e.title, 32) || clip(e.url, 32), url: e.url, categoryId: folderId, ...(e.catalogId ? { catalogId: e.catalogId } : {}), version: undefined });
  if (!parsed.success) return null;
  const entry = parsed.data;
  // UI v2 (N2): a service may sit in any group (no longer bound to 我的服务).
  if (!admin && entry.health.enabled) entry.health = { ...entry.health, enabled: false };
  return { entry };
}

/** What a restore reports (the preview shows the same numbers). */
export function restoreSummary(plan: RestorePlan) {
  return {
    folders: { create: plan.createdFolders.map((k) => ({ id: k.id, label: k.label, parentId: k.parentId ?? null })), map: plan.mappedFolders, overLimit: plan.foldersOverLimit, overDepth: plan.foldersOverDepth },
    items: { create: plan.create.length, update: plan.update.length, skip: plan.skipped, repeated: plan.repeated, unsupported: plan.unsupported, kinds: plan.kinds },
    duplicates: plan.duplicates.slice(0, 50),
    duplicateCount: plan.duplicates.length,
    pins: { restore: plan.pinsRestored, notPinned: plan.pinsNotPinned, limit: MAX_PINS },
    icons: { upload: plan.create.filter((c) => c.icon).length, missing: plan.iconsMissing },
  };
}
export type RestoreSummary = ReturnType<typeof restoreSummary>;
