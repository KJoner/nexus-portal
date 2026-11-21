import { AppSchema, itemUrlKey, LOCKED_CATEGORY, type AppEntry, type Config, type Item, type ItemField, type ItemKind, type ItemSource } from '@nexus/shared';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db';

/**
 * Table access for 我的收藏 (items, pins, the per-account change sequence). Every method runs in
 * the caller's transaction — the caller holds the account's lock (ConfigRepo.lock).
 */
interface Row {
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

/** The home page's view of an item (config.apps entry); null when it cannot be shown there. */
function toApp(r: Row): AppEntry | null {
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
  });
  return parsed.success ? parsed.data : null;
}

/** What an app entry stores besides the item's own columns (service kind, LAN address, health…). */
function extraOf(app: AppEntry): string {
  const { id: _id, name: _name, url: _url, categoryId: _c, catalogId: _k, ...rest } = app;
  return JSON.stringify(rest);
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
  async pinnedIds(owner: string, layout = SHARED_LAYOUT): Promise<string[]> {
    return (await this.db.all<{ item_id: string }>('select item_id from pins where owner_id = ? and layout = ? order by position', [owner, layout])).map((r) => r.item_id);
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
    const id = d.id ?? newItemId();
    const position = d.position ?? (await this.maxPosition(owner)) + 1;
    await this.db.run(
      'insert into items (owner_id, id, kind, source, catalog_id, title, url, url_key, folder_id, tags, note, icon_ref, extra, position, version, field_versions, import_id, created_at, updated_at, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, null)',
      [owner, id, d.kind, d.source, d.catalogId ?? null, d.title, d.url, itemUrlKey(d.url), d.folderId || LOCKED_CATEGORY.none, JSON.stringify(d.tags ?? []), d.note ?? '', d.iconRef ?? '', d.extra ?? '', position, '{}', d.importId ?? null, t, t],
    );
    await this.change(owner, 'item', id, 1, 'upsert');
    return (await this.get(owner, id))!;
  }

  /**
   * Changes some columns of an item: one new version, the changed fields remember it (field-level
   * CAS for PATCH), one change record.
   */
  async update(owner: string, id: string, set: Partial<Record<ItemField | 'extra' | 'position' | 'kind' | 'catalogId', unknown>>, action: 'upsert' | 'restore' = 'upsert', extraSql = ''): Promise<Item> {
    const r = (await this.row(owner, id))!;
    const version = Number(r.version) + 1;
    const fields = parse<Record<string, number>>(r.field_versions, {});
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
    return this.update(owner, id, {}, 'restore', ', deleted_at = null');
  }

  /** Replaces a layout's pins (ids must be live items of the account). */
  async setPins(owner: string, ids: string[], layout = SHARED_LAYOUT): Promise<void> {
    await this.db.run('delete from pins where owner_id = ? and layout = ?', [owner, layout]);
    let i = 0;
    for (const id of ids) await this.db.run('insert into pins (owner_id, item_id, layout, position) values (?, ?, ?, ?)', [owner, id, layout, i++]);
    await this.change(owner, 'pins', layout, await this.seq(owner), 'pins');
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
   * Writes the difference between two home views back to the tables (older clients and the home
   * page keep editing `config.apps`/`config.pins` with ops). Returns whether anything changed.
   */
  async applyHomeView(owner: string, before: Config, after: Config, admit: (newItems: number) => Promise<void>): Promise<boolean> {
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
      position++;
      const old = prev.get(app.id);
      const row = rows.get(app.id);
      if (!old || !row) {
        if (row) {
          // A legacy upsert of a deleted id (the home page's 撤销删除): an explicit restore + update.
          await this.update(owner, app.id, { title: app.name, url: app.url, folderId: app.categoryId, extra: extraOf(app), position, kind: 'app' }, 'restore', ', deleted_at = null');
        } else await this.insert(owner, { id: app.id, kind: 'app', source: app.catalogId ? 'catalog' : 'manual', catalogId: app.catalogId ?? null, title: app.name, url: app.url, folderId: app.categoryId, note: app.description, extra: extraOf(app), position });
        changed = true;
        continue;
      }
      const set: Parameters<ItemStore['update']>[2] = {};
      // The view shows at most 32 characters of a longer title: an unchanged clipped name keeps the title.
      if (app.name !== old.name) set.title = app.name;
      if (app.url !== old.url) set.url = app.url;
      if (app.categoryId !== old.categoryId) set.folderId = app.categoryId;
      if ((app.catalogId ?? null) !== (old.catalogId ?? null)) set.catalogId = app.catalogId ?? null;
      if (extraOf(app) !== extraOf(old)) set.extra = extraOf(app);
      if (Number(row.position) !== position) set.position = position;
      if (Object.keys(set).length) {
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
      await this.setPins(owner, after.pins);
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
