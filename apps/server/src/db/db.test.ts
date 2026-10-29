import { mkdtempSync, rmSync } from 'node:fs';
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

  it('refuses a database written by a newer release (rolling back needs the backup)', () => {
    const file = join(dir, 'nexus.db');
    const db = openDb(file);
    db.pragma(`user_version = ${(db.pragma('user_version', { simple: true }) as number) + 1}`);
    db.close();
    expect(() => openDb(file)).toThrow(/数据库版本/);
  });
});
