import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migratePg, openDb, type DB } from '.';
import { PgDatabase } from './pg';
import { PgliteDatabase } from './pglite';

export type Dialect = 'sqlite' | 'pg';

/**
 * Optional: a real PostgreSQL server for the `pg` half of the suite (a CI service, or a throwaway
 * local container). Each test database is a schema of its own, dropped on close. Never point this
 * at a database that holds data you want to keep.
 */
const PG_URL = process.env.NEXUS_TEST_PG_URL?.trim() ?? '';
/** What `pg` means in this run — for reports and server-only tests. */
export const PG_TARGET: 'pglite' | 'postgresql' = PG_URL ? 'postgresql' : 'pglite';

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Connection settings of one test schema: its tables, and a name to find its sessions by. */
const scoped = (schema: string) => ({ connectionString: PG_URL, options: `-c search_path=${schema}`, application_name: schema });

class SchemaScopedPg extends PgDatabase {
  constructor(
    pool: pg.Pool,
    readonly schema: string,
  ) {
    super(pool);
  }

  override async close(): Promise<void> {
    await super.close();
    await admin((c) => c.query(`drop schema if exists ${this.schema} cascade`));
  }
}

async function realPg(): Promise<DB> {
  const schema = `nexus_test_${randomBytes(6).toString('hex')}`;
  await admin((c) => c.query(`create schema ${schema}`));
  const db = new SchemaScopedPg(new pg.Pool({ ...scoped(schema), max: 8, idleTimeoutMillis: 5_000 }), schema);
  await migratePg(db);
  return db;
}

/**
 * A fresh, migrated database of either kind for tests. `pg` is PGlite — PostgreSQL itself, compiled
 * to WebAssembly — so constraints, placeholders and transactions behave as in production; with
 * `NEXUS_TEST_PG_URL` it is a real server, which also brings real concurrent transactions.
 */
export async function testDb(dialect: Dialect): Promise<DB> {
  if (dialect === 'sqlite') return openDb(':memory:');
  if (PG_URL) return realPg();
  const db = await PgliteDatabase.create();
  await migratePg(db);
  return db;
}

/**
 * Real PostgreSQL only: holds `lockSql` in a separate session while `attempts` start, waits until
 * every attempt is queued behind that lock, then lets them go at once. Forces the interleaving that
 * a race needs instead of hoping for it.
 */
export async function lockStep<T>(db: DB, lockSql: string, params: unknown[], attempts: (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
  if (!(db instanceof SchemaScopedPg)) throw new Error('lockStep needs NEXUS_TEST_PG_URL');
  const side = new pg.Client(scoped(db.schema));
  await side.connect();
  try {
    await side.query('begin');
    await side.query(lockSql, params);
    const running = attempts.map((f) => f());
    const settled = Promise.allSettled(running);
    for (let i = 0; i < 300; i++) {
      // Inside a transaction the list of sessions is a snapshot taken at first use: refresh it, or
      // the sessions the attempts opened after that never show up.
      await side.query('select pg_stat_clear_snapshot()');
      const { rows } = await side.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [db.schema]);
      if (rows[0]!.n >= attempts.length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await side.query('commit');
    return await settled;
  } finally {
    await side.end();
  }
}

/** Both back ends, for `describe.each(DIALECTS)`. */
export const DIALECTS: Dialect[] = ['sqlite', 'pg'];
