import type { PGlite, Transaction } from '@electric-sql/pglite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindable, toPgPlaceholders, type Database, type Param, type RunResult } from './sql';

/**
 * PostgreSQL in WebAssembly (PGlite): the same SQL and constraints as a real server, so the
 * repository tests run against PostgreSQL semantics without a database process. Test-only.
 */
export class PgliteDatabase implements Database {
  readonly dialect = 'pg' as const;
  private txs = new AsyncLocalStorage<Transaction>();

  constructor(private db: PGlite) {}

  static async create(): Promise<PgliteDatabase> {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
    await db.waitReady;
    return new PgliteDatabase(db);
  }

  private target(): PGlite | Transaction {
    return this.txs.getStore() ?? this.db;
  }

  async all<T>(sql: string, params: readonly Param[] = []): Promise<T[]> {
    return (await this.target().query<T>(toPgPlaceholders(sql), bindable(params))).rows;
  }

  async get<T>(sql: string, params: readonly Param[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  async run(sql: string, params: readonly Param[] = []): Promise<RunResult> {
    return { changes: (await this.target().query(toPgPlaceholders(sql), bindable(params))).affectedRows ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.target().exec(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txs.getStore()) return fn();
    return this.db.transaction((t) => this.txs.run(t, fn));
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
