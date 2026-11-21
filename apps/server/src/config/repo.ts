import { applyOps, ConfigSchema, defaultConfig, newUserConfig, normalizeConfig, OpError, type Config, type Op, type Snapshot } from '@nexus/shared';
import { forUpdate, LEGACY_ADMIN_ID, type DB } from '../db';
import { ItemStore } from '../items/store';

const OP_LOG_KEEP = 500;

export interface ApplyResult {
  snapshot: Snapshot;
  changed: boolean;
  /** The batch was applied before (client retry after a lost response). */
  duplicate: boolean;
}

/** The first configuration of an account: the legacy administrator keeps the self-hosted seed. */
export const templateFor = (ownerId: string): Config => (ownerId === LEGACY_ADMIN_ID ? defaultConfig() : newUserConfig());

/**
 * Health checks make this server open connections to the addresses in a configuration. That is
 * the operator's tool on the operator's network; for everyone else the switch is forced off on
 * the server, whatever a client sends (a hidden button is not a boundary).
 */
export function sanitizeFor(admin: boolean, c: Config): Config {
  if (admin || !c.apps.some((a) => a.health.enabled)) return c;
  return { ...c, apps: c.apps.map((a) => (a.health.enabled ? { ...a, health: { ...a.health, enabled: false } } : a)) };
}

interface Row {
  revision: number;
  updated_at: string;
  data: string;
}

/**
 * One configuration document per account (v0.4). Every write runs in a transaction, bumps that
 * account's revision and is idempotent per (account, batch id); change notifications only ever
 * reach listeners of the same account.
 */
export class ConfigRepo {
  private listeners = new Map<string, Set<(revision: number) => void>>();
  /** 我的收藏 (v0.4): config.apps / config.pins are a view over these tables. */
  readonly items: ItemStore;

  constructor(
    readonly db: DB,
    private template: (ownerId: string) => Config = templateFor,
    /** Live items an account may keep (null: no limit — the administrator). */
    private itemLimit: (ownerId: string) => Promise<number | null> = async () => null,
    now: () => number = Date.now,
  ) {
    this.items = new ItemStore(db, now);
  }

  /** Creates the account's document on first use (idempotent). */
  async ensure(ownerId: string): Promise<void> {
    await this.db.run('insert into user_config (owner_id, revision, updated_at, data) values (?, 1, ?, ?) on conflict (owner_id) do nothing', [ownerId, new Date().toISOString(), JSON.stringify(this.template(ownerId))]);
  }

  private async row(ownerId: string): Promise<Row> {
    let row = await this.db.get<Row>('select revision, updated_at, data from user_config where owner_id = ?', [ownerId]);
    if (!row) {
      await this.ensure(ownerId);
      row = (await this.db.get<Row>('select revision, updated_at, data from user_config where owner_id = ?', [ownerId]))!;
    }
    return row;
  }

  async snapshot(ownerId: string): Promise<Snapshot> {
    const row = await this.row(ownerId);
    const parsed = ConfigSchema.safeParse(JSON.parse(row.data));
    // A document that no longer validates (manual edit, schema change) must not take the portal down.
    // Since v0.4 it holds settings, categories and engines only: the apps live in the items table,
    // so even this fallback can no longer lose them.
    const doc = parsed.success ? parsed.data : this.template(ownerId);
    // Checked every time (one key lookup): a migration inside a transaction that later rolls back
    // must run again, so no in-memory flag can be trusted here.
    if (!(await this.items.migrated(ownerId))) await this.migrateItems(ownerId);
    const view = await this.items.homeView(ownerId);
    return { revision: Number(row.revision), updatedAt: row.updated_at, config: normalizeConfig({ ...doc, apps: view.apps, pins: view.pins }) };
  }

  /** M5, once per account: its apps and pins move to the items tables (ids and order kept). */
  private async migrateItems(ownerId: string): Promise<void> {
    await this.db.tx(async () => {
      await this.lock(ownerId);
      if (await this.items.migrated(ownerId)) return;
      const row = (await this.db.get<Row>('select revision, updated_at, data from user_config where owner_id = ?', [ownerId]))!;
      const parsed = ConfigSchema.safeParse(JSON.parse(row.data));
      const config = parsed.success ? normalizeConfig(parsed.data) : this.template(ownerId);
      await this.items.migrate(ownerId, config);
      await this.db.run('update user_config set data = ? where owner_id = ?', [JSON.stringify({ ...config, apps: [], pins: [] }), ownerId]);
    });
  }

  /** Revision and time only — no parsing — for conditional requests that usually answer 304. */
  async version(ownerId: string): Promise<{ revision: number; updatedAt: string }> {
    const row = await this.row(ownerId);
    return { revision: Number(row.revision), updatedAt: row.updated_at };
  }

  /**
   * Inside a transaction: takes the owner's row lock (PostgreSQL), so concurrent writers for the same
   * account queue — no lost update, no two documents with one revision, a retried batch is seen.
   */
  async lock(ownerId: string): Promise<void> {
    await this.ensure(ownerId);
    await this.db.get(`select revision from user_config where owner_id = ?${forUpdate(this.db)}`, [ownerId]);
  }

  /** Applies a batch atomically. Throws `OpError` (nothing is written) when any op is rejected. */
  async apply(ownerId: string, batchId: string, clientId: string, ops: Op[], opts: { admin: boolean }): Promise<ApplyResult> {
    return this.db.tx(async (): Promise<ApplyResult> => {
      await this.lock(ownerId);
      const seen = await this.db.get('select 1 as x from op_log where owner_id = ? and batch_id = ?', [ownerId, batchId]);
      const current = await this.snapshot(ownerId);
      if (seen) return { snapshot: current, changed: false, duplicate: true };
      // Deleted items, explicit restores and taken ids are only known to the items table (NEX-04).
      const plan = await this.items.prepare(ownerId, current.config, ops);
      const applied = applyOps(plan.config, plan.ops);
      if (applied === plan.config) return { snapshot: current, changed: false, duplicate: false };
      // Never store a document that would not read back: an unreadable document falls back to the
      // template on the next read, and the next write would make that loss permanent.
      const check = ConfigSchema.safeParse(applied);
      if (!check.success) {
        const issue = check.error.issues[0];
        throw new OpError('invalid', issue ? `${issue.path.join('.') || 'config'}: ${issue.message}` : 'invalid');
      }
      const next = sanitizeFor(opts.admin, applied);
      // The apps and pins go to the items tables; new items count against the account's limit.
      await this.items.applyHomeView(
        ownerId,
        plan.config,
        next,
        async (fresh) => {
          const limit = await this.itemLimit(ownerId);
          if (limit === null) return;
          const used = await this.items.countLive(ownerId);
          if (used + fresh > limit) throw new OpError('quota_exceeded', `收藏库最多 ${limit} 条，请先删除一些`, { kind: 'items', limit, used });
        },
        plan,
      );
      // Folders are config categories: 我的收藏 clients learn about a change through the feed.
      if (JSON.stringify(current.config.categories) !== JSON.stringify(next.categories)) await this.items.change(ownerId, 'folders', 'shared', await this.items.seq(ownerId), 'folders');
      const written = await this.write(ownerId, current.revision + 1, next);
      await this.db.run('insert into op_log (owner_id, revision, batch_id, client_id, ops, created_at) values (?, ?, ?, ?, ?, ?)', [ownerId, written.revision, batchId, clientId, JSON.stringify(ops), written.updatedAt]);
      await this.db.run('delete from op_log where owner_id = ? and revision <= ?', [ownerId, written.revision - OP_LOG_KEEP]);
      // The answer is what the tables hold now, not the reducer's guess: merged edits, ids given to
      // new apps and restored entries all come from there.
      return { snapshot: await this.snapshot(ownerId), changed: true, duplicate: false };
    });
  }

  /**
   * Inside the account's transaction: replaces the folders (categories) of its document — a restore
   * creating the folders of a backup (NEX-06). The revision moves with the write that follows (bump).
   */
  async writeCategories(ownerId: string, categories: Config['categories']): Promise<void> {
    const row = await this.row(ownerId);
    const parsed = ConfigSchema.safeParse(JSON.parse(row.data));
    const doc = parsed.success ? parsed.data : this.template(ownerId);
    const next = normalizeConfig({ ...doc, categories, apps: [], pins: [] });
    const check = ConfigSchema.safeParse(next);
    if (!check.success) throw new OpError('invalid', '分组不正确');
    await this.db.run('update user_config set data = ? where owner_id = ?', [JSON.stringify({ ...next, apps: [], pins: [] }), ownerId]);
    // 我的收藏 clients follow folders through the change feed too.
    await this.items.change(ownerId, 'folders', 'shared', await this.items.seq(ownerId), 'folders');
  }

  /** Server-side changes outside ops (e.g. a deleted wallpaper) still bump the revision for sync. */
  async touch(ownerId: string): Promise<Snapshot> {
    const snapshot = await this.db.tx(async () => {
      await this.lock(ownerId);
      const current = await this.snapshot(ownerId);
      return this.write(ownerId, current.revision + 1, current.config);
    });
    this.emit(ownerId, snapshot.revision);
    return snapshot;
  }

  /** Inside the account's transaction: a new revision for a change made in the items tables. */
  async bump(ownerId: string): Promise<Snapshot> {
    const current = await this.snapshot(ownerId);
    return this.write(ownerId, current.revision + 1, current.config);
  }

  private async write(ownerId: string, revision: number, config: Config): Promise<Snapshot> {
    const updatedAt = new Date().toISOString();
    // Apps and pins are stored as items; the document keeps the rest.
    await this.db.run('update user_config set revision = ?, updated_at = ?, data = ? where owner_id = ?', [revision, updatedAt, JSON.stringify({ ...config, apps: [], pins: [] }), ownerId]);
    return { revision, updatedAt, config };
  }

  onChange(ownerId: string, fn: (revision: number) => void): () => void {
    let set = this.listeners.get(ownerId);
    if (!set) this.listeners.set(ownerId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(ownerId);
    };
  }

  emit(ownerId: string, revision: number) {
    for (const fn of this.listeners.get(ownerId) ?? []) fn(revision);
  }

  /** Accounts that have a configuration (the health checker watches the administrators'). */
  async owners(): Promise<string[]> {
    return (await this.db.all<{ owner_id: string }>('select owner_id from user_config order by owner_id')).map((r) => r.owner_id);
  }
}
