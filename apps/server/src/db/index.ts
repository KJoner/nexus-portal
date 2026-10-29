import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvError } from '../env';

export type DB = Database.Database;

/** Append-only; `user_version` records how many have run. */
export const MIGRATIONS: readonly string[] = [
  `
  create table meta (key text primary key, value text not null);

  -- The whole portal configuration is one validated JSON document. All writes go through the
  -- shared op reducer, so the document is the single source of truth for apps, pins and settings.
  create table config (
    id integer primary key check (id = 1),
    revision integer not null,
    updated_at text not null,
    data text not null
  );

  -- Applied op batches: makes retries idempotent and keeps a short audit trail.
  create table op_log (
    revision integer primary key,
    batch_id text not null unique,
    client_id text not null,
    ops text not null,
    created_at text not null
  );

  create table auth (
    id integer primary key check (id = 1),
    password_hash text not null,
    updated_at text not null
  );

  create table sessions (
    id_hash text primary key,
    created_at integer not null,
    expires_at integer not null,
    last_seen integer not null,
    user_agent text not null default ''
  );
  create index sessions_expiry on sessions (expires_at);

  create table wallpapers (
    id text primary key,
    name text not null,
    width integer not null,
    height integer not null,
    widths text not null,
    placeholder text not null,
    created_at text not null
  );
  `,
  `
  -- Last health result per service; the checker resumes from here after a restart.
  create table health_status (
    app_id text primary key,
    level text not null,
    message text not null,
    checked_at text not null,
    latency_ms integer,
    fails integer not null default 0,
    key text not null,
    via text not null default 'ext'
  );
  `,
  `
  -- Credentials for read-only integrations; token_enc is AES-256-GCM (see integrations/secret.ts).
  create table integrations (
    id text primary key,
    base_url text not null,
    token_enc text not null,
    token_last4 text not null,
    last_ok_at text,
    last_error text,
    updated_at text not null
  );
  `,
  `
  -- v0.2: the configuration document can hold up to 36 pins and new settings that v0.1 cannot
  -- read (it would silently fall back to defaults). Bumping the version makes older releases
  -- refuse this database instead; rolling back means restoring the automatic backup.
  insert or replace into meta (key, value) values ('config_format', '2');
  `,
  `
  -- v0.2: wallpapers from public sources (精选图库, 每日一图, Unsplash, imported addresses).
  alter table wallpapers add column source text not null default 'upload';
  alter table wallpapers add column ref text not null default '';
  alter table wallpapers add column credit text not null default '';
  alter table wallpapers add column luma real;
  alter table wallpapers add column focal text not null default '';
  alter table wallpapers add column remote text not null default '';
  create index wallpapers_source_ref on wallpapers (source, ref);
  `,
];

const KEEP_BACKUPS = 5;

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  migrate(db, file);
  return db;
}

/**
 * Consistent copy of the database before an upgrade changes it: `<data>/backups/nexus-v<N>-<time>.db`.
 * Only the newest few are kept. Returns the path of the copy.
 */
export function backupDb(db: DB, file: string, version: number): string {
  const dir = join(dirname(file), 'backups');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `nexus-v${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`vacuum into '${dest.replace(/'/g, "''")}'`);
  const old = readdirSync(dir)
    .filter((f) => /^nexus-v\d+-.+\.db$/.test(f))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return dest;
}

function migrate(db: DB, file: string) {
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
