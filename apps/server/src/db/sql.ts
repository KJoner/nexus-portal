/**
 * Storage interface shared by the SQLite and PostgreSQL back ends (v0.4, 公开化批次 C).
 *
 * Every repository talks to this, never to a driver. Statements use `?` placeholders and the
 * common subset of both dialects (ON CONFLICT … DO UPDATE, RETURNING, LIMIT/OFFSET); integers that
 * may exceed 2³¹ (timestamps in ms, revisions) are `bigint` in PostgreSQL and come back as numbers.
 *
 * Transactions: inside `tx(fn)` every call on the same database — including calls made by other
 * repositories that `fn` happens to use — joins the transaction (AsyncLocalStorage). Code inside a
 * transaction must only do database work: SQLite holds its single connection for the duration.
 */
export type Param = string | number | bigint | boolean | null | Uint8Array;

export interface RunResult {
  changes: number;
}

export interface Queryable {
  all<T = Record<string, unknown>>(sql: string, params?: readonly Param[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: readonly Param[]): Promise<T | undefined>;
  run(sql: string, params?: readonly Param[]): Promise<RunResult>;
}

export interface Database extends Queryable {
  readonly dialect: 'sqlite' | 'pg';
  /** Several statements, no parameters (schema changes). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `?` → `$1…$n`. Statements in this code base never contain a literal question mark. */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** A unique constraint refused the write (PostgreSQL 23505; SQLite UNIQUE / PRIMARY KEY). */
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Inside a transaction, `select … for update` on PostgreSQL: the row stays locked until commit, so
 * concurrent read-modify-write transactions queue instead of overwriting each other. SQLite needs
 * nothing (its transactions are exclusive here) and has no such clause.
 */
export const forUpdate = (db: Database): string => (db.dialect === 'pg' ? ' for update' : '');

/** Booleans are stored as 0/1 in both dialects (the columns are integers). */
export const bindable = (params: readonly Param[]): (string | number | bigint | null | Uint8Array)[] => params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));

/** Rows may carry booleans as 0/1 (SQLite) or numbers (PostgreSQL integer columns). */
export const truthy = (v: unknown) => v === 1 || v === true || v === '1';
