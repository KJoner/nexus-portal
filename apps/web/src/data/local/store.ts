import { emptyLocalState, readLocalState, referencedAssets, type LocalState } from '@nexus/shared';

/**
 * Where 本地收藏 lives (v0.5 · U1): IndexedDB `nexus-local` of this origin — the portal's own, or
 * the browser extension's (its pages, popup and background share it). Not localStorage: the
 * portal's 「清除本地缓存」 and the extension's sign-out empty `nexus.cache.*` / localStorage, and
 * neither may touch what the person saved here. Clearing it is its own explicit action (clear()).
 *
 * The whole collection is one record (`state`); uploaded icons and wallpapers are records of
 * `assets`. Every change is one readwrite transaction over both: it reads the committed state, runs
 * the engine, writes the state back — and resolves only after the commit (durability "strict"), so
 * a caller that says 「已保存」 is telling the truth. IndexedDB never interleaves two readwrite
 * transactions on the same store, whichever page, tab or worker opened them, so concurrent saves
 * (popup + context menu + new tab, two portal tabs) cannot lose each other's writes.
 */
export interface AssetRecord {
  id: string;
  kind: 'icon' | 'wallpaper';
  type: string;
  blob: Blob;
  bytes: number;
  createdAt: number;
}

export interface AssetTx {
  put(record: AssetRecord): void;
  remove(id: string): void;
}

export interface LocalStore {
  /** The committed collection (created on first use). */
  read(): Promise<LocalState>;
  /** One atomic change: `fn` must not await; it mutates the state it is given and returns the answer. */
  transact<T>(fn: (state: LocalState, assets: AssetTx) => T): Promise<T>;
  asset(id: string): Promise<AssetRecord | null>;
  /** Deletes this browser's local collection and its files (an explicit, confirmed action). */
  clear(): Promise<void>;
  /**
   * Lets go of files nothing refers to any more (a replaced icon, an undone restore) once they are
   * older than `graceMs` — an icon just uploaded in the editor is not used until the app is saved.
   */
  sweep(graceMs?: number): Promise<number>;
  /** Called with the new revision whenever another page or tab of this origin changed the collection. */
  onChange(fn: (revision: number) => void): () => void;
}

/** The browser refused to store (quota, private window, disabled storage): nothing was saved. */
export class LocalStorageError extends Error {
  constructor(override readonly cause?: unknown) {
    super(quotaLike(cause) ? '没有保存：此浏览器的存储空间不足。请先导出备份，再删除一些收藏或壁纸后重试。' : '没有保存：此浏览器现在不允许保存数据（例如隐私窗口或已禁用网站数据）。内容还在页面上，请导出备份后再试。');
    this.name = 'LocalStorageError';
  }
}
const quotaLike = (e: unknown) => !!e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'QuotaExceededError';

const DB_NAME = 'nexus-local';
const STATE = 'kv';
const ASSETS = 'assets';
const CHANNEL = 'nexus-local';

const newWorkspace = () => `local:${(crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 24)}`;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      opening = null;
      reject(new LocalStorageError(e));
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => {
      opening = null;
      reject(new LocalStorageError(r.error));
    };
    r.onblocked = () => undefined;
  });
  return opening;
}

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** The browser's local collection: IndexedDB `nexus-local`. */
export function idbLocalStore(): LocalStore {
  const out = channel();
  const tellOthers = (revision: number) => {
    try {
      out?.postMessage({ type: 'changed', revision });
    } catch {
      /* closed */
    }
  };
  const api: LocalStore = {
    async read() {
      let db: IDBDatabase;
      try {
        db = await open();
      } catch (e) {
        throw e instanceof LocalStorageError ? e : new LocalStorageError(e);
      }
      const existing = readLocalState(await request(db.transaction(STATE, 'readonly').objectStore(STATE).get('state')).catch(() => null));
      // First use: created (and stored) in a transaction of its own, so every page agrees on one id.
      return existing ?? api.transact((s) => s);
    },
    async transact(fn) {
      let db: IDBDatabase;
      try {
        db = await open();
      } catch (e) {
        throw e instanceof LocalStorageError ? e : new LocalStorageError(e);
      }
      return new Promise((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction([STATE, ASSETS], 'readwrite', { durability: 'strict' });
        } catch {
          try {
            tx = db.transaction([STATE, ASSETS], 'readwrite');
          } catch (e) {
            reject(new LocalStorageError(e));
            return;
          }
        }
        const kv = tx.objectStore(STATE);
        const assets = tx.objectStore(ASSETS);
        let result: unknown;
        let refused: unknown = null;
        let revision = 0;
        const get = kv.get('state');
        get.onsuccess = () => {
          try {
            const state = readLocalState(get.result) ?? emptyLocalState(newWorkspace(), Date.now());
            result = fn(state, { put: (a) => assets.put(a), remove: (id) => assets.delete(id) });
            revision = state.revision;
            kv.put(state, 'state');
          } catch (e) {
            refused = e;
            try {
              tx.abort();
            } catch {
              /* already finished */
            }
          }
        };
        tx.oncomplete = () => {
          tellOthers(revision);
          resolve(result as never);
        };
        tx.onabort = () => reject(refused ?? new LocalStorageError(tx.error));
        tx.onerror = () => undefined;
      });
    },
    async asset(id) {
      try {
        const db = await open();
        return ((await request(db.transaction(ASSETS, 'readonly').objectStore(ASSETS).get(id))) as AssetRecord | undefined) ?? null;
      } catch {
        return null;
      }
    },
    async clear() {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STATE, ASSETS], 'readwrite');
        tx.objectStore(STATE).clear();
        tx.objectStore(ASSETS).clear();
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new LocalStorageError(tx.error));
      });
      tellOthers(0);
    },
    async sweep(graceMs = 86_400_000) {
      const db = await open();
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction([STATE, ASSETS], 'readwrite');
        const assets = tx.objectStore(ASSETS);
        let removed = 0;
        const get = tx.objectStore(STATE).get('state');
        get.onsuccess = () => {
          const s = readLocalState(get.result);
          if (!s) return;
          const keep = referencedAssets(s);
          const cursor = assets.openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c) return;
            const rec = c.value as AssetRecord;
            if (!keep.has(rec.id) && Date.now() - rec.createdAt > graceMs) {
              c.delete();
              removed++;
            }
            c.continue();
          };
        };
        tx.oncomplete = () => resolve(removed);
        tx.onabort = () => reject(new LocalStorageError(tx.error));
      });
    },
    onChange(fn) {
      const inbox = channel();
      if (!inbox) return () => {};
      inbox.onmessage = (e: MessageEvent<{ type?: string; revision?: number }>) => {
        if (e.data?.type === 'changed') fn(Number(e.data.revision) || 0);
      };
      return () => inbox.close();
    },
  };
  return api;
}

/**
 * Stand-in for tests (jsdom has no IndexedDB): the same contract — transactions run one after
 * another, each on a copy of the committed state; a refusal writes nothing.
 */
export function memoryLocalStore(workspace = 'local:test', opts: { starter?: boolean } = {}): LocalStore & { state: LocalState | null; assets: Map<string, AssetRecord>; failNext?: unknown } {
  // A new collection of the browser starts with the starter sites (UI v2 N3, as idbLocalStore does);
  // most tests want an empty one and say nothing.
  const starter = opts.starter ?? false;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(r: number) => void>();
  const store = {
    state: null as LocalState | null,
    assets: new Map<string, AssetRecord>(),
    failNext: undefined as unknown,
    async read() {
      return structuredClone(store.state ?? (store.state = emptyLocalState(workspace, Date.now(), { starter })));
    },
    transact<T>(fn: (s: LocalState, a: AssetTx) => T): Promise<T> {
      const run = chain.then(async () => {
        await new Promise((r) => setTimeout(r, 0));
        if (store.failNext) {
          const e = store.failNext;
          store.failNext = undefined;
          throw new LocalStorageError(e);
        }
        const draft = structuredClone(store.state ?? emptyLocalState(workspace, Date.now(), { starter }));
        const puts: AssetRecord[] = [];
        const removes: string[] = [];
        const result = fn(draft, { put: (a) => puts.push(a), remove: (id) => removes.push(id) });
        store.state = draft;
        for (const a of puts) store.assets.set(a.id, a);
        for (const id of removes) store.assets.delete(id);
        return result;
      });
      chain = run.catch(() => undefined);
      return run;
    },
    async asset(id: string) {
      return store.assets.get(id) ?? null;
    },
    async clear() {
      store.state = null;
      store.assets.clear();
    },
    async sweep(graceMs = 86_400_000) {
      if (!store.state) return 0;
      const keep = referencedAssets(store.state);
      let removed = 0;
      for (const [id, a] of store.assets) {
        if (!keep.has(id) && Date.now() - a.createdAt > graceMs) {
          store.assets.delete(id);
          removed++;
        }
      }
      return removed;
    },
    onChange(fn: (r: number) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return store;
}
