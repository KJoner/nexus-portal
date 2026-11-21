import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { bindable, toPgPlaceholders, type Database, type Param, type RunResult } from './sql';

// bigint columns (timestamps in ms, revisions) as numbers: every value stays below 2^53.
pg.types.setTypeParser(20, (v: string) => Number(v));

/** PostgreSQL back end for public deployments (`NEXUS_DATABASE_URL`). */
export class PgDatabase implements Database {
  readonly dialect = 'pg' as const;
  private client = new AsyncLocalStorage<pg.PoolClient>();

  constructor(private pool: pg.Pool) {}

  static connect(url: string): PgDatabase {
    // Small pool: one Node process, short statements; the database may be shared with Keycloak.
    return new PgDatabase(new pg.Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30_000 }));
  }

  private target(): pg.Pool | pg.PoolClient {
    return this.client.getStore() ?? this.pool;
  }

  async all<T>(sql: string, params: readonly Param[] = []): Promise<T[]> {
    return (await this.target().query(toPgPlaceholders(sql), bindable(params))).rows as T[];
  }

  async get<T>(sql: string, params: readonly Param[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  async run(sql: string, params: readonly Param[] = []): Promise<RunResult> {
    return { changes: (await this.target().query(toPgPlaceholders(sql), bindable(params))).rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.target().query(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.client.getStore()) return fn();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await this.client.run(c, fn);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
