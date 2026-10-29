import type { Config } from '@nexus/shared';
import { useConfigStore } from '@web/data/config-store';
import { useStatusStore } from '@web/data/status-store';
import { create } from 'zustand';
import { ApiError, deviceApi, type Fetch } from './api';
import { KEYS, readCache, readServer, readSync, type Area, type CacheRecord, type ServerRecord, type SyncRecord } from './storage';

/** A new tab opened within this long of the last check shows the cache and asks nothing. */
export const THROTTLE_MS = 30_000;
/** Service status older than this is not shown as current. */
const STATUS_FRESH_MS = 5 * 60_000;

export interface Engine {
  area: Area;
  fetch: Fetch;
  now(): number;
  /** One sync at a time across every open new tab: `try` gives up when another holds it. */
  lock<T>(mode: 'try' | 'wait', fn: () => Promise<T>): Promise<T | 'busy'>;
  /** Forget everything this browser cached about the portal (images, UI preferences). */
  wipe(): Promise<void>;
}

/** Web Locks are shared by every page of the extension (one origin). */
export const webLock: Engine['lock'] = async (mode, fn) => {
  if (!navigator.locks) return fn();
  return navigator.locks.request('nexus-sync', mode === 'try' ? { ifAvailable: true } : {}, (lock) => (lock ? fn() : ('busy' as const)));
};

export interface ExtState {
  loaded: boolean;
  server: ServerRecord | null;
  cache: CacheRecord | null;
  sync: SyncRecord;
  syncing: boolean;
}

const emptySync = (origin = ''): SyncRecord => ({ origin, checkedAt: 0, status: null, statusAt: 0, error: null });

export const useExt = create<ExtState>(() => ({ loaded: false, server: null, cache: null, sync: emptySync(), syncing: false }));

let engine: Engine | null = null;
export function initEngine(e: Engine) {
  engine = e;
}
function eng(): Engine {
  if (!engine) throw new Error('sync engine not initialised');
  return engine;
}

export type Phase = 'loading' | 'setup' | 'revoked' | 'empty' | 'ready';

/** What a page should show: pairing, a reconnect prompt, "no data yet", or the home. */
export function phaseOf(s: Pick<ExtState, 'loaded' | 'server' | 'cache'>): Phase {
  if (!s.loaded) return 'loading';
  if (!s.server) return 'setup';
  if (s.server.revoked) return 'revoked';
  return s.cache ? 'ready' : 'empty';
}

let presented: CacheRecord | null = null;

/** Hands the cached snapshot to the portal's own stores, which the reused home components read. */
function present(s: ExtState) {
  const c = s.cache;
  const offline = s.sync.error?.kind === 'offline';
  if (c && c !== presented) {
    const snap = { revision: c.data.revision, updatedAt: c.data.updatedAt, config: c.data.config };
    useConfigStore.setState({ snapshot: snap, confirmed: snap, pending: [], wallpapers: c.data.wallpapers, auth: 'authenticated', online: !offline, ready: true, fallback: false, lastSavedAt: c.syncedAt });
  } else if (c) useConfigStore.setState({ online: !offline });
  presented = c;
  const fresh = s.sync.status && eng().now() - s.sync.statusAt < STATUS_FRESH_MS;
  useStatusStore.getState().replace(fresh ? s.sync.status! : []);
}

/** Reads everything from storage (one call) and shows it. Damaged entries read as absent. */
export async function load(): Promise<ExtState> {
  const raw = await eng().area.get([KEYS.server, KEYS.cache, KEYS.sync]);
  const server = readServer(raw[KEYS.server]);
  const cache = readCache(raw[KEYS.cache], server);
  // A cache that does not read back is dropped, so the next sync downloads a fresh copy.
  if (raw[KEYS.cache] !== undefined && !cache) await eng().area.remove(KEYS.cache);
  const state: ExtState = { loaded: true, server, cache, sync: readSync(raw[KEYS.sync], server), syncing: useExt.getState().syncing };
  useExt.setState(state);
  present(state);
  return state;
}

const watchesStatus = (c: Config) => !c.settings.privacy.guest && c.apps.some((a) => a.kind === 'service' && a.health.enabled);

export type SyncOutcome = 'skipped' | 'busy' | 'unchanged' | 'updated' | 'failed' | 'revoked';

/**
 * Stale-while-revalidate: the page already shows the cache; this asks the server whether anything
 * changed (one conditional request, plus service status when the home shows it) and stores the
 * answer. Failures keep the cache untouched. `force` (手动同步) skips the throttle and waits for a
 * sync already running in another tab instead of giving up.
 */
export async function sync({ force = false }: { force?: boolean } = {}): Promise<SyncOutcome> {
  const e = eng();
  const result = await e.lock(force ? 'wait' : 'try', async (): Promise<SyncOutcome> => {
    // Fresh read: another tab may have finished while this one waited for the lock.
    const raw = await e.area.get([KEYS.server, KEYS.cache, KEYS.sync]);
    const server = readServer(raw[KEYS.server]);
    if (!server || server.revoked) return 'skipped';
    const cache = readCache(raw[KEYS.cache], server);
    const prev = readSync(raw[KEYS.sync], server);
    const t = e.now();
    const lastTry = Math.max(prev.checkedAt, prev.error?.at ?? 0);
    if (!force && cache && t - lastTry < THROTTLE_MS) return 'skipped';

    useExt.setState({ syncing: true });
    const api = deviceApi(server.origin, e.fetch);
    try {
      const res = await api.config(server.token, cache?.etag ?? null);
      let next = cache;
      if (res.changed) {
        const record = { origin: server.origin, deviceId: server.deviceId, etag: res.etag, data: res.data, syncedAt: t };
        next = readCache(record, server);
        if (!next) throw new ApiError('server', 'Nexus Portal 返回的配置无法识别，已保留本地缓存');
      }
      const status = next && watchesStatus(next.data.config) ? await api.status(server.token).catch(() => null) : null;
      const syncRecord: SyncRecord = { origin: server.origin, checkedAt: t, status, statusAt: status ? t : 0, error: null, sources: prev.sources?.revision === next?.data.revision ? prev.sources : undefined };
      await e.area.set(res.changed ? { [KEYS.cache]: next, [KEYS.sync]: syncRecord } : { [KEYS.sync]: syncRecord });
      return res.changed ? 'updated' : 'unchanged';
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') {
        // Revoked in the portal, password changed, or idle too long: the cached private data goes
        // too, and the page asks to pair again.
        await e.area.remove([KEYS.cache, KEYS.sync]);
        await e.area.set({ [KEYS.server]: { ...server, token: '-', revoked: true } });
        await e.wipe();
        return 'revoked';
      }
      const kind = err instanceof ApiError && err.kind === 'offline' ? 'offline' : 'server';
      await e.area.set({ [KEYS.sync]: { ...prev, error: { kind, message: err instanceof Error ? err.message : '同步失败', at: t } } });
      return 'failed';
    }
  });
  useExt.setState({ syncing: false });
  if (result !== 'busy' && result !== 'skipped') await load();
  return result;
}

/** The device this page is pairing right now: its own storage change must not reload it. */
let adopting: string | null = null;

/** After pairing: a different server (or device) starts from a clean slate, then syncs at once. */
export async function connect(server: ServerRecord): Promise<SyncOutcome> {
  const e = eng();
  const raw = await e.area.get([KEYS.server]);
  const old = readServer(raw[KEYS.server]);
  if (old && old.origin !== server.origin) await revokeQuietly(old);
  adopting = server.deviceId;
  try {
    await e.area.remove([KEYS.cache, KEYS.sync]);
    await e.wipe();
    await e.area.set({ [KEYS.server]: server });
    await load();
    return await sync({ force: true });
  } finally {
    adopting = null;
  }
}

async function revokeQuietly(server: ServerRecord) {
  if (server.revoked) return;
  await deviceApi(server.origin, eng().fetch)
    .revoke(server.token)
    .catch(() => undefined);
}

/** 断开连接: revoke the token on the server (best effort) and forget the server and its data. */
export async function disconnect(): Promise<ServerRecord | null> {
  const e = eng();
  const old = readServer((await e.area.get([KEYS.server]))[KEYS.server]);
  if (old) await revokeQuietly(old);
  await e.area.remove([KEYS.server, KEYS.cache, KEYS.sync]);
  await e.wipe();
  await load();
  return old;
}

/** 清理缓存: keeps the pairing, drops the cached configuration and images, then downloads again. */
export async function clearCache(): Promise<SyncOutcome> {
  const e = eng();
  await e.area.remove([KEYS.cache, KEYS.sync]);
  await e.wipe();
  await load();
  return sync({ force: true });
}

/** Keeps every open page in step with whichever page synced (chrome.storage.onChanged). */
export function onStorageChange(changes: Record<string, unknown>, reloadPage: () => void) {
  if (KEYS.server in changes) {
    const before = useExt.getState().server;
    const after = readServer((changes[KEYS.server] as { newValue?: unknown }).newValue);
    // Another server or device: nothing on screen may outlive it.
    const replaced = before && (!after || after.origin !== before.origin || after.deviceId !== before.deviceId);
    if (replaced && !(after && after.deviceId === adopting)) return reloadPage();
  }
  if (KEYS.server in changes || KEYS.cache in changes || KEYS.sync in changes) void load();
}
