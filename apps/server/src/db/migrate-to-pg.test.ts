import { defaultConfig } from '@nexus/shared';
import Sqlite from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepo } from '../config/repo';
import { Devices } from '../auth/devices';
import { LEGACY_ADMIN_ID, MIGRATIONS } from '.';
import { migrateSqliteToPg, MigrationRefused } from './migrate-to-pg';
import { PgliteDatabase } from './pglite';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-m4-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A real 0.3.x deployment: single user, a customised configuration, files on disk. */
function legacyDeployment(): { file: string; config: string } {
  const file = join(dir, 'nexus.db');
  const db = new Sqlite(file);
  for (const m of MIGRATIONS.slice(0, 6)) db.exec(m);
  db.pragma('user_version = 6');
  const cfg = defaultConfig();
  cfg.pins = ['notion', 'github'];
  cfg.settings.look.wallpaper = 'up-aaaaaaaaaaaa';
  const config = JSON.stringify(cfg);
  db.prepare("insert into config (id, revision, updated_at, data) values (1, 87, '2026-11-01T08:00:00.000Z', ?)").run(config);
  db.prepare("insert into op_log (revision, batch_id, client_id, ops, created_at) values (87, 'b87', 'phone', '[]', 'x')").run();
  db.prepare("insert into auth (id, password_hash, updated_at) values (1, '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', 'x')").run();
  db.prepare("insert into sessions (id_hash, created_at, expires_at, last_seen, user_agent) values ('s', 1, 9999999999999, 1, '')").run();
  db.prepare("insert into wallpapers (id, name, width, height, widths, placeholder, created_at, source, ref, credit, luma, focal, remote) values ('up-aaaaaaaaaaaa', '书房', 1920, 1080, '[1280,1920]', '', '2026-10-01T00:00:00.000Z', 'upload', '', '', 0.4, '', '')").run();
  db.prepare("insert into wallpapers (id, name, width, height, widths, placeholder, created_at, source, ref, credit, luma, focal, remote) values ('us-bbbbbbbbbbbb', '湖', 6000, 4000, '[]', '', '2026-10-02T00:00:00.000Z', 'unsplash', 'x', '', 0.5, '', 'https://images.unsplash.com/x')").run();
  db.prepare("insert into health_status (app_id, level, message, checked_at, fails, key, via) values ('litebox', 'ok', 'HTTP 200', 'x', 0, 'k', 'lan')").run();
  db.prepare("insert into integrations (id, base_url, token_enc, token_last4, updated_at) values ('linkwarden', 'http://links.home', 'sealed', 'abcd', 'x')").run();
  db.prepare("insert into devices (id, name, token_hash, created_at, user_agent) values ('d1', 'Chrome', 'hash-1', 1, '')").run();
  db.close();
  for (const w of [1280, 1920]) {
    mkdirSync(join(dir, 'wallpapers', 'up-aaaaaaaaaaaa'), { recursive: true });
    writeFileSync(join(dir, 'wallpapers', 'up-aaaaaaaaaaaa', `${w}.jpg`), 'jpg');
  }
  mkdirSync(join(dir, 'icons'), { recursive: true });
  writeFileSync(join(dir, 'icons', 'ic-cccccccccccc.png'), 'png');
  return { file, config };
}

// Each case builds a SQLite file and one or more PGlite databases: seconds, not milliseconds — on a
// loaded CI runner the default 5 s is too tight (seen locally while e2e ran alongside).
describe('SQLite → PostgreSQL (M4)', { timeout: 30_000 }, () => {
  it('a dry run reports what would move and touches nothing', async () => {
    const { file } = legacyDeployment();
    const target = await PgliteDatabase.create();
    const r = await migrateSqliteToPg({ sqliteFile: file, target, dataDir: dir, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, ok: true, source: { userVersion: 6 } });
    expect(r.tables.user_config).toEqual({ source: 1, target: null });
    expect(r.tables.icons).toEqual({ source: 1, target: null });
    // Nothing was created in the target.
    expect(await target.get("select count(*) as n from information_schema.tables where table_name = 'users'")).toEqual({ n: 0 });
    // The source is still a 0.3 database.
    const src = new Sqlite(file, { readonly: true });
    expect(src.pragma('user_version', { simple: true })).toBe(6);
    src.close();
    await target.close();
  });

  it('moves everything to the administrator, verifies itself, and a second run is a no-op', async () => {
    const { file, config } = legacyDeployment();
    const target = await PgliteDatabase.create();
    const r = await migrateSqliteToPg({ sqliteFile: file, target, dataDir: dir });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    for (const [t, n] of Object.entries(r.tables)) expect(n?.target, t).toBe(n?.source);
    expect(r.configs).toEqual([expect.objectContaining({ ownerId: LEGACY_ADMIN_ID, revision: 87, matches: true })]);
    expect(r.files).toEqual({ wallpapers: { checked: 2, missing: [] }, icons: { checked: 1, missing: [] } });

    // What the migrated database serves is exactly what the administrator had.
    const repo = new ConfigRepo(target);
    const snap = await repo.snapshot(LEGACY_ADMIN_ID);
    expect(snap.revision).toBe(87);
    // The copy is read once before it is moved (M5 and the UI v2 tree migration run on it): the pins
    // are the old ones plus the services the home page showed, after them.
    const source = JSON.parse(config) as { pins: string[]; apps: { id: string; kind: string; hidden: boolean; showInServices: boolean }[]; settings: { home: { showServices: boolean } } };
    const services = source.settings.home.showServices ? source.apps.filter((a) => a.kind === 'service' && !a.hidden && a.showInServices).map((a) => a.id) : [];
    expect(JSON.stringify(snap.config.pins)).toBe(JSON.stringify([...source.pins, ...services.filter((id) => !source.pins.includes(id))]));
    expect(await target.get('select owner_id, scopes from devices')).toEqual({ owner_id: LEGACY_ADMIN_ID, scopes: 'config:read' });
    expect(await target.get('select owner_id, base_url from integrations')).toEqual({ owner_id: LEGACY_ADMIN_ID, base_url: 'http://links.home' });
    expect(await target.get('select count(*) as n from sessions')).toEqual({ n: 0 });
    expect(await new Devices(target).list(LEGACY_ADMIN_ID)).toHaveLength(1);

    const again = await migrateSqliteToPg({ sqliteFile: file, target, dataDir: dir });
    expect(again).toMatchObject({ ok: true, alreadyMigrated: true });
    expect(await target.get('select count(*) as n from wallpapers')).toEqual({ n: 2 });
    await target.close();
  });

  it('refuses a target that holds other data or came from another source', async () => {
    const { file } = legacyDeployment();
    const busy = await PgliteDatabase.create();
    const { migratePg } = await import('.');
    await migratePg(busy);
    await busy.run("insert into users (id, created_via, created_at) values ('u-x', 'oidc', 1)");
    await expect(migrateSqliteToPg({ sqliteFile: file, target: busy, dataDir: dir })).rejects.toBeInstanceOf(MigrationRefused);
    await busy.close();

    const target = await PgliteDatabase.create();
    await migrateSqliteToPg({ sqliteFile: file, target, dataDir: dir });
    // A different source (the administrator changed something since) is not merged in silently.
    const db = new Sqlite(file);
    db.prepare("update config set revision = 88 where id = 1").run();
    db.close();
    await expect(migrateSqliteToPg({ sqliteFile: file, target, dataDir: dir })).rejects.toThrow(/另一份数据/);
    await target.close();
  });

  it('reports missing files instead of pretending all is well', async () => {
    const { file } = legacyDeployment();
    rmSync(join(dir, 'wallpapers', 'up-aaaaaaaaaaaa', '1920.jpg'));
    const target = await PgliteDatabase.create();
    const r = await migrateSqliteToPg({ sqliteFile: file, target, dataDir: dir, dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['壁纸文件缺失：up-aaaaaaaaaaaa']);
    await target.close();
  });
});
