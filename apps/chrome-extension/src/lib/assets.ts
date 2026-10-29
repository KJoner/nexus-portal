import { wallpaperFile, type UploadedWallpaper } from '@nexus/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, deviceApi, type Fetch } from './api';
import type { ServerRecord } from './storage';

/**
 * Icons and wallpapers from the portal's /api, kept in IndexedDB and shown through blob: URLs.
 * Metadata and image data live in separate stores, so recording a use never rewrites an image.
 */
export interface AssetMeta {
  path: string;
  kind: 'icon' | 'wallpaper';
  size: number;
  fetchedAt: number;
  usedAt: number;
  /** No image to show: the server has none (404) or the icon source failed (5xx). */
  missing: boolean;
  /** When to ask again — a day after a 404, a quarter of an hour after a failure — not on every new tab. */
  retryAt?: number;
}

const DAY = 86_400_000;
export const LIMITS = {
  icons: 400,
  wallpapers: 6,
  bytes: 80 * 1024 * 1024,
  /** Unused this long → removed. */
  idle: 60 * DAY,
  /** Brand icons and favicons can change upstream; uploads and wallpapers never do (new id). */
  refresh: 7 * DAY,
  missingRetry: DAY,
  failedRetry: 15 * 60_000,
};

const ALLOWED = /^\/api\/(icons\/[^/]+|icon-cache\/(di|si|fav)\/[^/]+|wallpapers\/[^/]+\/[^/]+)$/;
const kindOf = (path: string): AssetMeta['kind'] => (path.startsWith('/api/wallpapers/') ? 'wallpaper' : 'icon');
const refreshable = (path: string) => path.startsWith('/api/icon-cache/');

/** Least recently used first, until every limit holds; idle entries go regardless. */
export function planEviction(metas: readonly AssetMeta[], now: number, limits = LIMITS): string[] {
  const drop = new Set(metas.filter((m) => now - m.usedAt > limits.idle).map((m) => m.path));
  const keep = metas.filter((m) => !drop.has(m.path)).sort((a, b) => b.usedAt - a.usedAt);
  let icons = 0;
  let wallpapers = 0;
  let bytes = 0;
  for (const m of keep) {
    const over = m.kind === 'icon' ? ++icons > limits.icons : ++wallpapers > limits.wallpapers;
    bytes += m.size;
    if (over || bytes > limits.bytes) {
      drop.add(m.path);
      bytes -= m.size;
    }
  }
  return [...drop];
}

// ── IndexedDB ───────────────────────────────────────────────────────────────
const DB_NAME = 'nexus-assets';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('meta', { keyPath: 'path' });
    r.result.createObjectStore('blobs');
  };
  return req(r);
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, fn: (meta: IDBObjectStore, blobs: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['meta', 'blobs'], mode);
    fn(t.objectStore('meta'), t.objectStore('blobs'));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ── In-memory view ─────────────────────────────────────────────────────────
interface Entry {
  meta: AssetMeta;
  url: string | null;
}

let db: IDBDatabase | null = null;
const entries = new Map<string, Entry>();
const inflight = new Set<string>();
/** Failed this page load (offline, server error): not retried until the next new tab. */
const failedNow = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let source: { server: () => ServerRecord | null; fetch: Fetch; now: () => number } | null = null;

const notify = () => {
  version++;
  listeners.forEach((fn) => fn());
};

/**
 * Opens the cache and makes a blob: URL for everything in it, before the first render, so cached
 * icons and the wallpaper paint with the page. A store that cannot be read is deleted and rebuilt.
 */
export async function loadAssets(opts: NonNullable<typeof source>): Promise<void> {
  source = opts;
  try {
    db = await openDb();
    const t = db.transaction(['meta', 'blobs'], 'readonly');
    const [metas, keys, blobs] = await Promise.all([req(t.objectStore('meta').getAll() as IDBRequest<AssetMeta[]>), req(t.objectStore('blobs').getAllKeys()), req(t.objectStore('blobs').getAll() as IDBRequest<Blob[]>)]);
    const byPath = new Map(keys.map((k, i) => [String(k), blobs[i]!]));
    for (const meta of metas) {
      const blob = byPath.get(meta.path);
      entries.set(meta.path, { meta, url: blob && !meta.missing ? URL.createObjectURL(blob) : null });
    }
  } catch {
    db?.close();
    db = null;
    entries.clear();
    await req(indexedDB.deleteDatabase(DB_NAME)).catch(() => undefined);
    db = await openDb().catch(() => null);
  }
}

async function store(meta: AssetMeta, blob: Blob | null) {
  if (!db) return;
  await tx(db, 'readwrite', (m, b) => {
    m.put(meta);
    if (blob) b.put(blob, meta.path);
    else b.delete(meta.path);
  }).catch(() => undefined);
}

let evictTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleEviction() {
  clearTimeout(evictTimer);
  evictTimer = setTimeout(() => {
    const doomed = planEviction([...entries.values()].map((e) => e.meta), source!.now());
    if (!doomed.length || !db) return;
    void tx(db, 'readwrite', (m, b) => doomed.forEach((p) => (m.delete(p), b.delete(p)))).catch(() => undefined);
    for (const p of doomed) {
      const e = entries.get(p);
      if (e?.url) URL.revokeObjectURL(e.url);
      entries.delete(p);
    }
    notify();
  }, 2000);
}

const queue: string[] = [];
let active = 0;
const CONCURRENCY = 4;

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const path = queue.shift()!;
    active++;
    void download(path).finally(() => {
      active--;
      inflight.delete(path);
      pump();
    });
  }
}

async function download(path: string) {
  const server = source?.server();
  if (!server || server.revoked) return;
  const t = source!.now();
  let blob: Blob | null;
  let retryAt = t + LIMITS.missingRetry;
  try {
    blob = await deviceApi(server.origin, source!.fetch).image(server.token, path);
  } catch (e) {
    // No network: try again with the next new tab. The server answered with an error (an icon
    // source down, a proxy error): remember that for a while instead of asking every time.
    if (!(e instanceof ApiError) || e.status === 0 || e.kind === 'unauthorized') return void failedNow.add(path);
    blob = null;
    retryAt = t + LIMITS.failedRetry;
  }
  const old = entries.get(path);
  if (blob) {
    if (old?.url) URL.revokeObjectURL(old.url);
    const meta: AssetMeta = { path, kind: kindOf(path), size: blob.size, fetchedAt: t, usedAt: t, missing: false };
    entries.set(path, { meta, url: URL.createObjectURL(blob) });
    await store(meta, blob);
  } else if (old?.url) {
    // A refresh that finds nothing keeps showing the copy it has, until the next refresh is due.
    old.meta = { ...old.meta, fetchedAt: t };
    if (db) await tx(db, 'readwrite', (m) => m.put(old.meta)).catch(() => undefined);
  } else {
    const meta: AssetMeta = { path, kind: kindOf(path), size: 0, fetchedAt: t, usedAt: t, missing: true, retryAt };
    entries.set(path, { meta, url: null });
    await store(meta, null);
  }
  notify();
  scheduleEviction();
}

/** Makes sure an image is (or will be) cached; records the use at most once a day. */
export function ensure(path: string) {
  if (!ALLOWED.test(path) || !source) return;
  const t = source.now();
  const e = entries.get(path);
  if (e) {
    if (t - e.meta.usedAt > DAY) {
      e.meta = { ...e.meta, usedAt: t };
      if (db) void tx(db, 'readwrite', (m) => m.put(e.meta)).catch(() => undefined);
    }
    if (e.meta.missing ? t < (e.meta.retryAt ?? e.meta.fetchedAt + LIMITS.missingRetry) : !(refreshable(path) && t - e.meta.fetchedAt > LIMITS.refresh)) return;
  }
  if (inflight.has(path) || failedNow.has(path)) return;
  inflight.add(path);
  queue.push(path);
  pump();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Host hook for AppTile: /api images come from the cache (null until there); others pass through. */
export function useImage(src: string | null): string | null {
  const path = src?.startsWith('/api/') ? src : null;
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (path) ensure(path);
  }, [path]);
  return path ? (entries.get(path)?.url ?? null) : src;
}

/** One variant per wallpaper: the smallest WebP at least as wide as this screen. */
export function wallpaperPath(u: UploadedWallpaper): string {
  const want = Math.max(screen.width, window.innerWidth) * (window.devicePixelRatio || 1);
  const width = u.widths.find((w) => w >= want * 0.9) ?? u.widths.at(-1)!;
  return wallpaperFile(u.id, width, 'webp');
}

/** Host hook for Wallpaper. */
export function useWallpaperFile(u: UploadedWallpaper | undefined): string | null | undefined {
  const url = useImage(u ? wallpaperPath(u) : null);
  return u ? url : undefined;
}

export const prefetchWallpaper = (u: UploadedWallpaper) => ensure(wallpaperPath(u));

/** For the settings page: how much is cached. */
export function assetStats(): { files: number; bytes: number } {
  const list = [...entries.values()].filter((e) => !e.meta.missing);
  return { files: list.length, bytes: list.reduce((n, e) => n + e.meta.size, 0) };
}

/** Drops every cached image (清理缓存, a new server, a revoked device). */
export async function clearAssets() {
  for (const e of entries.values()) if (e.url) URL.revokeObjectURL(e.url);
  entries.clear();
  failedNow.clear();
  queue.length = 0;
  if (db) await tx(db, 'readwrite', (m, b) => (m.clear(), b.clear())).catch(() => undefined);
  notify();
}
