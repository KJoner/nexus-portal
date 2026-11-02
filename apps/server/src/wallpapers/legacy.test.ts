import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepo } from '../config/repo';
import { openDb, type DB } from '../db';
import { cleanLegacyDaily } from './legacy';
import { WallpaperStore } from './store';

let dir: string;
let dbFile: string;
let db: DB;
let repo: ConfigRepo;
let store: WallpaperStore;
let jpeg: Buffer;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#d8d0c0' } }).jpeg().toBuffer();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-legacy-'));
  dbFile = join(dir, 'nexus.db');
  db = openDb(dbFile);
  repo = new ConfigRepo(db);
  store = new WallpaperStore(db, join(dir, 'wallpapers'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const daily = (ref: string) => store.add(jpeg, `每日一图 · ${ref}`, { source: 'daily', ref });
const look = () => repo.snapshot().config.settings.look;
const setLook = (patch: Record<string, unknown>) => repo.apply(`t-${Math.random()}`, 'test', [{ type: 'settings.patch', section: 'look', patch }]);
const potd = () => ({ rotation: { ...look().rotation, mode: 'potd' } });
const clean = (now?: Date) => cleanLegacyDaily({ db, dbFile, repo, store, now });
const ids = () => store.list().map((w) => w.id);
const backups = () => readdirSync(join(dir, 'backups'));

describe('清理历史每日一图', () => {
  it('removes generated pictures and nothing else', async () => {
    const generated = [await daily('2026-10-30'), await daily('2026-10-31'), await daily('2026-11-01')];
    const upload = await store.add(jpeg, '我的照片.jpg');
    const gallery = await store.add(jpeg, '沙丘', { source: 'gallery', ref: 'dunes' });
    const remote = store.addRemote('https://images.unsplash.com/x', 'x', { width: 10, height: 10 }, '#112233', { source: 'unsplash', ref: 'x' });
    const before = repo.snapshot().revision;

    expect(await clean()).toMatchObject({ removed: 3, kept: 0 });

    expect(ids()).toEqual([upload.id, gallery.id, remote.id]);
    expect(store.filePath(upload.id, '1280.jpg')).not.toBeNull();
    expect(existsSync(store.filePath(gallery.id, '1280.jpg')!)).toBe(true);
    for (const w of generated) expect(existsSync(join(dir, 'wallpapers', w.id))).toBe(false);
    // Other devices fetch the shorter list.
    expect(repo.snapshot().revision).toBe(before + 1);
  });

  it('never touches something that only looks like one', async () => {
    const named = await store.add(jpeg, '每日一图 · 10月29日.jpg');
    const odd = await store.add(jpeg, 'x', { source: 'daily', ref: 'not-a-date' });
    expect(await clean()).toEqual({ removed: 0, kept: 0, folder: null });
    expect(ids()).toEqual([named.id, odd.id]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('keeps favorites and the fixed wallpaper in use, as the user\'s own', async () => {
    const favorite = await daily('2026-10-29');
    const fixed = await daily('2026-10-30');
    const other = await daily('2026-10-31');
    setLook({ favorites: [favorite.id], wallpaper: fixed.id });
    expect(await clean()).toMatchObject({ removed: 1, kept: 2 });
    expect(ids()).toEqual([favorite.id, fixed.id]);
    expect(store.get(other.id)).toBeNull();
    expect(look().wallpaper).toBe(fixed.id);
    expect(look().favorites).toEqual([favorite.id]);
    expect(store.list().map((w) => w.source)).toEqual(['saved', 'saved']);
    expect(existsSync(store.filePath(fixed.id, '1280.jpg')!)).toBe(true);
  });

  it('with 每日一图 on, the old pin is released: it is not what the home page shows', async () => {
    const pinned = await daily('2026-10-29');
    const today = await daily('2026-11-02');
    setLook({ wallpaper: pinned.id, blocked: [today.id, 'ember'], ...potd() });
    expect(await clean()).toMatchObject({ removed: 2, kept: 0 });
    expect(look().wallpaper).toBe('fallingwater');
    expect(look().rotation.mode).toBe('potd');
    expect(look().blocked).toEqual(['ember']);
    expect(ids()).toEqual([]);
  });

  it('with 每日一图 on, a favorite stays even when it is the old pin', async () => {
    const pinned = await daily('2026-10-29');
    setLook({ wallpaper: pinned.id, favorites: [pinned.id], ...potd() });
    expect(await clean()).toMatchObject({ removed: 0, kept: 1 });
    expect(look().wallpaper).toBe(pinned.id);
    expect(ids()).toEqual([pinned.id]);
  });

  it('nothing is lost yet: the database is backed up and the files wait in a folder', async () => {
    const w = await daily('2026-10-30');
    const upload = await store.add(jpeg, 'mine.jpg');
    const { folder } = await clean();
    const names = backups();
    expect(names.filter((n) => /^nexus-v\d+-.+\.db$/.test(n))).toHaveLength(1);

    const copy = openDb(join(dir, 'backups', names.find((n) => n.endsWith('.db'))!));
    expect((copy.prepare('select id from wallpapers order by created_at').all() as { id: string }[]).map((r) => r.id)).toEqual([w.id, upload.id]);
    copy.close();
    expect(readdirSync(join(folder!, w.id)).sort()).toEqual(['1280.avif', '1280.jpg', '1280.webp']);
    expect(JSON.parse(readFileSync(join(folder!, 'manifest.json'), 'utf8'))).toMatchObject([{ id: w.id, source: 'daily', ref: '2026-10-30' }]);
  });

  it('runs at every start and does nothing once it is done', async () => {
    await daily('2026-10-30');
    await clean();
    const { revision } = repo.snapshot();
    const entries = backups();
    expect(await clean()).toEqual({ removed: 0, kept: 0, folder: null });
    expect(repo.snapshot().revision).toBe(revision);
    expect(backups()).toEqual(entries);
  });

  it('a kept picture is not looked at again, even after it stops being a favorite', async () => {
    const w = await daily('2026-10-30');
    setLook({ favorites: [w.id] });
    await clean();
    setLook({ favorites: [] });
    await clean();
    expect(ids()).toEqual([w.id]);
  });

  it('a row whose files are already gone is still removed', async () => {
    const w = await daily('2026-10-30');
    rmSync(join(dir, 'wallpapers', w.id), { recursive: true });
    expect(await clean()).toMatchObject({ removed: 1 });
    expect(ids()).toEqual([]);
  });

  it('waiting folders are deleted after 30 days, other backups are not', async () => {
    mkdirSync(join(dir, 'backups', 'legacy-daily-old'), { recursive: true });
    mkdirSync(join(dir, 'backups', 'legacy-daily-new'));
    mkdirSync(join(dir, 'backups', 'other'));
    const now = new Date();
    const old = new Date(now.getTime() - 31 * 86_400_000);
    utimesSync(join(dir, 'backups', 'legacy-daily-old'), old, old);
    utimesSync(join(dir, 'backups', 'other'), old, old);
    await clean(now);
    expect(backups().sort()).toEqual(['legacy-daily-new', 'other']);
  });
});
