import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/** Append-only; `user_version` records how many have run. */
const MIGRATIONS: string[] = [
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
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
