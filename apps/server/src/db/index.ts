import Sqlite from 'better-sqlite3';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvError } from '../env';
import { PgDatabase } from './pg';
import { MIGRATIONS, PG_MIGRATIONS } from './schema';
import type { Database } from './sql';
import { SqliteDatabase } from './sqlite';

export { MIGRATIONS, PG_MIGRATIONS };
export { forUpdate, isUniqueViolation, truthy, type Database, type Param, type Queryable } from './sql';
export { SqliteDatabase } from './sqlite';

/** What repositories hold: either back end, behind the same asynchronous interface. */
export type DB = Database;

/** The account that owns everything a single-user installation stored before v0.4. */
export const LEGACY_ADMIN_ID = 'legacy-admin';

const KEEP_BACKUPS = 5;

/**
 * Opens (and migrates) a SQLite database. Synchronous on purpose: the migrations run on the raw
 * handle before anything else can use it.
 */
export function openDb(file: string): SqliteDatabase {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new Sqlite(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 3000');
  migrate(raw, file);
  return new SqliteDatabase(raw);
}

/**
 * Consistent copy of the database before an upgrade changes it: `<data>/backups/nexus-v<N>-<time>.db`.
 * Only the newest few are kept. Returns the path of the copy.
 */
export function backupDb(db: Sqlite.Database | SqliteDatabase, file: string, version: number): string {
  const raw = db instanceof SqliteDatabase ? db.raw : db;
  const dir = join(dirname(file), 'backups');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `nexus-v${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  raw.exec(`vacuum into '${dest.replace(/'/g, "''")}'`);
  const old = readdirSync(dir)
    .filter((f) => /^nexus-v\d+-.+\.db$/.test(f))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return dest;
}

function migrate(db: Sqlite.Database, file: string) {
  const current = db.pragma('user_version', { simple: true }) as number;
  // A database written by a newer release: running older code on it could corrupt data.
  if (current > MIGRATIONS.length) {
    db.close();
    throw new EnvError(`数据库版本（${current}）比当前程序（${MIGRATIONS.length}）新：请使用较新的镜像，或先恢复升级前的数据备份再回滚到旧版本`);
  }
  // An existing database is copied before the first pending migration touches it.
  if (current > 0 && current < MIGRATIONS.length && file !== ':memory:') {
    const dest = backupDb(db, file, current);
    console.log(`[nexus] 升级数据库前已自动备份：${dest}`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Applies pending PostgreSQL migrations, each in its own transaction. Safe to run on every start. */
export async function migratePg(db: Database): Promise<number> {
  await db.exec('create table if not exists schema_migrations (version integer primary key, applied_at bigint not null)');
  const row = await db.get<{ v: number | null }>('select max(version) as v from schema_migrations');
  const current = Number(row?.v ?? 0);
  if (current > PG_MIGRATIONS.length) throw new EnvError(`数据库版本（${current}）比当前程序（${PG_MIGRATIONS.length}）新：请使用较新的镜像`);
  for (let v = current; v < PG_MIGRATIONS.length; v++) {
    await db.tx(async () => {
      await db.exec(PG_MIGRATIONS[v]!);
      await db.run('insert into schema_migrations (version, applied_at) values (?, ?)', [v + 1, Date.now()]);
    });
  }
  return PG_MIGRATIONS.length;
}

/** PostgreSQL (`NEXUS_DATABASE_URL`), migrated. */
export async function openPg(url: string): Promise<PgDatabase> {
  const db = PgDatabase.connect(url);
  try {
    await migratePg(db);
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  return db;
}
