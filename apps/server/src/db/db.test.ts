import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '.';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-db-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('migrations', () => {
  it('reopening an up-to-date database changes nothing', () => {
    const file = join(dir, 'nexus.db');
    const first = openDb(file);
    const version = first.pragma('user_version', { simple: true });
    first.close();
    const again = openDb(file);
    expect(again.pragma('user_version', { simple: true })).toBe(version);
    again.close();
  });

  it('backs up an older database before migrating it, and the copy opens with the old data', () => {
    const file = join(dir, 'nexus.db');
    const db = openDb(file);
    const latest = db.pragma('user_version', { simple: true }) as number;
    // Pretend this is a v0.1 database (3 migrations) with a stored configuration.
    db.prepare("delete from meta where key = 'config_format'").run();
    db.prepare("insert into config (id, revision, updated_at, data) values (1, 7, 'x', '{}')").run();
    db.pragma('user_version = 3');
    db.close();

    openDb(file).close();
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^nexus-v3-.+\.db$/);
    const copy = new Database(join(dir, 'backups', backups[0]!), { readonly: true });
    expect(copy.pragma('user_version', { simple: true })).toBe(3);
    expect(copy.prepare('select revision from config').get()).toEqual({ revision: 7 });
    copy.close();
    const upgraded = new Database(file, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(latest);
    upgraded.close();
  });

  it('refuses a database written by a newer release (rolling back needs the backup)', () => {
    const file = join(dir, 'nexus.db');
    const db = openDb(file);
    db.pragma(`user_version = ${(db.pragma('user_version', { simple: true }) as number) + 1}`);
    db.close();
    expect(() => openDb(file)).toThrow(/数据库版本/);
  });
});
