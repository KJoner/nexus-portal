import { applyOps, ConfigSchema, defaultConfig, invertOp, normalizeConfig, OpError, applyOp, type Config, type ConfigResponse, type Op, type Snapshot, type UploadedWallpaper } from '@nexus/shared';
import { create } from 'zustand';
import { storage } from '../lib/storage';
import { HttpError, httpTransport, NetworkError, type Transport } from './transport';

export type SaveState =
  | { kind: 'saved'; at: number }
  | { kind: 'saving'; pending: number }
  | { kind: 'offline'; pending: number }
  | { kind: 'error'; message: string };

export type AuthState = 'unknown' | 'authenticated' | 'anonymous';
export type DispatchResult = { ok: true; changed: boolean; undo: Op[] } | { ok: false; error: OpError };

interface Batch {
  id: string;
  ops: Op[];
}

interface ConfigStore {
  /** What the UI shows: the last server-confirmed snapshot with unsent ops replayed on top. */
  snapshot: Snapshot;
  confirmed: Snapshot | null;
  pending: Batch[];
  wallpapers: UploadedWallpaper[];
  auth: AuthState;
  online: boolean;
  /** Something real (cache or server) is on screen; false only on a first visit before the server answers. */
  ready: boolean;
  /** Showing built-in defaults because neither the server nor a cache was available. */
  fallback: boolean;
  lastSavedAt: number;
  dispatch(ops: Op | Op[]): DispatchResult;
}

const CACHE_KEY = 'nexus.cache.v2';
const CLIENT_KEY = 'nexus.client';

interface Cache {
  confirmed: Snapshot | null;
  pending: Batch[];
  wallpapers: UploadedWallpaper[];
}

const uid = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 24);
const clientId = (() => {
  const id = storage.get<string>(CLIENT_KEY) ?? uid();
  storage.set(CLIENT_KEY, id);
  return id;
})();

function readCache(): Cache {
  const raw = storage.get<Cache>(CACHE_KEY);
  if (!raw) return { confirmed: null, pending: [], wallpapers: [] };
  const parsed = raw.confirmed && ConfigSchema.safeParse(raw.confirmed.config);
  const confirmed = parsed && parsed.success ? { ...raw.confirmed!, config: normalizeConfig(parsed.data) } : null;
  return { confirmed, pending: Array.isArray(raw.pending) ? raw.pending : [], wallpapers: Array.isArray(raw.wallpapers) ? raw.wallpapers : [] };
}

/** Replays unsent batches on top of a confirmed config, dropping any the new state rejects. */
function rebase(base: Config, pending: Batch[]): { config: Config; pending: Batch[]; dropped: OpError[] } {
  let config = base;
  const kept: Batch[] = [];
  const dropped: OpError[] = [];
  for (const b of pending) {
    try {
      config = applyOps(config, b.ops);
      kept.push(b);
    } catch (e) {
      if (e instanceof OpError) dropped.push(e);
      else throw e;
    }
  }
  return { config, pending: kept, dropped };
}

function initialState() {
  const cache = readCache();
  const base = cache.confirmed ?? { revision: 0, updatedAt: new Date(0).toISOString(), config: defaultConfig() };
  const r = rebase(base.config, cache.pending);
  return {
    snapshot: { ...base, config: r.config },
    confirmed: cache.confirmed,
    pending: r.pending,
    wallpapers: cache.wallpapers,
    auth: 'unknown' as AuthState,
    online: true,
    ready: !!cache.confirmed,
    fallback: false,
    lastSavedAt: cache.confirmed ? Date.parse(cache.confirmed.updatedAt) : 0,
  };
}

let transport: Transport = httpTransport;
let notifyRejected: (message: string) => void = () => {};

export const useConfigStore = create<ConfigStore>((set, get) => ({
  ...initialState(),
  dispatch(input) {
    const ops = Array.isArray(input) ? input : [input];
    const before = get().snapshot.config;
    let config = before;
    const undo: Op[] = [];
    try {
      for (const op of ops) {
        undo.unshift(...invertOp(config, op));
        config = applyOp(config, op);
      }
    } catch (e) {
      if (e instanceof OpError) return { ok: false, error: e };
      throw e;
    }
    if (config === before) return { ok: true, changed: false, undo: [] };
    const pending = [...get().pending, { id: uid(), ops }];
    set({ snapshot: { ...get().snapshot, config }, pending });
    persist();
    void flush();
    return { ok: true, changed: true, undo };
  },
}));

function persist() {
  const s = useConfigStore.getState();
  storage.set(CACHE_KEY, { confirmed: s.confirmed, pending: s.pending, wallpapers: s.wallpapers } satisfies Cache);
}

function accept(res: ConfigResponse, pending = useConfigStore.getState().pending) {
  const s = useConfigStore.getState();
  if (s.confirmed && res.revision < s.confirmed.revision) return;
  const { wallpapers, ...snap } = res;
  const r = rebase(snap.config, pending);
  r.dropped.forEach((e) => notifyRejected(`一项更改未能同步：${e.message}`));
  useConfigStore.setState({ confirmed: snap, snapshot: { ...snap, config: r.config }, pending: r.pending, wallpapers, online: true, auth: 'authenticated', ready: true, fallback: false, lastSavedAt: Date.parse(snap.updatedAt) });
  persist();
}

function onFailure(e: unknown) {
  if (e instanceof HttpError && e.status === 401) {
    useConfigStore.setState({ auth: 'anonymous' });
  } else if (e instanceof NetworkError) {
    const s = useConfigStore.getState();
    useConfigStore.setState({ online: false, ready: true, fallback: !s.confirmed });
    scheduleRetry();
  } else throw e;
}

let flushing: Promise<void> | null = null;

/** Sends queued batches one by one; stops (keeping the queue) when offline or signed out. */
export function flush(): Promise<void> {
  // Cleared in `.finally`, which always runs after this assignment — even when the run has
  // nothing to send and completes synchronously.
  flushing ??= sendPending().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function sendPending() {
  for (;;) {
    const s = useConfigStore.getState();
    const batch = s.pending[0];
    if (!batch || s.auth === 'anonymous') return;
    try {
      const res = await transport.postOps({ clientId, batchId: batch.id, ops: batch.ops });
      accept(res, useConfigStore.getState().pending.filter((b) => b.id !== batch.id));
    } catch (e) {
      if (e instanceof HttpError && e.status !== 401) {
        // Rejected by the server (validation, conflict with another device): drop it, keep the rest.
        notifyRejected(`更改未能保存：${e.message}`);
        const rest = useConfigStore.getState().pending.filter((b) => b.id !== batch.id);
        const base = useConfigStore.getState().confirmed?.config ?? defaultConfig();
        const r = rebase(base, rest);
        useConfigStore.setState({ pending: r.pending, snapshot: { ...useConfigStore.getState().snapshot, config: r.config } });
        persist();
        continue;
      }
      onFailure(e);
      return;
    }
  }
}

export async function refresh(): Promise<void> {
  try {
    await flush();
    if (useConfigStore.getState().auth === 'anonymous') return;
    accept(await transport.getConfig());
  } catch (e) {
    onFailure(e);
  }
}

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 3000;
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryDelay = Math.min(retryDelay * 2, 60_000);
    void refresh();
  }, retryDelay);
}

let unsubscribe: (() => void) | null = null;
function connectEvents() {
  unsubscribe?.();
  unsubscribe = transport.subscribe(
    (revision) => {
      retryDelay = 3000;
      const s = useConfigStore.getState();
      if (!s.online || !s.confirmed || revision > s.confirmed.revision) void refresh();
    },
    () => void refresh(),
  );
}

let started = false;
/** Boots sync: first fetch, live revision events, and catch-up on reconnect / tab focus. */
export function startSync() {
  if (started) return;
  started = true;
  void refresh().then(() => useConfigStore.getState().auth === 'authenticated' && connectEvents());
  window.addEventListener('online', () => void refresh());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refresh());
}

export async function login(password: string): Promise<void> {
  await transport.login(password);
  useConfigStore.setState({ auth: 'authenticated' });
  await refresh();
  connectEvents();
}

/** Signs out and forgets everything this browser cached about the portal. */
export async function logout(): Promise<void> {
  try {
    await transport.logout();
  } finally {
    unsubscribe?.();
    unsubscribe = null;
    storage.remove(CACHE_KEY);
    storage.remove('nexus.recent.v1');
    useConfigStore.setState({ ...initialState(), auth: 'anonymous' });
  }
}

export async function uploadWallpaper(file: File): Promise<UploadedWallpaper> {
  const w = await transport.uploadWallpaper(file);
  void refresh();
  return w;
}

export const uploadIcon = (file: File) => transport.uploadIcon(file);

export async function deleteWallpaper(id: string): Promise<void> {
  accept(await transport.deleteWallpaper(id));
}

export function onSyncRejected(fn: (message: string) => void) {
  notifyRejected = fn;
}

/** Tests: swap the transport and reset to a clean, signed-in state. */
export function resetSync(next: Transport) {
  transport = next;
  storage.remove(CACHE_KEY);
  unsubscribe?.();
  unsubscribe = null;
  useConfigStore.setState({ ...initialState(), auth: 'authenticated' });
}
export { connectEvents as connectSyncEvents };

export function useSaveState(): SaveState {
  const pending = useConfigStore((s) => s.pending.length);
  const online = useConfigStore((s) => s.online);
  const at = useConfigStore((s) => s.lastSavedAt);
  if (!online) return { kind: 'offline', pending };
  if (pending) return { kind: 'saving', pending };
  return { kind: 'saved', at };
}

export const useConfig = (): Config => useConfigStore((s) => s.snapshot.config);
export const dispatch = (ops: Op | Op[]) => useConfigStore.getState().dispatch(ops);
