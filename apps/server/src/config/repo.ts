import { applyOps, ConfigSchema, defaultConfig, normalizeConfig, type Config, type Op, type Snapshot } from '@nexus/shared';
import type { DB } from '../db';

const OP_LOG_KEEP = 500;

export interface ApplyResult {
  snapshot: Snapshot;
  changed: boolean;
  /** The batch was applied before (client retry after a lost response). */
  duplicate: boolean;
}

/** Owns the configuration document. Every write runs in a transaction and bumps the revision. */
export class ConfigRepo {
  private listeners = new Set<(revision: number) => void>();

  constructor(private db: DB) {
    const row = db.prepare('select 1 from config where id = 1').get();
    if (!row) {
      db.prepare('insert into config (id, revision, updated_at, data) values (1, 1, ?, ?)').run(new Date().toISOString(), JSON.stringify(defaultConfig()));
    }
  }

  snapshot(): Snapshot {
    const row = this.db.prepare('select revision, updated_at, data from config where id = 1').get() as { revision: number; updated_at: string; data: string };
    const parsed = ConfigSchema.safeParse(JSON.parse(row.data));
    // A document that no longer validates (manual edit, schema change) must not take the portal down.
    const config = parsed.success ? normalizeConfig(parsed.data) : defaultConfig();
    return { revision: row.revision, updatedAt: row.updated_at, config };
  }

  /** Revision and time only — no parsing — for conditional requests that usually answer 304. */
  version(): { revision: number; updatedAt: string } {
    const row = this.db.prepare('select revision, updated_at from config where id = 1').get() as { revision: number; updated_at: string };
    return { revision: row.revision, updatedAt: row.updated_at };
  }

  /** Applies a batch atomically. Throws `OpError` (nothing is written) when any op is rejected. */
  apply(batchId: string, clientId: string, ops: Op[]): ApplyResult {
    return this.db.transaction((): ApplyResult => {
      const seen = this.db.prepare('select 1 from op_log where batch_id = ?').get(batchId);
      const current = this.snapshot();
      if (seen) return { snapshot: current, changed: false, duplicate: true };
      const next = applyOps(current.config, ops);
      if (next === current.config) return { snapshot: current, changed: false, duplicate: false };
      const snapshot = this.write(current.revision + 1, next);
      this.db.prepare('insert into op_log (revision, batch_id, client_id, ops, created_at) values (?, ?, ?, ?, ?)').run(snapshot.revision, batchId, clientId, JSON.stringify(ops), snapshot.updatedAt);
      this.db.prepare('delete from op_log where revision <= ?').run(snapshot.revision - OP_LOG_KEEP);
      return { snapshot, changed: true, duplicate: false };
    })();
  }

  /** Server-side changes outside ops (e.g. a deleted wallpaper) still bump the revision for sync. */
  touch(): Snapshot {
    const current = this.snapshot();
    const snapshot = this.write(current.revision + 1, current.config);
    this.emit(snapshot.revision);
    return snapshot;
  }

  private write(revision: number, config: Config): Snapshot {
    const updatedAt = new Date().toISOString();
    this.db.prepare('update config set revision = ?, updated_at = ?, data = ? where id = 1').run(revision, updatedAt, JSON.stringify(config));
    return { revision, updatedAt, config };
  }

  onChange(fn: (revision: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(revision: number) {
    for (const fn of this.listeners) fn(revision);
  }
}
