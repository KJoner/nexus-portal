import type { QueueEntry } from './collect';

/**
 * Where the save queue lives (NEX-05): one record per opId, and every change is a single
 * transaction over the whole queue. In the browser this is IndexedDB — shared by the service
 * worker (or Firefox's event page), the popup and the extension's pages, and a readwrite
 * transaction is never interleaved with another one on the same store, whichever context opened
 * it. So two saves at the same moment, a save during a send, a draft confirmed while sending, or
 * a sign-out while sending can no longer overwrite each other the way a read-modify-write of one
 * storage key did.
 *
 * `update` resolves only once the transaction has committed (durability "strict" where the
 * browser supports it): a caller that says 「已保存」 after it is telling the truth.
 */
export interface QueueChange {
  put?: QueueEntry[];
  remove?: string[];
}

export interface QueueStore {
  /** Every entry, oldest first. */
  all(): Promise<QueueEntry[]>;
  /** One atomic step: `fn` sees the whole queue as committed and says what to write. Must not await. */
  update<T>(fn: (entries: QueueEntry[]) => { change: QueueChange; result: T }): Promise<T>;
}

const order = (a: QueueEntry, b: QueueEntry) => a.at - b.at || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0);

const DB_NAME = 'nexus-queue';
const STORE = 'saves';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'opId' });
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another context upgrading later (a newer extension version) closes this one cleanly.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => {
      opening = null;
      reject(r.error);
    };
    r.onblocked = () => undefined;
  });
  return opening;
}

/** The browser's queue: IndexedDB `nexus-queue` / `saves`, keyed by opId. */
export function idbQueueStore(): QueueStore {
  return {
    async all() {
      const db = await open();
      const tx = db.transaction(STORE, 'readonly');
      const rows = (await request(tx.objectStore(STORE).getAll())) as QueueEntry[];
      return rows.sort(order);
    },
    async update(fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
        } catch {
          // Older engines without the options argument.
          tx = db.transaction(STORE, 'readwrite');
        }
        const store = tx.objectStore(STORE);
        let result: unknown;
        const all = store.getAll();
        all.onsuccess = () => {
          try {
            const out = fn((all.result as QueueEntry[]).sort(order));
            result = out.result;
            for (const e of out.change.put ?? []) store.put(e);
            for (const id of out.change.remove ?? []) store.delete(id);
          } catch (e) {
            tx.abort();
            reject(e);
          }
        };
        tx.oncomplete = () => resolve(result as never);
        tx.onabort = () => reject(tx.error ?? new Error('保存队列的写入被中止'));
        tx.onerror = () => undefined;
      });
    },
  };
}

/**
 * Stand-in for tests (jsdom has no IndexedDB): the same contract — transactions run one after
 * another, each sees committed state only, records are copies (structured clone), and a commit
 * takes a turn of the event loop so that callers really overlap. Results obtained with it are
 * recorded separately from runs in real browsers.
 */
export function memoryQueueStore(): QueueStore & { rows: Map<string, QueueEntry> } {
  const rows = new Map<string, QueueEntry>();
  let chain: Promise<unknown> = Promise.resolve();
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    rows,
    async all() {
      await tick();
      return [...rows.values()].map((e) => structuredClone(e)).sort(order);
    },
    update(fn) {
      const run = chain.then(async () => {
        await tick();
        const out = fn([...rows.values()].map((e) => structuredClone(e)).sort(order));
        await tick();
        for (const e of out.change.put ?? []) rows.set(e.opId, structuredClone(e));
        for (const id of out.change.remove ?? []) rows.delete(id);
        return out.result;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
