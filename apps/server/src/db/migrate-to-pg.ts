import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IconStore } from '../icons/store';
import { LEGACY_ADMIN_ID, migratePg, openDb } from '.';
import type { Database } from './sql';

/**
 * 单用户 SQLite → 多账号 PostgreSQL (《A-迁移与恢复方案》M4).
 *
 * The source database is never written: a consistent copy (`VACUUM INTO`) is upgraded to the
 * account schema (v7, everything owned by the legacy administrator) and copied row by row into an
 * empty PostgreSQL database in one transaction. The run verifies itself — row counts per table,
 * a hash of every configuration document, presence of every wallpaper and icon file — and records
 * the source fingerprint, so running it again is a no-op and a different source is refused.
 *
 * Sessions and in-flight sign-ins are not copied (everyone signs in again after the move).
 */

/** Tables copied as they are, in an order that satisfies foreign keys. */
const TABLES = ['users', 'meta', 'user_config', 'op_log', 'auth', 'wallpapers', 'icons', 'health_status', 'integrations', 'devices', 'invites', 'mail_suppression'] as const;
type Table = (typeof TABLES)[number];

export interface MigrationReport {
  dryRun: boolean;
  alreadyMigrated: boolean;
  source: { file: string; userVersion: number; fingerprint: string };
  tables: Partial<Record<Table, { source: number; target: number | null }>>;
  configs: { ownerId: string; revision: number; sha256: string; matches: boolean | null }[];
  files: { wallpapers: { checked: number; missing: string[] }; icons: { checked: number; missing: string[] } };
  ok: boolean;
  problems: string[];
}

export class MigrationRefused extends Error {}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function migrateSqliteToPg(opts: { sqliteFile: string; target: Database; dataDir: string; dryRun?: boolean }): Promise<MigrationReport> {
  if (opts.target.dialect !== 'pg') throw new MigrationRefused('目标必须是 PostgreSQL');
  if (!existsSync(opts.sqliteFile)) throw new MigrationRefused(`找不到源数据库：${opts.sqliteFile}`);
  const work = mkdtempSync(join(tmpdir(), 'nexus-migrate-'));
  try {
    // 1. A consistent copy of a possibly live database; the original stays untouched.
    const copyFile = join(work, 'source.db');
    const src = new Sqlite(opts.sqliteFile, { readonly: true, fileMustExist: true });
    const userVersion = src.pragma('user_version', { simple: true }) as number;
    src.exec(`vacuum into '${copyFile.replace(/'/g, "''")}'`);
    src.close();
    // 2. Upgrade the copy to the account schema; pre-v0.4 icon files become the administrator's rows.
    const copy = openDb(copyFile);
    await new IconStore(copy, join(opts.dataDir, 'icons')).adoptUnowned(LEGACY_ADMIN_ID);
    const rows = {} as Record<Table, Record<string, unknown>[]>;
    for (const t of TABLES) rows[t] = await copy.all<Record<string, unknown>>(`select * from ${t}`);
    await copy.close();

    const fingerprint = sha256(JSON.stringify(TABLES.map((t) => [t, rows[t].length])) + JSON.stringify(rows.user_config) + JSON.stringify(rows.wallpapers.map((w) => w.id)));
    const report: MigrationReport = {
      dryRun: !!opts.dryRun,
      alreadyMigrated: false,
      source: { file: opts.sqliteFile, userVersion, fingerprint },
      tables: Object.fromEntries(TABLES.map((t) => [t, { source: rows[t].length, target: null }])),
      configs: rows.user_config.map((c) => ({ ownerId: String(c.owner_id), revision: Number(c.revision), sha256: sha256(String(c.data)), matches: null })),
      files: checkFiles(opts.dataDir, rows.wallpapers, rows.icons),
      ok: false,
      problems: [],
    };
    for (const id of report.files.wallpapers.missing) report.problems.push(`壁纸文件缺失：${id}`);
    for (const id of report.files.icons.missing) report.problems.push(`图标文件缺失：${id}`);
    if (opts.dryRun) {
      report.ok = report.problems.length === 0;
      return report;
    }

    // 3. Target: migrated, and either this very source already (no-op) or empty.
    const target = opts.target;
    await migratePg(target);
    const done = await target.get<{ fingerprint: string }>('select fingerprint from migration_source where id = 1');
    if (done) {
      if (done.fingerprint !== fingerprint) throw new MigrationRefused('目标库已经从另一份数据迁移过，拒绝覆盖');
      report.alreadyMigrated = true;
    } else {
      const busy = await target.get<{ n: number }>("select (select count(*) from users where id <> 'legacy-admin') + (select count(*) from user_config) + (select count(*) from wallpapers) + (select count(*) from devices) as n");
      if (Number(busy?.n ?? 0) > 0) throw new MigrationRefused('目标库不是空的（已有账号或数据），拒绝迁移；请换一个新建的数据库');
      // 4. Everything in one transaction: either the whole copy lands, or nothing does.
      await target.tx(async () => {
        await target.run("delete from users where id = 'legacy-admin'");
        await target.run("delete from meta where key = 'config_format'");
        for (const t of TABLES) {
          for (const row of rows[t]) {
            const cols = Object.keys(row);
            await target.run(`insert into ${t} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] as never));
          }
        }
        await target.run('insert into migration_source (id, fingerprint, migrated_at, report) values (1, ?, ?, ?)', [fingerprint, Date.now(), JSON.stringify({ source: report.source, tables: report.tables })]);
      });
    }

    // 5. Verify what is actually in the target now.
    for (const t of TABLES) {
      const n = Number((await target.get<{ n: number }>(`select count(*) as n from ${t}`))?.n ?? 0);
      report.tables[t] = { source: rows[t].length, target: n };
      if (n !== rows[t].length) report.problems.push(`${t}：源 ${rows[t].length} 行，目标 ${n} 行`);
    }
    for (const c of report.configs) {
      const row = await target.get<{ data: string; revision: number }>('select data, revision from user_config where owner_id = ?', [c.ownerId]);
      c.matches = !!row && sha256(row.data) === c.sha256 && Number(row.revision) === c.revision;
      if (!c.matches) report.problems.push(`配置不一致：${c.ownerId}`);
    }
    const admin = await target.get<{ is_admin: number }>("select is_admin from users where id = 'legacy-admin'");
    if (!admin || Number(admin.is_admin) !== 1) report.problems.push('旧管理员账号缺失或不是管理员');
    const elevated = await target.get<{ n: number }>("select count(*) as n from devices where scopes <> 'config:read' and owner_id = 'legacy-admin'");
    if (Number(elevated?.n ?? 0) > 0 && userVersion < 7) report.problems.push('旧设备凭据被提升了权限');
    report.ok = report.problems.length === 0;
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function checkFiles(dataDir: string, wallpapers: Record<string, unknown>[], icons: Record<string, unknown>[]): MigrationReport['files'] {
  const wMissing: string[] = [];
  for (const w of wallpapers) {
    const widths = JSON.parse(String(w.widths)) as number[];
    // Hotlinked photos (Unsplash) have no files by design.
    if (!widths.length) continue;
    if (!widths.every((x) => existsSync(join(dataDir, 'wallpapers', String(w.id), `${x}.jpg`)))) wMissing.push(String(w.id));
  }
  const iMissing = icons.filter((i) => !existsSync(join(dataDir, 'icons', `${String(i.id)}.png`))).map((i) => String(i.id));
  return { wallpapers: { checked: wallpapers.length, missing: wMissing }, icons: { checked: icons.length, missing: iMissing } };
}
