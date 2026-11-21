import Sqlite from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindable, type Database, type Param, type RunResult } from './sql';

/**
 * SQLite back end (better-sqlite3): self-hosted single-container deployments, tests, and the
 * source of the PostgreSQL migration. One connection, so every statement is serialised through a
 * promise chain; a transaction keeps the connection until it commits.
 */
export class SqliteDatabase implements Database {
  readonly dialect = 'sqlite' as const;
  private chain: Promise<unknown> = Promise.resolve();
  private inTx = new AsyncLocalStorage<true>();
  private statements = new Map<string, Sqlite.Statement>();

  constructor(readonly raw: Sqlite.Database) {}

  private stmt(sql: string): Sqlite.Statement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.statements.size > 500) this.statements.clear();
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Runs `fn` after everything queued before it — unless this call is part of the open transaction. */
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return Promise.resolve().then(fn);
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  all<T>(sql: string, params: readonly Param[] = []): Promise<T[]> {
    return this.exclusive(() => this.stmt(sql).all(...bindable(params)) as T[]);
  }

  get<T>(sql: string, params: readonly Param[] = []): Promise<T | undefined> {
    return this.exclusive(() => this.stmt(sql).get(...bindable(params)) as T | undefined);
  }

  run(sql: string, params: readonly Param[] = []): Promise<RunResult> {
    return this.exclusive(() => ({ changes: this.stmt(sql).run(...bindable(params)).changes }));
  }

  exec(sql: string): Promise<void> {
    return this.exclusive(() => {
      this.statements.clear();
      this.raw.exec(sql);
    });
  }

  tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return fn();
    return this.exclusive(async () => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await this.inTx.run(true, fn);
        this.raw.exec('COMMIT');
        return result;
      } catch (e) {
        if (this.raw.inTransaction) this.raw.exec('ROLLBACK');
        throw e;
      }
    });
  }

  async close(): Promise<void> {
    await this.exclusive(() => undefined);
    if (this.raw.open) this.raw.close();
  }

  /** SQLite-only tooling (`user_version`, `quick_check`); not part of the shared interface. */
  pragma(source: string, options?: Sqlite.PragmaOptions): unknown {
    return this.raw.pragma(source, options);
  }

  /** SQLite-only, synchronous: maintenance tooling and assertions in tests. Repositories use the async interface. */
  prepare(sql: string): Sqlite.Statement {
    return this.raw.prepare(sql);
  }
}
