import Sqlite from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_ID, migratePg, MIGRATIONS, openDb, PG_MIGRATIONS } from '.';
import { Users } from '../users/users';
import { PgliteDatabase } from './pglite';
import { DIALECTS, testDb } from './testing';

const TABLES = ['users', 'user_config', 'op_log', 'auth', 'sessions', 'wallpapers', 'icons', 'health_status', 'integrations', 'devices', 'login_intents', 'invites', 'mail_outbox', 'mail_suppression', 'meta'];

describe.each(DIALECTS)('schema (%s)', (dialect) => {
  it('has every table, and the legacy administrator exists from the start', async () => {
    const db = await testDb(dialect);
    for (const t of TABLES) expect(await db.get(`select count(*) as n from ${t}`), t).toBeTruthy();
    expect(await db.get('select id, is_admin, created_via from users')).toEqual({ id: LEGACY_ADMIN_ID, is_admin: 1, created_via: 'legacy' });
    await db.close();
  });

  it('keeps one identity per (issuer, subject) and per-account batch ids', async () => {
    const db = await testDb(dialect);
    const add = (id: string, sub: string) => db.run('insert into users (id, issuer, subject, created_via, created_at) values (?, ?, ?, ?, ?)', [id, 'https://id.example', sub, 'oidc', Date.now()]);
    await add('u-a', 'sub-a');
    await expect(add('u-b', 'sub-a')).rejects.toThrow();
    await add('u-b', 'sub-b');
    const log = (owner: string, rev: number) => db.run('insert into op_log (owner_id, revision, batch_id, client_id, ops, created_at) values (?, ?, ?, ?, ?, ?)', [owner, rev, 'same-batch', 'c', '[]', 'x']);
    await log('u-a', 1);
    await log('u-b', 1); // the same batch id belongs to another account: allowed
    await expect(log('u-a', 2)).rejects.toThrow();
    await db.close();
  });

  it('rolls a failed transaction back and joins nested calls into it', async () => {
    const db = await testDb(dialect);
    await expect(
      db.tx(async () => {
        await db.run('insert into meta (key, value) values (?, ?)', ['a', '1']);
        // Not the same handle: a repository called from inside the transaction.
        await db.tx(async () => db.run('insert into meta (key, value) values (?, ?)', ['b', '2']));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.get("select count(*) as n from meta where key in ('a','b')")).toEqual({ n: 0 });
    await db.tx(async () => db.run('insert into meta (key, value) values (?, ?)', ['a', '1']));
    expect(await db.get("select value from meta where key = 'a'")).toEqual({ value: '1' });
    await db.close();
  });
});

describe('SQLite v6 → v7 (single user → accounts)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-v7-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives every existing row to the legacy administrator and loses nothing', async () => {
    const file = join(dir, 'nexus.db');
    const v6 = new Sqlite(file);
    for (const m of MIGRATIONS.slice(0, 6)) v6.exec(m);
    v6.pragma('user_version = 6');
    v6.prepare("insert into config (id, revision, updated_at, data) values (1, 41, '2026-11-01T00:00:00.000Z', '{\"pins\":[\"github\"]}')").run();
    v6.prepare("insert into op_log (revision, batch_id, client_id, ops, created_at) values (41, 'b41', 'c', '[]', 'x')").run();
    v6.prepare("insert into auth (id, password_hash, updated_at) values (1, '$argon2id$x', 'x')").run();
    v6.prepare("insert into sessions (id_hash, created_at, expires_at, last_seen, user_agent) values ('s1', 1, 9999999999999, 1, 'ua')").run();
    v6.prepare("insert into wallpapers (id, name, width, height, widths, placeholder, created_at, source, ref) values ('up-aaaaaaaaaaaa', '我的', 1, 1, '[1]', '', 'x', 'upload', '')").run();
    v6.prepare("insert into health_status (app_id, level, message, checked_at, fails, key, via) values ('litebox', 'ok', 'HTTP 200', 'x', 0, 'k', 'lan')").run();
    v6.prepare("insert into integrations (id, base_url, token_enc, token_last4, updated_at) values ('linkwarden', 'http://links.home', 'enc', 'abcd', 'x')").run();
    v6.prepare("insert into devices (id, name, token_hash, created_at, user_agent) values ('d1', 'Chrome', 'h1', 1, 'ua')").run();
    v6.close();

    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(await db.get('select owner_id, revision, data from user_config')).toEqual({ owner_id: LEGACY_ADMIN_ID, revision: 41, data: '{"pins":["github"]}' });
    expect(await db.get('select owner_id, batch_id from op_log')).toEqual({ owner_id: LEGACY_ADMIN_ID, batch_id: 'b41' });
    expect(await db.get('select user_id, kind from sessions')).toEqual({ user_id: LEGACY_ADMIN_ID, kind: 'password' });
    expect(await db.get('select owner_id, name from wallpapers')).toEqual({ owner_id: LEGACY_ADMIN_ID, name: '我的' });
    expect(await db.get('select owner_id, app_id from health_status')).toEqual({ owner_id: LEGACY_ADMIN_ID, app_id: 'litebox' });
    expect(await db.get('select owner_id, base_url from integrations')).toEqual({ owner_id: LEGACY_ADMIN_ID, base_url: 'http://links.home' });
    // Old extension tokens stay what they were: read-only.
    expect(await db.get('select owner_id, scopes from devices')).toEqual({ owner_id: LEGACY_ADMIN_ID, scopes: 'config:read' });
    expect(await db.get('select password_hash from auth')).toEqual({ password_hash: '$argon2id$x' });
    expect(await db.get("select value from meta where key = 'config_format'")).toEqual({ value: '3' });
    await db.close();
  });
});

/**
 * UI v2 I1: the login-name snapshot is one added column (SQLite v11, PostgreSQL v5). Existing
 * accounts keep every row and their identity; the column starts empty and the next sign-in fills it.
 */
describe('login name column (SQLite v10 → v11, PostgreSQL v4 → v5)', () => {
  const ISSUER = 'https://id.example.test/realms/accounts';
  const existing = "insert into users (id, issuer, subject, email, email_verified, display_name, is_admin, disabled, created_via, created_at, last_login_at) values ('u-old', 'https://id.example.test/realms/accounts', 'sub-old', 'old@example.test', 1, '旧 姓名', 0, 0, 'oidc', 1, 2)";
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-v11-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is SQLite v11 and PostgreSQL v5 (append-only: later versions come after it)', () => {
    expect(MIGRATIONS[10]).toMatch(/alter table users add column username text not null default ''/);
    expect(PG_MIGRATIONS[4]).toMatch(/alter table users add column username text not null default ''/);
  });

  it('SQLite: an account of v10 keeps its identity and profile, starts without a login name, and gets it at the next sign-in', async () => {
    const file = join(dir, 'nexus.db');
    const v10 = new Sqlite(file);
    for (const m of MIGRATIONS.slice(0, 10)) v10.exec(m);
    v10.pragma('user_version = 10');
    v10.exec(existing);
    v10.close();

    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(await db.get("select id, issuer, subject, email, display_name, username from users where id = 'u-old'")).toEqual({ id: 'u-old', issuer: ISSUER, subject: 'sub-old', email: 'old@example.test', display_name: '旧 姓名', username: '' });
    expect(await db.get("select username from users where id = ?", [LEGACY_ADMIN_ID])).toEqual({ username: '' });
    const r = await new Users(db).signIn({ issuer: ISSUER, subject: 'sub-old', email: 'old@example.test', username: 'old@example.test' }, 'closed');
    expect(r).toMatchObject({ ok: true, created: false, user: { id: 'u-old', displayName: '旧 姓名', username: 'old@example.test' } });
    await db.close();
  });

  it('PostgreSQL: the same, from a database at v4', async () => {
    const db = await PgliteDatabase.create();
    await db.exec('create table schema_migrations (version integer primary key, applied_at bigint not null)');
    for (const [i, m] of PG_MIGRATIONS.slice(0, 4).entries()) {
      await db.exec(m);
      await db.run('insert into schema_migrations (version, applied_at) values (?, ?)', [i + 1, 1]);
    }
    await db.exec(existing);
    expect(await migratePg(db)).toBe(PG_MIGRATIONS.length);
    expect(await db.get('select max(version) as v from schema_migrations')).toEqual({ v: PG_MIGRATIONS.length });
    expect(await db.get("select id, issuer, subject, email, display_name, username from users where id = 'u-old'")).toEqual({ id: 'u-old', issuer: ISSUER, subject: 'sub-old', email: 'old@example.test', display_name: '旧 姓名', username: '' });
    const r = await new Users(db).signIn({ issuer: ISSUER, subject: 'sub-old', username: 'old_login' }, 'closed');
    expect(r).toMatchObject({ ok: true, created: false, user: { id: 'u-old', username: 'old_login' } });
    await db.close();
  });

  it('PostgreSQL: a database written by a newer release is refused, as SQLite is (rolling back needs the backup)', async () => {
    const db = await PgliteDatabase.create();
    await migratePg(db);
    await db.run('insert into schema_migrations (version, applied_at) values (?, ?)', [PG_MIGRATIONS.length + 1, 1]);
    await expect(migratePg(db)).rejects.toThrow(`数据库版本（${PG_MIGRATIONS.length + 1}）比当前程序（${PG_MIGRATIONS.length}）新`);
    await db.close();
  });
});
