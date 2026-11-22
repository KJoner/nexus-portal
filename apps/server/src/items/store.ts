import { AppSchema, extraOf, isPinnable, itemUrlKey, LOCKED_CATEGORY, MAX_PINS, OpError, type AppEntry, type Config, type Item, type ItemField, type ItemKind, type ItemSource, type Op } from '@nexus/shared';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db';

/**
 * Table access for 我的收藏 (items, pins, the per-account change sequence). Every method runs in
 * the caller's transaction — the caller holds the account's lock (ConfigRepo.lock).
 */
export interface Row {
  id: string;
  kind: ItemKind;
  source: ItemSource;
  catalog_id: string | null;
  title: string;
  url: string;
  url_key: string;
  folder_id: string;
  tags: string;
  note: string;
  icon_ref: string;
  extra: string;
  position: number;
  version: number;
  field_versions: string;
  import_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export const SHARED_LAYOUT = 'shared';

/** A pin the rule refuses (NEX-07): over the limit, not a live item, or not something the home page shows. */
export class PinRefused extends Error {
  constructor(
    readonly code: 'PINS_FULL' | 'NOT_PINNABLE' | 'NOT_FOUND' | 'ITEM_DELETED',
    message: string,
    /** Pins the account has now. */
    readonly used: number,
  ) {
    super(message);
    this.name = 'PinRefused';
  }
}
/** The home page shows at most this many characters of a name (the v0.3 schema; older clients validate it). */
const APP_NAME_MAX = 32;
const clip = (s: string, n: number) => [...s].slice(0, n).join('').trim();
const parse = <T>(s: string, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const newItemId = () => `it-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12)}`;

function toItem(r: Row, pinned: Set<string>): Item {
  return {
    id: r.id,
    kind: r.kind,
    source: r.source,
    catalogId: r.catalog_id,
    title: r.title,
    url: r.url,
    folderId: r.folder_id,
    tags: parse<string[]>(r.tags, []),
    note: r.note,
    iconRef: r.icon_ref,
    version: Number(r.version),
    pinned: pinned.has(r.id),
    position: Number(r.position),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
    importId: r.import_id,
  };
}

/**
 * The home page's view of an item (config.apps entry); null when it cannot be shown there. It
 * carries the row version (NEX-04): clients send it back as the base of their next change.
 */
export function toApp(r: Row): AppEntry | null {
  const extra = parse<Partial<AppEntry>>(r.extra, {});
  const parsed = AppSchema.safeParse({
    kind: 'site',
    icon: { source: 'auto', ref: '', letter: '', tone: 0 },
    ...extra,
    id: r.id,
    name: clip(r.title, APP_NAME_MAX) || clip(r.url, APP_NAME_MAX),
    url: r.url,
    categoryId: r.folder_id || LOCKED_CATEGORY.none,
    ...(r.catalog_id ? { catalogId: r.catalog_id } : {}),
    version: Number(r.version),
  });
  return parsed.success ? parsed.data : null;
}

/** What an app entry stores besides the item's own columns (one definition, shared with the browser's local collection). */
export { extraOf };

/** What a changed home-view entry changes in its item (the view clips long titles: see below). */
function changesOf(old: AppEntry, app: AppEntry): Partial<Record<'title' | 'url' | 'folderId' | 'catalogId' | 'extra', string | null>> {
  const set: Partial<Record<'title' | 'url' | 'folderId' | 'catalogId' | 'extra', string | null>> = {};
  // The view shows at most 32 characters of a longer title: an unchanged clipped name keeps the title.
  if (app.name !== old.name) set.title = app.name;
  if (app.url !== old.url) set.url = app.url;
  if (app.categoryId !== old.categoryId) set.folderId = app.categoryId;
  if ((app.catalogId ?? null) !== (old.catalogId ?? null)) set.catalogId = app.catalogId ?? null;
  if (extraOf(app) !== extraOf(old)) set.extra = extraOf(app);
  return set;
}

/** Ids an op names directly (the rows the server must look at before applying it). */
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

/** An op with the ids of apps created in the same batch replaced by the ids they were given. */
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
      return { ...op, appId: m(op.appId) };
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

/**
 * The batch as the server will apply it (NEX-04). The home view only holds live apps and pinned
 * pages, so the reducer alone cannot tell a deleted app from one that never existed: these come
 * from the items table.
 */
export interface HomePlan {
  /** The view the ops apply to (live items they name that the view does not show are added). */
  config: Config;
  ops: Op[];
  /** Deleted items this batch explicitly brings back (app.restore, or a whole-configuration replace). */
  restores: Set<string>;
  /** Live items that are not on the home page (pages): changed in place, their order untouched. */
  extra: Set<string>;
}

export interface ItemDraft {
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
  /** Kept from a backup being restored (NEX-06); otherwise now. */
  createdAt?: number;
}

export class ItemStore {
  constructor(
    private db: DB,
    private now: () => number = Date.now,
  ) {}

  // ── change sequence ──────────────────────────────────────────────────────
  async nextSeq(owner: string): Promise<number> {
    await this.db.run('update user_config set item_seq = item_seq + 1 where owner_id = ?', [owner]);
    return Number((await this.db.get<{ s: number }>('select item_seq as s from user_config where owner_id = ?', [owner]))!.s);
  }

  async seq(owner: string): Promise<number> {
    return Number((await this.db.get<{ s: number }>('select item_seq as s from user_config where owner_id = ?', [owner]))?.s ?? 0);
  }

  async change(owner: string, entity: 'item' | 'pins' | 'folders', id: string, version: number, action: string): Promise<number> {
    const seq = await this.nextSeq(owner);
    await this.db.run('insert into item_changes (owner_id, seq, entity, entity_id, version, action, at) values (?, ?, ?, ?, ?, ?, ?)', [owner, seq, entity, id, version, action, this.now()]);
    return seq;
  }

  async changesSince(owner: string, after: number, limit: number) {
    return this.db.all<{ seq: number; entity: 'item' | 'pins' | 'folders'; entity_id: string; version: number; action: string }>('select seq, entity, entity_id, version, action from item_changes where owner_id = ? and seq > ? order by seq limit ?', [owner, after, limit]);
  }

  async oldestSeq(owner: string): Promise<number | null> {
    const r = await this.db.get<{ s: number | null }>('select min(seq) as s from item_changes where owner_id = ?', [owner]);
    return r?.s === null || r?.s === undefined ? null : Number(r.s);
  }

  /** Keeps the last `keep` changes of the account; older cursors then answer CURSOR_EXPIRED. */
  async prune(owner: string, keep: number): Promise<void> {
    const seq = await this.seq(owner);
    await this.db.run('delete from item_changes where owner_id = ? and seq <= ?', [owner, seq - keep]);
  }

  // ── reads ────────────────────────────────────────────────────────────────
  /**
   * The pins as every reader sees them (NEX-07): live, pinnable (a shown site — not a service, not
   * hidden) and at most MAX_PINS, in order. The home page, 我的收藏's pinned flags, snapshots,
   * changes and exports all read this one list, so they cannot disagree; writes go through
   * writePins, which refuses anything this list would not show.
   */
  async pinnedIds(owner: string, layout = SHARED_LAYOUT): Promise<string[]> {
    const rows = await this.db.all<Row>('select i.* from pins p join items i on i.owner_id = p.owner_id and i.id = p.item_id where p.owner_id = ? and p.layout = ? and i.deleted_at is null order by p.position', [owner, layout]);
    return rows
      .filter((r) => {
        const app = toApp(r);
        return !!app && isPinnable(app);
      })
      .map((r) => r.id)
      .slice(0, MAX_PINS);
  }

  /**
   * The one rule for every way of pinning (NEX-07: create with pinToHome, update of a duplicate,
   * the pin interfaces, home-page ops, import): the account's transaction, live items only,
   * pinnable ones only, at most MAX_PINS. Throws PinRefused; nothing is written then.
   */
  async writePins(owner: string, ids: readonly string[], layout = SHARED_LAYOUT): Promise<string[]> {
    const list = [...new Set(ids)];
    const before = await this.pinnedIds(owner, layout);
    if (list.length > MAX_PINS) throw new PinRefused('PINS_FULL', `首页最多固定 ${MAX_PINS} 个`, before.length);
    const rows = new Map<string, Row>();
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      for (const r of await this.db.all<Row>(`select * from items where owner_id = ? and id in (${chunk.map(() => '?').join(', ')})`, [owner, ...chunk])) rows.set(r.id, r);
    }
    for (const id of list) {
      const r = rows.get(id);
      if (!r) throw new PinRefused('NOT_FOUND', '收藏不存在', before.length);
      if (r.deleted_at !== null) throw new PinRefused('ITEM_DELETED', `「${r.title}」已被删除，不能固定`, before.length);
      const app = toApp(r);
      if (!app || !isPinnable(app)) throw new PinRefused('NOT_PINNABLE', `「${r.title}」不能固定到首页（自托管服务显示在服务区，隐藏的应用先取消隐藏）`, before.length);
    }
    const same = list.length === before.length && list.every((id, i) => id === before[i]);
    // Rows a reader would not show (an older release's excess) are cleaned up by any write.
    const stored = Number((await this.db.get<{ n: number }>('select count(*) as n from pins where owner_id = ? and layout = ?', [owner, layout]))!.n);
    if (same && stored === list.length) return before;
    await this.db.run('delete from pins where owner_id = ? and layout = ?', [owner, layout]);
    let i = 0;
    for (const id of list) await this.db.run('insert into pins (owner_id, item_id, layout, position) values (?, ?, ?, ?)', [owner, id, layout, i++]);
    await this.change(owner, 'pins', layout, await this.seq(owner), 'pins');
    return list;
  }

  /** Pins one item at `position` (default: last). Already pinned: moved there, or left as it is. */
  async pin(owner: string, id: string, position?: number): Promise<string[]> {
    const pins = await this.pinnedIds(owner);
    const rest = pins.filter((x) => x !== id);
    if (!pins.includes(id) && pins.length >= MAX_PINS) throw new PinRefused('PINS_FULL', `首页最多固定 ${MAX_PINS} 个`, pins.length);
    if (pins.includes(id) && position === undefined) return pins;
    rest.splice(Math.min(position ?? rest.length, rest.length), 0, id);
    return this.writePins(owner, rest);
  }

  async unpin(owner: string, id: string): Promise<string[]> {
    const pins = await this.pinnedIds(owner);
    return pins.includes(id) ? this.writePins(owner, pins.filter((x) => x !== id)) : pins;
  }

  async get(owner: string, id: string): Promise<Item | null> {
    const r = await this.db.get<Row>('select * from items where owner_id = ? and id = ?', [owner, id]);
    return r ? toItem(r, new Set(await this.pinnedIds(owner))) : null;
  }

  async row(owner: string, id: string): Promise<Row | undefined> {
    return this.db.get<Row>('select * from items where owner_id = ? and id = ?', [owner, id]);
  }

  /** All items of the account in their order (tombstones only when asked). */
  async list(owner: string, opts: { deleted?: boolean; limit?: number; after?: { position: number; id: string } | null } = {}): Promise<Item[]> {
    const pinned = new Set(await this.pinnedIds(owner));
    const where = opts.deleted ? 'deleted_at is not null' : 'deleted_at is null';
    const after = opts.after ? ' and (position > ? or (position = ? and id > ?))' : '';
    const params: (string | number)[] = [owner, ...(opts.after ? [opts.after.position, opts.after.position, opts.after.id] : []), opts.limit ?? 100_000];
    const rows = await this.db.all<Row>(`select * from items where owner_id = ? and ${where}${after} order by position, id limit ?`, params);
    return rows.map((r) => toItem(r, pinned));
  }

  /** What a restore plans against (NEX-06), read inside the account's transaction. */
  async restoreBasis(owner: string): Promise<{ live: Item[]; takenIds: Set<string>; pins: string[]; pinnableIds: Set<string> }> {
    const rows = await this.db.all<Row>('select * from items where owner_id = ?', [owner]);
    const pins = await this.pinnedIds(owner);
    const pinned = new Set(pins);
    const liveRows = rows.filter((r) => r.deleted_at === null);
    return {
      live: liveRows.map((r) => toItem(r, pinned)),
      takenIds: new Set(rows.map((r) => r.id)),
      pins,
      pinnableIds: new Set(
        liveRows
          .filter((r) => {
            const app = toApp(r);
            return !!app && isPinnable(app);
          })
          .map((r) => r.id),
      ),
    };
  }

  /** Full rows of the account's live items (the export carries what the home page stores for each). */
  async liveRows(owner: string): Promise<Row[]> {
    return this.db.all<Row>('select * from items where owner_id = ? and deleted_at is null order by position, id', [owner]);
  }

  async countLive(owner: string): Promise<number> {
    return Number((await this.db.get<{ n: number }>('select count(*) as n from items where owner_id = ? and deleted_at is null', [owner]))!.n);
  }

  async findByUrl(owner: string, url: string): Promise<Item | null> {
    const r = await this.db.get<Row>('select * from items where owner_id = ? and url_key = ? and deleted_at is null order by created_at limit 1', [owner, itemUrlKey(url)]);
    return r ? toItem(r, new Set(await this.pinnedIds(owner))) : null;
  }

  async maxPosition(owner: string): Promise<number> {
    return Number((await this.db.get<{ p: number | null }>('select max(position) as p from items where owner_id = ?', [owner]))?.p ?? 0);
  }

  // ── writes ───────────────────────────────────────────────────────────────
  async insert(owner: string, d: ItemDraft): Promise<Item> {
    const t = this.now();
    const created = d.createdAt ?? t;
    const id = d.id ?? newItemId();
    const position = d.position ?? (await this.maxPosition(owner)) + 1;
    await this.db.run(
      'insert into items (owner_id, id, kind, source, catalog_id, title, url, url_key, folder_id, tags, note, icon_ref, extra, position, version, field_versions, import_id, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, null)',
      [owner, id, d.kind, d.source, d.catalogId ?? null, d.title, d.url, itemUrlKey(d.url), d.folderId || LOCKED_CATEGORY.none, JSON.stringify(d.tags ?? []), d.note ?? '', d.iconRef ?? '', d.extra ?? '', position, '{}', d.importId ?? null, created, t],
    );
    await this.change(owner, 'item', id, 1, 'upsert');
    return (await this.get(owner, id))!;
  }

  /**
   * Changes some columns of an item: one new version, the changed fields remember it (field-level
   * CAS for PATCH), one change record.
   */
  async update(owner: string, id: string, set: Partial<Record<ItemField | 'extra' | 'position' | 'kind' | 'catalogId', unknown>>, action: 'upsert' | 'restore' = 'upsert'): Promise<Item> {
    const r = (await this.row(owner, id))!;
    const version = Number(r.version) + 1;
    const fields = parse<Record<string, number>>(r.field_versions, {});
    // A restore is remembered (NEX-04): a later restore made from an older view is a stale one.
    const extraSql = action === 'restore' ? ', deleted_at = null' : '';
    if (action === 'restore') fields.restored = version;
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const col: Record<string, string> = { title: 'title', url: 'url', folderId: 'folder_id', tags: 'tags', note: 'note', iconRef: 'icon_ref', extra: 'extra', position: 'position', kind: 'kind', catalogId: 'catalog_id' };
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined || !col[k]) continue;
      cols.push(`${col[k]} = ?`);
      vals.push(k === 'tags' ? JSON.stringify(v) : (v as string | number | null));
      if (k === 'url') {
        cols.push('url_key = ?');
        vals.push(itemUrlKey(v as string));
      }
      fields[k] = version;
    }
    await this.db.run(`update items set ${[...cols, 'version = ?', 'field_versions = ?', 'updated_at = ?'].join(', ')}${extraSql} where owner_id = ? and id = ?`, [...vals, version, JSON.stringify(fields), this.now(), owner, id]);
    await this.change(owner, 'item', id, version, action);
    return (await this.get(owner, id))!;
  }

  /** Version at which each field last changed (for FIELD_CONFLICT). */
  async fieldVersions(owner: string, id: string): Promise<Record<string, number>> {
    return parse<Record<string, number>>((await this.row(owner, id))?.field_versions ?? '', {});
  }

  /** Tombstone: kept (no resurrection by old writes), removed from every layout. */
  async tombstone(owner: string, id: string): Promise<Item> {
    const r = (await this.row(owner, id))!;
    const version = Number(r.version) + 1;
    await this.db.run('update items set deleted_at = ?, version = ?, updated_at = ? where owner_id = ? and id = ?', [this.now(), version, this.now(), owner, id]);
    const wasPinned = (await this.db.run('delete from pins where owner_id = ? and item_id = ?', [owner, id])).changes > 0;
    await this.change(owner, 'item', id, version, 'delete');
    if (wasPinned) await this.change(owner, 'pins', SHARED_LAYOUT, version, 'pins');
    return (await this.get(owner, id))!;
  }

  async restore(owner: string, id: string): Promise<Item> {
    return this.update(owner, id, {}, 'restore');
  }

  /**
   * Whether an explicit restore made from version `baseVersion` still applies: the item is deleted,
   * and nobody restored it after that version (that deletion was undone already, and the item has
   * been deleted again since — a newer decision the old restore must not overturn).
   */
  async restorable(owner: string, id: string, baseVersion: number | undefined): Promise<boolean> {
    const r = await this.row(owner, id);
    if (!r || r.deleted_at === null) return false;
    const restored = Number(parse<Record<string, number>>(r.field_versions, {}).restored ?? 0);
    return baseVersion === undefined || restored <= baseVersion;
  }

  // ── the home page view (config.apps / config.pins) ───────────────────────
  async migrated(owner: string): Promise<boolean> {
    return !!Number((await this.db.get<{ m: number }>('select items_migrated as m from user_config where owner_id = ?', [owner]))?.m ?? 0);
  }

  /**
   * M5: the account's apps become items (same ids, same order; categories become folders) and its
   * pins keep their order. Runs once, inside the account's transaction.
   */
  async migrate(owner: string, config: Config): Promise<number> {
    let position = 0;
    for (const app of config.apps) {
      await this.db.run(
        'insert into items (owner_id, id, kind, source, catalog_id, title, url, url_key, folder_id, tags, note, icon_ref, extra, position, version, field_versions, import_id, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, null, ?, ?, null) on conflict (owner_id, id) do nothing',
        [owner, app.id, 'app', 'legacy', app.catalogId ?? null, app.name, app.url, itemUrlKey(app.url), app.categoryId, '[]', app.description, '', extraOf(app), ++position, '{}', this.now(), this.now()],
      );
    }
    const live = new Set(config.apps.map((a) => a.id));
    let i = 0;
    for (const id of config.pins.filter((p) => live.has(p))) await this.db.run('insert into pins (owner_id, item_id, layout, position) values (?, ?, ?, ?) on conflict do nothing', [owner, id, SHARED_LAYOUT, i++]);
    await this.db.run('update user_config set items_migrated = 1 where owner_id = ?', [owner]);
    return config.apps.length;
  }

  /** Items the home page shows: every live `app`, plus pinned pages; and the pins in order. */
  async homeView(owner: string): Promise<{ apps: AppEntry[]; pins: string[] }> {
    const pins = await this.pinnedIds(owner);
    const pinned = new Set(pins);
    const rows = await this.db.all<Row>("select * from items where owner_id = ? and deleted_at is null and kind = 'app' order by position, id", [owner]);
    const pages = pins.length ? await this.db.all<Row>(`select * from items where owner_id = ? and deleted_at is null and kind = 'page' and id in (${pins.map(() => '?').join(', ')}) order by position, id`, [owner, ...pins]) : [];
    const apps = [...rows, ...pages].map(toApp).filter((a): a is AppEntry => !!a);
    return { apps, pins: pins.filter((id) => pinned.has(id) && apps.some((a) => a.id === id)) };
  }

  /**
   * Checks a batch of home-page ops against the items table before the reducer runs (NEX-04):
   *  - an edit — or an older client's upsert — of a deleted item is refused (`deleted`): only an
   *    explicit restore brings it back, and the client keeps the edit for the person to decide;
   *  - an explicit restore must still apply (`stale` otherwise) and brings back the server's copy;
   *  - a new app whose id is already taken (by an item in 回收站, or one made elsewhere) gets its own;
   *  - a live item the view does not show (a page that is not pinned) is edited or deleted in place.
   */
  async prepare(owner: string, view: Config, ops: readonly Op[]): Promise<HomePlan> {
    const named = [...new Set(ops.flatMap(idsOf))];
    const rows = new Map<string, Row>();
    for (let i = 0; i < named.length; i += 400) {
      const chunk = named.slice(i, i + 400);
      for (const r of await this.db.all<Row>(`select * from items where owner_id = ? and id in (${chunk.map(() => '?').join(', ')})`, [owner, ...chunk])) rows.set(r.id, r);
    }
    let config = view;
    const restores = new Set<string>();
    const extra = new Set<string>();
    const map = new Map<string, string>();
    const shown = (id: string) => config.apps.some((a) => a.id === id);
    const addToView = (r: Row) => {
      const app = toApp(r);
      if (!app) return;
      config = { ...config, apps: [...config.apps, app] };
      extra.add(r.id);
    };
    const gone = (r: Row, message: string, code: 'deleted' | 'stale') => new OpError(code, message, undefined, { appId: r.id, name: r.title, item: toItem(r, new Set()), current: toApp(r) });
    const out: Op[] = [];
    for (const raw of ops) {
      let op = remapped(raw, map);
      if (op.type === 'app.upsert') {
        const id = idsOf(op)[0];
        const row = id ? rows.get(id) : undefined;
        if (id && op.base === null && (row || shown(id))) {
          const fresh = await this.freeId(owner, id, config, map);
          map.set(id, fresh);
          op = { ...op, app: { ...op.app, id: fresh } };
        } else if (row && row.deleted_at !== null && !restores.has(row.id)) throw gone(row, `「${row.title}」已被删除（在回收站中），这次修改没有应用`, 'deleted');
        // (Restored earlier in this batch: the restore puts it back in the view before this edit runs.)
        else if (row && row.deleted_at === null && !shown(row.id)) addToView(row);
      } else if (op.type === 'app.delete') {
        const row = rows.get(op.appId);
        if (row && row.deleted_at === null && !shown(row.id)) addToView(row);
      } else if (op.type === 'app.restore') {
        const id = idsOf(op)[0];
        const row = id ? rows.get(id) : undefined;
        if (!row) throw new OpError('not_found', '这条收藏不存在，无法恢复');
        // Already back (restored elsewhere, or a retry of this one): nothing to do.
        if (row.deleted_at === null) continue;
        if (!(await this.restorable(owner, row.id, op.baseVersion))) throw gone(row, `「${row.title}」在你删除之后已被恢复过、又被再次删除，所以没有自动恢复；需要时请到收藏库的回收站恢复`, 'stale');
        const app = toApp(row);
        if (!app) throw new OpError('invalid', `「${row.title}」不能显示在首页，请在收藏库中恢复`);
        restores.add(row.id);
        // The server's own copy comes back, not the (possibly older) one the client remembers.
        op = { ...op, app };
      } else if (op.type === 'config.replace') {
        // Replacing the whole configuration (导入配置 / 恢复默认) is an explicit choice of every entry in it.
        for (const id of idsOf(op)) if (rows.get(id)?.deleted_at != null) restores.add(id);
      }
      out.push(op);
    }
    return { config, ops: out, restores, extra };
  }

  /** `github` taken → `github-2`, `github-3`… (free in the view, in this batch and in the table). */
  private async freeId(owner: string, id: string, config: Config, map: ReadonlyMap<string, string>): Promise<string> {
    const stem = id.replace(/-\d+$/, '').slice(0, 56) || 'app';
    const used = new Set([...config.apps.map((a) => a.id), ...map.values()]);
    for (let i = 2; ; i++) {
      const candidate = `${stem}-${i}`;
      if (used.has(candidate)) continue;
      if (!(await this.db.get('select 1 as x from items where owner_id = ? and id = ?', [owner, candidate]))) return candidate;
    }
  }

  /**
   * Writes the difference between two home views back to the tables (older clients and the home
   * page keep editing `config.apps`/`config.pins` with ops). Returns whether anything changed.
   * `plan` (from `prepare`) says which deleted items this batch may restore.
   */
  async applyHomeView(owner: string, before: Config, after: Config, admit: (newItems: number) => Promise<void>, plan: Pick<HomePlan, 'restores' | 'extra'> = { restores: new Set(), extra: new Set() }): Promise<boolean> {
    const pinsChanged = JSON.stringify(before.pins) !== JSON.stringify(after.pins);
    // Most ops (settings, engines, categories) leave the apps array untouched: nothing to write.
    if (before.apps === after.apps && !pinsChanged) return false;
    const prev = new Map(before.apps.map((a) => [a.id, a]));
    const next = new Map(after.apps.map((a) => [a.id, a]));
    // One query for every row of the account instead of one per app.
    const rows = new Map((await this.db.all<{ id: string; position: number; deleted_at: number | null }>('select id, position, deleted_at from items where owner_id = ?', [owner])).map((r) => [r.id, r]));
    let changed = false;
    const fresh = after.apps.filter((a) => !prev.has(a.id));
    if (fresh.length) await admit(fresh.length);
    let position = 0;
    for (const app of before.apps === after.apps ? [] : after.apps) {
      // A page edited through the home page keeps its place in 我的收藏: the view orders only its own.
      const ordered = !plan.extra.has(app.id);
      if (ordered) position++;
      const old = prev.get(app.id);
      const row = rows.get(app.id);
      if (!row) {
        await this.insert(owner, { id: app.id, kind: 'app', source: app.catalogId ? 'catalog' : 'manual', catalogId: app.catalogId ?? null, title: app.name, url: app.url, folderId: app.categoryId, note: app.description, extra: extraOf(app), position });
        changed = true;
        continue;
      }
      const was = old ?? toApp((await this.row(owner, app.id))!);
      const set: Parameters<ItemStore['update']>[2] = was ? changesOf(was, app) : { title: app.name, url: app.url, folderId: app.categoryId, extra: extraOf(app) };
      if (ordered && Number(row.position) !== position) set.position = position;
      if (row.deleted_at !== null) {
        // Only an explicit restore brings a deleted item back (NEX-04) — never an upsert.
        if (!plan.restores.has(app.id)) throw new OpError('deleted', `「${app.name}」已被删除（在回收站中），这次修改没有应用`, undefined, { appId: app.id, name: app.name });
        await this.update(owner, app.id, set, 'restore');
        changed = true;
      } else if (Object.keys(set).length) {
        await this.update(owner, app.id, set);
        changed = true;
      }
    }
    for (const id of before.apps === after.apps ? [] : prev.keys()) {
      if (next.has(id)) continue;
      const row = rows.get(id);
      if (row && row.deleted_at === null) {
        await this.tombstone(owner, id);
        changed = true;
      }
    }
    if (pinsChanged) {
      // The same rule as every other way of pinning (NEX-07), checked again in this transaction.
      try {
        await this.writePins(owner, after.pins);
      } catch (e) {
        if (e instanceof PinRefused) throw e.code === 'PINS_FULL' ? new OpError('pins_full', e.message, { kind: 'pins', limit: MAX_PINS, used: e.used }) : new OpError(e.code === 'NOT_PINNABLE' ? 'not_pinnable' : 'not_found', e.message);
        throw e;
      }
      changed = true;
    }
    return changed;
  }

  // ── idempotency ──────────────────────────────────────────────────────────
  async findOp(owner: string, opId: string) {
    return this.db.get<{ request_hash: string; status: number; result: string }>('select request_hash, status, result from item_ops where owner_id = ? and op_id = ?', [owner, opId]);
  }

  async saveOp(owner: string, opId: string, hash: string, status: number, result: unknown): Promise<void> {
    await this.db.run('insert into item_ops (owner_id, op_id, request_hash, status, result, created_at) values (?, ?, ?, ?, ?, ?)', [owner, opId, hash, status, JSON.stringify(result), this.now()]);
  }

  async pruneOps(owner: string, olderThan: number): Promise<void> {
    await this.db.run('delete from item_ops where owner_id = ? and created_at < ?', [owner, olderThan]);
  }
}
