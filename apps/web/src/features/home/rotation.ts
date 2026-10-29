import { wallpaperFile, type GalleryItem, type Settings, type WallpaperSourcesResponse } from '@nexus/shared';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { dispatch, useConfigStore, wallpaperSources } from '../../data/config-store';
import { host } from '../../lib/host';
import { storage } from '../../lib/storage';
import { remoteSrc, useWallpapers, wallpaperList, type WallpaperEntry } from './Wallpaper';

type Rotation = Settings['look']['rotation'];

/** One random pick per page load for 每次打开 (navigating inside the app keeps it). */
const LOAD_SEED = Math.floor(Math.random() * 2 ** 31);
const OFFSET_KEY = 'nexus.wallpaper.offset';
const DAILY_KEY = 'nexus.wallpaper.daily';
const LAST_KEY = 'nexus.wallpaper.last';

export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** FNV-1a: stable across devices, so a timed rotation shows the same picture everywhere. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The current rotation period, and when the next one starts (ms from now). */
export function period(r: Rotation, now: Date): { key: string; next: number } | null {
  const t = now.getTime();
  switch (r.mode) {
    case 'open':
      return { key: `open:${LOAD_SEED}`, next: Infinity };
    case 'hourly':
      return { key: `h:${Math.floor(t / 3_600_000)}`, next: 3_600_000 - (t % 3_600_000) };
    case 'daily': {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      return { key: `d:${localDay(now)}`, next: midnight - t };
    }
    case 'interval': {
      const ms = r.minutes * 60_000;
      return { key: `i${r.minutes}:${Math.floor(t / ms)}`, next: ms - (t % ms) };
    }
    default:
      return null;
  }
}

export type Candidate = { kind: 'wallpaper'; entry: WallpaperEntry } | { kind: 'gallery'; item: GalleryItem };

/** What a timed rotation may pick from; 不喜欢 entries never come up. */
export function candidates(look: Settings['look'], list: readonly WallpaperEntry[], gallery: readonly GalleryItem[] | null): Candidate[] {
  const blocked = new Set(look.blocked);
  const library = list.filter((w) => !blocked.has(w.id));
  if (look.rotation.pool === 'gallery') {
    const cats = new Set(look.rotation.categories);
    const items = (gallery ?? []).filter((g) => cats.has(g.category) && !(g.wallpaperId && blocked.has(g.wallpaperId)));
    if (items.length) return items.map((item) => (item.wallpaperId && list.some((w) => w.id === item.wallpaperId) ? { kind: 'wallpaper', entry: list.find((w) => w.id === item.wallpaperId)! } : { kind: 'gallery', item }));
  }
  if (look.rotation.pool === 'favorites') {
    const fav = new Set(look.favorites);
    const picked = library.filter((w) => fav.has(w.id));
    if (picked.length) return picked.map((entry) => ({ kind: 'wallpaper', entry }));
  }
  return library.map((entry) => ({ kind: 'wallpaper', entry }));
}

export function pick(list: readonly Candidate[], key: string, offset: number): Candidate | null {
  if (!list.length) return null;
  const i = (((hash(key) + offset) % list.length) + list.length) % list.length;
  return list[i]!;
}

/** Name of the picture on screen, for the search quick action (更换壁纸 · 当前…). */
export const useShownWallpaper = create<{ name: string }>(() => ({ name: '' }));

/** 精选图库 catalog, fetched once per session when a gallery rotation or the picker needs it. */
export const useSourcesStore = create<{ data: WallpaperSourcesResponse | null; loading: boolean; error: string | null; load(force?: boolean): Promise<void> }>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  async load(force = false) {
    if (get().loading || (get().data && !force)) return;
    set({ loading: true, error: null });
    try {
      set({ data: await wallpaperSources.list(), loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '无法读取图片来源' });
    }
  },
}));

/** Warms the browser (and Service Worker) cache for a picture shown later. */
export function preload(entry: WallpaperEntry) {
  const u = entry.uploaded;
  if (entry.kind !== 'photo' || typeof Image === 'undefined') return;
  if (u && !u.remote && host.prefetchWallpaper) return host.prefetchWallpaper(u);
  const want = window.innerWidth * (window.devicePixelRatio || 1);
  const img = new Image();
  if (u?.remote) img.src = remoteSrc(u.remote, [1280, 1920, 2560].find((w) => w >= want) ?? 2560);
  else if (u) img.src = wallpaperFile(u.id, u.widths.find((w) => w >= want) ?? u.widths.at(-1)!, 'avif');
  else img.src = entry.src;
}

const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));

export interface CurrentWallpaper {
  entry: WallpaperEntry;
  /** A timed rotation or 每日一图 is choosing the picture. */
  rotating: boolean;
  /** 换一张 / 上一张 work: always in the portal; read-only only while rotating (a local offset). */
  canStep: boolean;
  next(): void;
  prev(): void;
}

/**
 * The picture the home page shows. Rotation is computed, not stored: the period (hour, day, …) and
 * the pool decide, so devices agree without writing to the server. 上一张 / 下一张 shift a
 * per-device offset that resets with the next period.
 */
export function useCurrentWallpaper(): CurrentWallpaper {
  const look = useConfigStore((s) => s.snapshot.config.settings.look);
  const list = useWallpapers();
  const gallery = useSourcesStore((s) => s.data?.gallery ?? null);
  const loadSources = useSourcesStore((s) => s.load);
  const [now, setNow] = useState(() => new Date());
  const [offsetState, setOffsetState] = useState(() => storage.get<{ key: string; offset: number }>(OFFSET_KEY));
  const [daily, setDaily] = useState(() => storage.get<{ date: string; id: string }>(DAILY_KEY));
  const [lastId] = useState(() => storage.get<string>(LAST_KEY));
  const r = look.rotation;
  const p = period(r, now);
  const offset = p && offsetState?.key === p.key ? offsetState.offset : 0;

  // Re-evaluate when the period ends (and when the tab comes back after sleeping).
  useEffect(() => {
    if (!p || !Number.isFinite(p.next)) return;
    const t = setTimeout(() => setNow(new Date()), Math.min(p.next + 50, 2 ** 31 - 1));
    const onVisible = () => document.visibilityState === 'visible' && setNow(new Date());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [p?.key, p?.next]);

  useEffect(() => {
    if (r.mode !== 'off' && r.mode !== 'potd' && r.pool === 'gallery') void loadSources();
  }, [r.mode, r.pool, loadSources]);

  // 每日一图: one request per local day; the server keeps the picture. Read-only clients only
  // show what a portal client already fetched.
  const today = localDay(now);
  useEffect(() => {
    if (host.readOnly || r.mode !== 'potd' || (daily?.date === today && list.some((w) => w.id === daily.id))) return;
    let live = true;
    wallpaperSources.daily(today).then(
      (w) => {
        if (!live) return;
        const d = { date: today, id: w.id };
        storage.set(DAILY_KEY, d);
        setDaily(d);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.mode, today, daily?.id, list.length]);

  const pool = useMemo(() => (p ? candidates(look, list, gallery) : []), [p?.key, look, list, gallery]);
  const chosen = p ? pick(pool, p.key, offset) : null;
  const upcoming = p ? pick(pool, p.key, offset + 1) : null;

  // A gallery picture is downloaded by the server the first time it comes up.
  const missing = chosen?.kind === 'gallery' ? chosen.item.id : null;
  useEffect(() => {
    if (!missing || host.readOnly) return;
    void wallpaperSources.gallery(missing).then(() => useSourcesStore.getState().load(true), () => undefined);
  }, [missing]);

  // Prepare the next picture while idle, so 下一张 and the next period switch without a flash.
  useEffect(() => {
    if (!upcoming) return;
    const h = idle(() => {
      if (upcoming.kind === 'wallpaper') preload(upcoming.entry);
      else if (!host.readOnly) void wallpaperSources.gallery(upcoming.item.id).then(() => useSourcesStore.getState().load(true), () => undefined);
    });
    return () => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(h as number) : clearTimeout(h as ReturnType<typeof setTimeout>));
  }, [upcoming?.kind === 'wallpaper' ? upcoming.entry.id : upcoming?.item.id]);

  const fixed = list.find((w) => w.id === look.wallpaper) ?? list[0]!;
  const byId = (id: string | null | undefined) => (id ? list.find((w) => w.id === id) : undefined);
  let entry: WallpaperEntry;
  if (r.mode === 'potd') entry = (daily?.date === today && byId(daily.id)) || (host.readOnly && latestDaily(list, today)) || byId(lastId) || fixed;
  else if (chosen?.kind === 'wallpaper') entry = chosen.entry;
  // While a gallery picture downloads, keep what was on screen last time instead of flashing.
  else entry = byId(lastId) ?? fixed;

  useEffect(() => {
    storage.set(LAST_KEY, entry.id);
    useShownWallpaper.setState({ name: entry.name });
  }, [entry.id, entry.name]);

  const shift = (d: number) => {
    if (!p) return void stepFixed(d);
    const next = { key: p.key, offset: offset + d };
    storage.set(OFFSET_KEY, next);
    setOffsetState(next);
  };
  return { entry, rotating: !!p || r.mode === 'potd', canStep: !host.readOnly || !!p, next: () => shift(1), prev: () => shift(-1) };
}

/** The newest 每日一图 in the library up to `today` (library refs are local dates). */
function latestDaily(list: readonly WallpaperEntry[], today: string): WallpaperEntry | undefined {
  return list.filter((w) => w.uploaded?.source === 'daily' && w.uploaded.ref <= today).sort((a, b) => (a.uploaded!.ref < b.uploaded!.ref ? 1 : -1))[0];
}

/** 换一张 without rotation: steps `look.wallpaper` through the library (synced, undoable). */
export function stepFixed(d: number) {
  const s = useConfigStore.getState();
  const look = s.snapshot.config.settings.look;
  const blocked = new Set(look.blocked);
  const list = wallpaperList(s.wallpapers).filter((w) => !blocked.has(w.id) || w.id === look.wallpaper);
  const i = list.findIndex((w) => w.id === look.wallpaper);
  const next = list[(i + d + list.length) % list.length]!;
  dispatch({ type: 'settings.patch', section: 'look', patch: { wallpaper: next.id, focal: { desktop: next.focal ?? [50, 50], mobile: next.focal ?? [50, 50] } } });
  return next;
}
