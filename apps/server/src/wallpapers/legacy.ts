import type { UploadedWallpaper } from '@nexus/shared';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConfigRepo } from '../config/repo';
import { backupDb, type DB } from '../db';
import type { WallpaperStore } from './store';

const FOLDER = 'legacy-daily-';
const KEEP_MS = 30 * 86_400_000;

/** Exactly what 0.2 – 0.3.1 wrote for 每日一图; anything else in the library is left alone. */
const isLegacyDaily = (w: UploadedWallpaper) => w.source === 'daily' && /^dy-[a-z0-9]{12}$/.test(w.id) && /^\d{4}-\d{2}-\d{2}$/.test(w.ref);

async function purgeExpired(backups: string, now: Date) {
  for (const name of await readdir(backups).catch(() => [] as string[])) {
    if (!name.startsWith(FOLDER)) continue;
    const path = join(backups, name);
    if (now.getTime() - (await stat(path)).mtimeMs > KEEP_MS) await rm(path, { recursive: true, force: true });
  }
}

export interface LegacyCleanup {
  removed: number;
  kept: number;
  /** Where the removed pictures wait until they expire. */
  folder: string | null;
}

/**
 * Until 0.3.1 every 每日一图 became a library row, so the library filled up with dated pictures.
 * Rows the user made their own stay, as ordinary wallpapers (source `saved`, so they are never
 * looked at again): favorites, and the fixed wallpaper unless 每日一图 is on. With it on, that field
 * is not what the home page shows but the pin left behind by the old mode, so it goes back to the
 * default picture. The rest leaves the library, which is reversible for a while: the database is
 * backed up first, and the files are moved to `<data>/backups/legacy-daily-<time>/` and only
 * deleted 30 days later. Runs at every start; once nothing matches, it does nothing.
 */
export async function cleanLegacyDaily({ db, dbFile, repo, store, now = new Date() }: { db: DB; dbFile: string; repo: ConfigRepo; store: WallpaperStore; now?: Date }): Promise<LegacyCleanup> {
  const backups = join(dirname(dbFile), 'backups');
  await purgeExpired(backups, now);
  const legacy = store.list().filter(isLegacyDaily);
  if (!legacy.length) return { removed: 0, kept: 0, folder: null };

  backupDb(db, dbFile, db.pragma('user_version', { simple: true }) as number);
  const look = repo.snapshot().config.settings.look;
  const owned = new Set(look.favorites);
  if (look.rotation.mode !== 'potd') owned.add(look.wallpaper);
  const doomed = legacy.filter((w) => !owned.has(w.id));
  for (const w of legacy) if (owned.has(w.id)) store.markSaved(w.id);
  if (!doomed.length) return { removed: 0, kept: legacy.length, folder: null };

  const gone = new Set(doomed.map((w) => w.id));
  const patch: Record<string, unknown> = {};
  if (gone.has(look.wallpaper)) patch.wallpaper = 'fallingwater';
  if (look.blocked.some((id) => gone.has(id))) patch.blocked = look.blocked.filter((id) => !gone.has(id));

  const folder = join(backups, `${FOLDER}${now.toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(doomed, null, 2));
  // The configuration first: an interrupted run must not leave it pointing at a removed picture.
  if (Object.keys(patch).length) repo.apply(`legacy-daily-${now.getTime()}`, 'server', [{ type: 'settings.patch', section: 'look', patch }]);
  for (const w of doomed) await store.moveOut(w.id, folder);
  repo.touch();
  return { removed: doomed.length, kept: legacy.length - doomed.length, folder };
}
