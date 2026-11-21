import { applyOps, ConfigSchema, defaultConfig, invertOp, normalizeConfig, OpError, applyOp, type AppEntry, type Config, type ConfigResponse, type LogoutAllResponse, type MeResponse, type Op, type RevokeEverywhereResponse, type Snapshot, type UploadedWallpaper, changedFields, CONFLICT_CODES, CONFLICT_HTTP_CODE, newAppId, withBase } from '@nexus/shared';
import { create } from 'zustand';
import { storage } from '../lib/storage';
import { useStatusStore } from './status-store';
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
  /**
   * TN-07: changes the server refused because a limit was reached. Kept on this device (never
   * silently dropped) until the person retries them after making room, or discards them.
   */
  held: HeldBatch[];
  /** v0.4: who the server says this session belongs to (null until checked this page load). */
  account: MeResponse | null;
  /**
   * The cached data on screen is known to belong to the signed-in account. Until then nothing is
   * sent: an unsent change queued under one account must never reach the server as another.
   */
  verified: boolean;
  dispatch(ops: Op | Op[]): DispatchResult;
}

/**
 * v0.4: one cache per account — `nexus.cache.v3:<account id>` — and a pointer to the account this
 * browser last verified. The pre-v0.4 cache (`v2`) had no owner: it can only have been the legacy
 * administrator's, so it is handed to that account once verified, and dropped for anyone else.
 */
const CACHE_PREFIX = 'nexus.cache.v3:';
const ACCOUNT_KEY = 'nexus.account.v1';
const LEGACY_CACHE_KEY = 'nexus.cache.v2';
const LEGACY_ADMIN = 'legacy-admin';
const CLIENT_KEY = 'nexus.client';
const cacheKey = (account: string) => `${CACHE_PREFIX}${account}`;
let cacheAccount: string | null = storage.get<{ id: string }>(ACCOUNT_KEY)?.id ?? null;
/** The role last confirmed for that account: operator UI appears without waiting for /me (no flicker). */
let cachedRole: 'admin' | 'user' | null = storage.get<{ role?: 'admin' | 'user' }>(ACCOUNT_KEY)?.role ?? null;
const accountListeners = new Set<() => void>();
/** Per-person data kept elsewhere (recent searches) is dropped when another account signs in here. */
export function onAccountChange(fn: () => void) {
  accountListeners.add(fn);
  return () => accountListeners.delete(fn);
}

interface Cache {
  confirmed: Snapshot | null;
  pending: Batch[];
  wallpapers: UploadedWallpaper[];
  held?: HeldBatch[];
}

const uid = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 24);
const clientId = (() => {
  const id = storage.get<string>(CLIENT_KEY) ?? uid();
  storage.set(CLIENT_KEY, id);
  return id;
})();

/**
 * A batch kept on this device instead of being sent or dropped (shown in 设置 › 数据与安全):
 *  - quota     the server refused it with QUOTA_EXCEEDED; retried after making room;
 *  - conflict  (v0.4.1, NEX-04) another device got there first — the app was deleted (ITEM_DELETED),
 *              the same field was changed (FIELD_CONFLICT), or what this deletes / restores changed
 *              meanwhile (REVISION_CONFLICT). Never forced and never lost: the person decides.
 * Entries written before v0.4.1 have no reason: they are quota entries.
 */
export interface HeldBatch {
  batch: Batch;
  message: string;
  at: number;
  reason?: 'quota' | 'conflict';
  code?: string;
  /** What the server (or a newer snapshot) says is there now. */
  details?: Record<string, unknown> | null;
}

const CONFLICT_HTTP: readonly string[] = Object.values(CONFLICT_HTTP_CODE);
const isConflictError = (e: unknown): e is OpError => e instanceof OpError && CONFLICT_CODES.includes(e.code);
const conflictOf = (batch: Batch, e: OpError): HeldBatch => ({ batch, message: e.message, at: Date.now(), reason: 'conflict', code: CONFLICT_HTTP_CODE[e.code as keyof typeof CONFLICT_HTTP_CODE], details: e.details ?? null });

function readCache(account: string | null): Cache {
  const raw = account ? storage.get<Cache>(cacheKey(account)) : null;
  if (!raw) return { confirmed: null, pending: [], wallpapers: [], held: [] };
  const parsed = raw.confirmed && ConfigSchema.safeParse(raw.confirmed.config);
  const confirmed = parsed && parsed.success ? { ...raw.confirmed!, config: normalizeConfig(parsed.data) } : null;
  return { confirmed, pending: Array.isArray(raw.pending) ? raw.pending : [], wallpapers: Array.isArray(raw.wallpapers) ? raw.wallpapers : [], held: Array.isArray(raw.held) ? raw.held : [] };
}

/**
 * Replays unsent batches on top of a confirmed config. A batch the new state rejects is dropped —
 * unless the rejection is a conflict with another device (NEX-04: the app it edits was deleted, the
 * same field changed): that one is kept aside for the person to decide, never re-applied over it.
 */
function rebase(base: Config, pending: Batch[]): { config: Config; pending: Batch[]; dropped: OpError[]; conflicts: HeldBatch[] } {
  let config = base;
  const kept: Batch[] = [];
  const dropped: OpError[] = [];
  const conflicts: HeldBatch[] = [];
  for (const b of pending) {
    try {
      config = applyOps(config, b.ops);
      kept.push(b);
    } catch (e) {
      if (isConflictError(e)) conflicts.push(conflictOf(b, e));
      else if (e instanceof OpError) dropped.push(e);
      else throw e;
    }
  }
  return { config, pending: kept, dropped, conflicts };
}

function initialState(account: string | null = cacheAccount) {
  const cache = readCache(account);
  const base = cache.confirmed ?? { revision: 0, updatedAt: new Date(0).toISOString(), config: defaultConfig() };
  const r = rebase(base.config, cache.pending);
  return {
    snapshot: { ...base, config: r.config },
    confirmed: cache.confirmed,
    pending: r.pending,
    wallpapers: cache.wallpapers,
    held: [...(cache.held ?? []), ...r.conflicts],
    auth: 'unknown' as AuthState,
    online: true,
    ready: !!cache.confirmed,
    fallback: false,
    lastSavedAt: cache.confirmed ? Date.parse(cache.confirmed.updatedAt) : 0,
    account: null as MeResponse | null,
    verified: false,
  };
}

let transport: Transport = httpTransport;
/** The transport in use (the 收藏库 store talks to the same server, and tests swap both at once). */
export const currentTransport = (): Transport => transport;
let notifyRejected: (message: string) => void = () => {};

export const useConfigStore = create<ConfigStore>((set, get) => ({
  ...initialState(),
  dispatch(input) {
    const ops = Array.isArray(input) ? input : [input];
    const before = get().snapshot.config;
    let config = before;
    const undo: Op[] = [];
    const sent: Op[] = [];
    try {
      for (const raw of ops) {
        // What this device saw goes along (NEX-04): edits merge with changes made elsewhere and a
        // deleted app is never brought back by an edit that started before the deletion.
        const op = withBase(config, raw);
        undo.unshift(...invertOp(config, op));
        config = applyOp(config, op);
        sent.push(op);
      }
    } catch (e) {
      if (e instanceof OpError) return { ok: false, error: e };
      throw e;
    }
    if (config === before) return { ok: true, changed: false, undo: [] };
    const pending = [...get().pending, { id: uid(), ops: sent }];
    set({ snapshot: { ...get().snapshot, config }, pending });
    persist();
    void flush();
    return { ok: true, changed: true, undo };
  },
}));

function persist() {
  if (!cacheAccount) return;
  const s = useConfigStore.getState();
  storage.set(cacheKey(cacheAccount), { confirmed: s.confirmed, pending: s.pending, wallpapers: s.wallpapers, held: s.held } satisfies Cache);
}

/** Private images cached by the Service Worker are keyed by address, not account: they go with the account. */
function wipeImageCaches() {
  if (typeof caches !== 'undefined') for (const name of ['nexus-wallpapers', 'nexus-daily', 'nexus-icons']) void caches.delete(name);
}

/**
 * Asks the server who this session belongs to. Another account than the cache's: nothing of the
 * previous one stays on screen, and its cache (with any unsent changes) waits under its own key
 * for that person to sign in again here.
 */
async function verifyAccount(): Promise<void> {
  const me = await transport.me();
  const id = me.account.id;
  const legacy = storage.get<Cache>(LEGACY_CACHE_KEY);
  if (legacy) {
    if (id === LEGACY_ADMIN && !storage.get(cacheKey(LEGACY_ADMIN))) storage.set(cacheKey(LEGACY_ADMIN), legacy);
    storage.remove(LEGACY_CACHE_KEY);
  }
  cachedRole = me.role;
  if (cacheAccount !== id) {
    const switched = cacheAccount !== null;
    cacheAccount = id;
    storage.set(ACCOUNT_KEY, { id, role: me.role });
    useConfigStore.setState({ ...initialState(id), auth: 'authenticated', account: me, verified: true });
    useStatusStore.getState().replace([]);
    if (switched) {
      wipeImageCaches();
      accountListeners.forEach((fn) => fn());
    }
  } else {
    storage.set(ACCOUNT_KEY, { id, role: me.role });
    useConfigStore.setState({ account: me, verified: true });
  }
}

function accept(res: ConfigResponse, pending = useConfigStore.getState().pending) {
  const s = useConfigStore.getState();
  if (s.confirmed && res.revision < s.confirmed.revision) return;
  const { wallpapers, ...snap } = res;
  const r = rebase(snap.config, pending);
  r.dropped.forEach((e) => notifyRejected(`一项更改未能同步：${e.message}`));
  r.conflicts.forEach((h) => notifyRejected(`${h.message}。这项更改已保留在本机，可在「设置 › 数据、同步与安全」处理`));
  useConfigStore.setState({ confirmed: snap, snapshot: { ...snap, config: r.config }, pending: r.pending, wallpapers, online: true, auth: 'authenticated', ready: true, fallback: false, lastSavedAt: Date.parse(snap.updatedAt), ...(r.conflicts.length ? { held: [...s.held, ...r.conflicts].slice(-40) } : {}) });
  persist();
}

function onFailure(e: unknown) {
  if (e instanceof HttpError && e.status === 401) {
    useConfigStore.setState({ auth: 'anonymous', verified: false });
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
    if (!batch || s.auth === 'anonymous' || !s.verified) return;
    try {
      const res = await transport.postOps({ clientId, batchId: batch.id, ops: batch.ops });
      accept(res, useConfigStore.getState().pending.filter((b) => b.id !== batch.id));
    } catch (e) {
      if (e instanceof HttpError && e.status !== 401 && e.retryable) {
        // Too fast (RATE_LIMITED) or a passing server error: keep everything, try again later.
        scheduleRetry(e.retryAfter ? e.retryAfter * 1000 : undefined);
        return;
      }
      if (e instanceof HttpError && e.status !== 401) {
        const quota = e.code === 'QUOTA_EXCEEDED';
        // NEX-04: another device got there first (deleted it, changed the same field). Kept for the
        // person to decide — never dropped, never retried over the other change.
        const conflict = e.status === 409 && CONFLICT_HTTP.includes(e.code);
        // Over a limit: kept on this device as a draft, never lost. Anything else the server refuses
        // (validation) is dropped; the rest of the queue continues.
        notifyRejected(quota ? `${e.message}。这项更改已保留在本机，腾出空间后可在「设置 › 数据、同步与安全」重试` : conflict ? `${e.message}。这项更改已保留在本机，可在「设置 › 数据、同步与安全」处理` : `更改未能保存：${e.message}`);
        const s2 = useConfigStore.getState();
        const rest = s2.pending.filter((b) => b.id !== batch.id);
        const r = rebase(s2.confirmed?.config ?? defaultConfig(), rest);
        const keep: HeldBatch[] = quota ? [{ batch, message: e.message, at: Date.now(), reason: 'quota' }] : conflict ? [{ batch, message: e.message, at: Date.now(), reason: 'conflict', code: e.code, details: e.details }] : [];
        useConfigStore.setState({ pending: r.pending, snapshot: { ...s2.snapshot, config: r.config }, held: [...s2.held, ...keep, ...r.conflicts].slice(-40) });
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
    await verifyAccount();
    await flush();
    if (useConfigStore.getState().auth === 'anonymous') return;
    accept(await transport.getConfig());
    useStatusStore.getState().replace(await transport.getStatus());
  } catch (e) {
    onFailure(e);
  }
}

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 3000;
/** Next attempt after the backoff — or exactly when the server said (Retry-After). */
function scheduleRetry(afterMs?: number) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(
    () => {
      if (afterMs === undefined) retryDelay = Math.min(retryDelay * 2, 60_000);
      void refresh();
    },
    afterMs ?? retryDelay,
  );
}

const isQuotaHeld = (h: HeldBatch) => h.reason !== 'conflict';

/** 设置 › 数据与安全: send the changes held over a limit again (after making room), or let them go. */
export function retryHeld(): DispatchResult[] {
  const all = useConfigStore.getState().held;
  const held = all.filter(isQuotaHeld);
  useConfigStore.setState({ held: all.filter((h) => !isQuotaHeld(h)) });
  persist();
  // Through dispatch, so a change that still does not fit is refused here, with its message.
  const results = held.map((h) => useConfigStore.getState().dispatch(h.batch.ops));
  const still = held.filter((_, i) => !results[i]!.ok);
  if (still.length) {
    useConfigStore.setState({ held: [...still, ...useConfigStore.getState().held] });
    persist();
  }
  return results;
}

/** 放弃 the changes held over a limit (conflicts are decided one by one, see resolveHeld). */
export function discardHeld() {
  useConfigStore.setState({ held: useConfigStore.getState().held.filter((h) => !isQuotaHeld(h)) });
  persist();
}

export type ConflictChoice = 'mine' | 'copy' | 'discard';

/**
 * NEX-04: what the person decided about a change another device got ahead of.
 *  - mine     apply it after all: an app deleted elsewhere is first restored (explicitly, the copy
 *             in 回收站), a field changed elsewhere takes my value — only the fields I changed;
 *             a delete or restore goes ahead against what is there now;
 *  - copy     keep my version as a new app, next to (or instead of) the one deleted elsewhere;
 *  - discard  keep what is there now.
 * Goes out as an ordinary change (dispatch): it syncs, and can itself conflict again.
 */
export function resolveHeld(index: number, choice: ConflictChoice): DispatchResult | { ok: true; changed: false; undo: [] } {
  const s = useConfigStore.getState();
  const h = s.held[index];
  if (!h) return { ok: true, changed: false, undo: [] };
  const drop = () => {
    useConfigStore.setState({ held: useConfigStore.getState().held.filter((x) => x !== h) });
    persist();
  };
  if (choice === 'discard') {
    drop();
    return { ok: true, changed: false, undo: [] };
  }
  const now = s.snapshot.config;
  const current = (h.details?.current ?? null) as AppEntry | null;
  const item = (h.details?.item ?? null) as { version?: number } | null;
  const ops: Op[] = [];
  const ids = new Map<string, string>();
  for (const op of h.batch.ops) {
    if (choice === 'copy' && op.type === 'app.upsert') {
      // My version as a new app (its own id), whatever happened to the original.
      const id = newAppId(op.app.name, [...now.apps, ...ops.flatMap((o) => (o.type === 'app.upsert' ? [o.app] : []))]);
      ids.set(op.app.id, id);
      ops.push({ type: 'app.upsert', app: { ...op.app, id, version: undefined }, base: null });
    } else if (op.type === 'app.upsert') {
      const here = now.apps.find((a) => a.id === op.app.id);
      if (here) {
        // My changes (against what I started from) on top of what is there now; a change made by an
        // older version of this page (no base) meant the whole entry.
        const mine: Record<string, unknown> = { ...here };
        for (const k of op.base ? changedFields(op.base, op.app) : Object.keys(op.app)) mine[k] = (op.app as Record<string, unknown>)[k];
        ops.push({ type: 'app.upsert', app: { ...(mine as AppEntry), id: here.id }, base: here, ...(op.index !== undefined ? { index: op.index } : {}) });
      } else {
        // Deleted elsewhere: bring back the copy in 回收站 (an explicit restore), then apply my edit to it.
        const restorable = !!current && current.id === op.app.id;
        if (restorable) ops.push({ type: 'app.restore', app: current, ...(item?.version !== undefined ? { baseVersion: item.version } : {}) });
        ops.push({ ...op, base: op.base ?? (restorable ? current : null) });
      }
    } else if (op.type === 'app.delete') ops.push({ type: 'app.delete', appId: op.appId });
    else if (op.type === 'app.restore') ops.push({ ...op, ...(item?.version !== undefined ? { baseVersion: item.version } : {}) });
    else if ('appId' in op && ids.has(op.appId)) ops.push({ ...op, appId: ids.get(op.appId)! });
    else ops.push(op);
  }
  const r = s.dispatch(ops);
  if (r.ok) drop();
  return r;
}

let unsubscribe: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 2000;

function connectEvents() {
  unsubscribe?.();
  clearTimeout(reconnectTimer);
  unsubscribe = transport.subscribe({
    // Anything pushed before this connection existed (a status change during boot, events across a
    // server restart) would otherwise be missed: re-sync on every open, the first one included.
    onOpen() {
      reconnectDelay = 2000;
      void refresh();
    },
    onRevision(revision) {
      retryDelay = 3000;
      const s = useConfigStore.getState();
      if (!s.online || !s.confirmed || revision > s.confirmed.revision) void refresh();
    },
    onStatus: (e) => useStatusStore.getState().apply(e),
    // The browser gave up (server down, proxy error, 401): reconnect with backoff once it answers.
    onClosed() {
      unsubscribe?.();
      unsubscribe = null;
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
        void refresh().then(() => {
          if (useConfigStore.getState().auth !== 'authenticated') return;
          if (useConfigStore.getState().online) connectEvents();
          else connectLater();
        });
      }, reconnectDelay);
    },
  });
}

function connectLater() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    void refresh().then(() => {
      const s = useConfigStore.getState();
      if (s.auth === 'authenticated') (s.online ? connectEvents : connectLater)();
    });
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
}

let started = false;
/** Boots sync: first fetch, live revision events, and catch-up on reconnect / tab focus. */
export function startSync() {
  if (started) return;
  started = true;
  const connect = () => {
    const s = useConfigStore.getState();
    if (s.auth === 'authenticated') (s.online ? connectEvents : connectLater)();
  };
  void refresh().then(connect);
  window.addEventListener('online', () => void refresh().then(() => !unsubscribe && connect()));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refresh());
}

export async function login(password: string): Promise<void> {
  await transport.login(password);
  useConfigStore.setState({ auth: 'authenticated' });
  await refresh();
  connectEvents();
}

/** Forgets everything this browser cached for the signed-in account. */
function forgetLocal() {
  unsubscribe?.();
  unsubscribe = null;
  clearTimeout(reconnectTimer);
  if (cacheAccount) storage.remove(cacheKey(cacheAccount));
  storage.remove(ACCOUNT_KEY);
  storage.remove(LEGACY_CACHE_KEY);
  storage.remove('nexus.recent.v1');
  cacheAccount = null;
  cachedRole = null;
  // Private images cached by the Service Worker go too.
  wipeImageCaches();
  accountListeners.forEach((fn) => fn());
  useStatusStore.getState().replace([]);
  useConfigStore.setState({ ...initialState(null), auth: 'anonymous' });
}

/** 退出当前产品: signs out of Nexus in this browser and forgets what it cached. */
export async function logout(): Promise<void> {
  try {
    await transport.logout();
  } finally {
    forgetLocal();
  }
}

/**
 * ADR-019 动作 B · 退出 Nexus 的全部设备: every session, paired extension and approved-but-unclaimed
 * pairing of the account ends on the server. The identity service and LiteSync are not touched.
 */
export async function logoutEverywhere(): Promise<LogoutAllResponse> {
  const r = await transport.logoutAll();
  forgetLocal();
  return r;
}

/** Where the outcome of 动作 C waits for the login page (this browser is signed out by then). */
const EVERYWHERE_KEY = 'nexus.revocation.v1';

/**
 * ADR-019 动作 C · 退出所有产品与设备. The server answers part by part (this product, the identity
 * service, LiteSync); the answer is kept for the login page this browser lands on next.
 */
export async function revokeAllProducts(): Promise<RevokeEverywhereResponse> {
  const r = await transport.revokeEverywhere();
  forgetLocal();
  try {
    sessionStorage.setItem(EVERYWHERE_KEY, JSON.stringify({ at: Date.now(), result: r }));
  } catch {
    /* storage disabled: the account page shows the state after signing in again */
  }
  return r;
}

/** The last 动作 C outcome of this tab, for the login page (null when there is none). */
export function lastEverywhere(): { at: number; result: RevokeEverywhereResponse } | null {
  try {
    const raw = sessionStorage.getItem(EVERYWHERE_KEY);
    return raw ? (JSON.parse(raw) as { at: number; result: RevokeEverywhereResponse }) : null;
  } catch {
    return null;
  }
}

export function dismissEverywhere() {
  try {
    sessionStorage.removeItem(EVERYWHERE_KEY);
  } catch {
    /* nothing kept */
  }
}

export async function uploadWallpaper(file: File): Promise<UploadedWallpaper> {
  const w = await transport.uploadWallpaper(file);
  void refresh();
  return w;
}

export const uploadIcon = (file: File) => transport.uploadIcon(file);
export const testHealth = (app: AppEntry) => transport.testHealth(app);
export const linkwardenApi = {
  status: () => transport.linkwarden(),
  connect: (baseUrl: string, token?: string) => transport.connectLinkwarden(baseUrl, token),
  disconnect: () => transport.disconnectLinkwarden(),
  search: (q: string, signal: AbortSignal) => transport.searchBookmarks(q, signal),
};
export const suggestApi = (engineId: string, q: string, signal: AbortSignal) => transport.suggest(engineId, q, signal);

export async function checkNow(appId: string) {
  useStatusStore.getState().apply(await transport.checkNow(appId));
}

/** Adds a library entry the server just made, without waiting for the revision event. */
function adopt(w: UploadedWallpaper): UploadedWallpaper {
  const s = useConfigStore.getState();
  if (!s.wallpapers.some((x) => x.id === w.id)) {
    useConfigStore.setState({ wallpapers: [...s.wallpapers, w] });
    persist();
  }
  return w;
}

export const wallpaperSources = {
  list: () => transport.wallpaperSources(),
  gallery: async (id: string) => adopt(await transport.galleryWallpaper(id)),
  /** The picture of the day is not a library entry, so nothing is adopted. */
  daily: () => transport.dailyWallpaper(),
  keepDaily: async (id: string) => adopt(await transport.keepDaily(id)),
  import: async (url: string) => adopt(await transport.importWallpaper(url)),
  unsplash: (q: string, page = 1) => transport.unsplashPhotos(q, page),
  useUnsplash: async (id: string) => adopt(await transport.unsplashWallpaper(id)),
};

/** v0.4 应用目录 (public templates; whether one is already added is decided against this account's data). */
export const catalogApi = { load: () => transport.catalog() };

/** Browser extensions paired with this portal (数据、同步与安全 · 浏览器扩展). */
export const devicesApi = {
  list: () => transport.devices(),
  revoke: (id: string) => transport.revokeDevice(id),
  pairing: (code: string) => transport.pairingRequest(code),
  decide: (code: string, approve: boolean, scopes?: string[]) => transport.decidePairing(code, approve, scopes),
};

export async function deleteWallpaper(id: string): Promise<void> {
  accept(await transport.deleteWallpaper(id));
}

export function onSyncRejected(fn: (message: string) => void) {
  notifyRejected = fn;
}

/** The Chrome extension reads through its own (device-token, read-only) transport. */
export function setTransport(next: Transport) {
  transport = next;
}

/** Tests: swap the transport and reset to a clean, signed-in, verified state of `account`. */
export function resetSync(next: Transport, account = LEGACY_ADMIN) {
  transport = next;
  for (const k of [LEGACY_CACHE_KEY, ACCOUNT_KEY, cacheKey(account)]) storage.remove(k);
  cacheAccount = account;
  cachedRole = null;
  unsubscribe?.();
  unsubscribe = null;
  useConfigStore.setState({ ...initialState(account), auth: 'authenticated', verified: true });
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
/** v0.4: the signed-in account (null until the server has answered). For display only. */
export const useAccount = () => useConfigStore((s) => s.account);
/**
 * Operator tools (service status, health checks, Linkwarden) are hidden for everyone else; the
 * server enforces it regardless. Unknown yet (no answer and nothing cached — e.g. the browser
 * extension, which never asks) keeps the single-user behaviour: shown.
 */
export const useIsAdmin = () => useConfigStore((s) => (s.account ? s.account.role === 'admin' : cachedRole !== 'user'));
export const authOptions = () => transport.authOptions();
/** ADR-019: cross-product revocation events of this account, and resending one. */
export const revocationApi = {
  status: () => transport.revocationStatus(),
  retry: (eventId: string) => transport.retryRevocation(eventId),
};
/** v0.4 administration (administrators only). */
export const adminApi = {
  revocationStatus: () => transport.adminRevocationStatus(),
  users: () => transport.adminUsers(),
  setDisabled: (id: string, disabled: boolean) => transport.setUserDisabled(id, disabled),
  invite: (ttlDays: number) => transport.createInvite(ttlDays),
};
export const dispatch = (ops: Op | Op[]) => useConfigStore.getState().dispatch(ops);
