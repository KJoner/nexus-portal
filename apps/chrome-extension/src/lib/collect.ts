import { canonicalUrl, ITEM_LIMITS, type Item } from '@nexus/shared';
import { ApiError, type DeviceApi } from './api';
import type { QueueStore } from './queue-store';
import { KEYS, type Area, type ServerRecord } from './storage';

/**
 * 收藏当前页面 / 收藏此链接 (需求 §9.1 · EX-01/03): what is captured, and a save queue that is on
 * disk before anything is sent. The background service worker can stop at any moment; a queued
 * save keeps its opId, so sending it again (after a lost answer, a restart, a day offline) never
 * creates a second item.
 *
 * NEX-05: the queue is a QueueStore (IndexedDB, one record per opId); every change below is one
 * transaction of it, so concurrent saves, sends, confirmations and sign-outs cannot lose each
 * other's writes. The popup and the context menu reach these functions through the background's
 * commands (background.ts); a page that only reads the queue may read it directly.
 */
export interface Captured {
  title: string;
  url: string;
}

export const MENU = { page: 'nexus-save-page', link: 'nexus-save-link' } as const;

/** A readable title for a bare link (the context menu gives no link text). */
function linkTitle(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last ? `${last} · ${u.hostname}` : u.hostname;
  } catch {
    return url;
  }
}

const clip = (s: string) => [...s.trim()].slice(0, ITEM_LIMITS.title).join('');

/**
 * The context menu: 收藏此链接 takes the link (linkUrl), never the page it is on; 收藏当前页面 takes
 * the tab. Anything that is not a plain http(s) address is refused with a reason.
 */
export function captureFromMenu(info: { menuItemId: string | number; linkUrl?: string; pageUrl?: string; selectionText?: string }, tab?: { title?: string; url?: string }): Captured | { error: string } {
  const isLink = info.menuItemId === MENU.link;
  const url = (isLink ? info.linkUrl : (tab?.url ?? info.pageUrl)) ?? '';
  if (!canonicalUrl(url)) return { error: isLink ? '这个链接不能收藏（只能收藏 http/https 网址）' : '这个页面不能收藏（浏览器内部页面、本地文件等不支持）' };
  const title = isLink ? info.selectionText?.trim() || linkTitle(url) : tab?.title?.trim() || linkTitle(url);
  return { title: clip(title), url };
}

export type EntryState = 'pending' | 'saved' | 'duplicate' | 'held' | 'draft';

export interface QueueEntry {
  opId: string;
  title: string;
  url: string;
  folderId?: string;
  tags: string[];
  pinToHome: boolean;
  at: number;
  state: EntryState;
  /** pending/saved/duplicate/held: the server and account it was saved for; drafts have none yet. */
  origin: string | null;
  account: string | null;
  message?: string;
  item?: Pick<Item, 'id' | 'title' | 'folderId'>;
  /** When it finished (saved / already there): the newest few finished ones are kept for the popup. */
  doneAt?: number;
  /**
   * A draft made from a save of a known account (its authorization was revoked before it was sent):
   * only that account (same server) may confirm it again — never another one (ADR-017 I-6).
   * Drafts saved before any account was connected have none.
   */
  owner?: { origin: string; account: string } | null;
}

export type SaveInput = Captured & { folderId?: string; tags?: string[]; pinToHome?: boolean };

export const newOpId = () => `ext-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

const unsent = (e: QueueEntry) => e.state === 'pending' || e.state === 'draft' || e.state === 'held';
/** Finished entries beyond the newest ten (by when they finished) are let go with the next change. */
const KEEP_DONE = 10;
function overflow(entries: QueueEntry[]): string[] {
  return entries
    .filter((e) => !unsent(e))
    .sort((a, b) => (b.doneAt ?? b.at) - (a.doneAt ?? a.at))
    .slice(KEEP_DONE)
    .map((e) => e.opId);
}
/** Entries with `put` applied, then the finished overflow removed. */
function settle(entries: QueueEntry[], put: QueueEntry[]): { put: QueueEntry[]; remove: string[] } {
  const next = new Map(entries.map((e) => [e.opId, e]));
  for (const e of put) next.set(e.opId, e);
  const remove = overflow([...next.values()]);
  return { put: put.filter((e) => !remove.includes(e.opId)), remove };
}

export async function readQueue(store: QueueStore): Promise<QueueEntry[]> {
  return store.all();
}

const writable = (s: ServerRecord | null): s is ServerRecord & { account: { id: string; label: string } } => !!s && !s.revoked && !!s.scopes?.includes('items:write') && !!s.account;

/**
 * Puts a save on disk first (resolves once committed). Without a writing grant it becomes a draft:
 * kept here, sent only after the person has connected and confirmed which account it goes to.
 * `opId` from the caller makes a repeated command (the popup retrying after the background was
 * stopped) the same save, never a second one.
 */
export async function enqueue(store: QueueStore, server: ServerRecord | null, c: SaveInput, opts: { opId?: string; now?: number } = {}): Promise<QueueEntry> {
  const opId = opts.opId ?? newOpId();
  const ok = writable(server);
  const entry: QueueEntry = { opId, title: c.title, url: c.url, folderId: c.folderId, tags: c.tags ?? [], pinToHome: !!c.pinToHome && !!server?.scopes?.includes('pins:write'), at: opts.now ?? Date.now(), state: ok ? 'pending' : 'draft', origin: ok ? server.origin : null, account: ok ? server.account.id : null };
  return store.update((entries) => {
    const existing = entries.find((e) => e.opId === opId);
    if (existing) return { change: {}, result: existing };
    return { change: settle(entries, [entry]), result: entry };
  });
}

/** A draft this connection may confirm: one without an owner, or one of this very account. */
export const adoptable = (e: QueueEntry, server: ServerRecord | null): boolean => e.state === 'draft' && !!server?.account && (!e.owner || (e.owner.origin === server.origin && e.owner.account === server.account.id));

/** 草稿 → 待发送, for the account the person just confirmed (another account's drafts stay as they are). */
export async function adoptDrafts(store: QueueStore, server: ServerRecord, opIds?: readonly string[]): Promise<number> {
  if (!writable(server)) return 0;
  return store.update((entries) => {
    const put = entries.filter((e) => adoptable(e, server) && (!opIds || opIds.includes(e.opId))).map((e) => ({ ...e, state: 'pending' as const, origin: server.origin, account: server.account.id, owner: null }));
    return { change: { put }, result: put.length };
  });
}

export async function dropEntry(store: QueueStore, opId: string): Promise<void> {
  await store.update(() => ({ change: { remove: [opId] }, result: undefined }));
}

/**
 * This device lost its authorization: unsent saves become drafts (confirmed again later — they are
 * the person's, a revocation never deletes them), the record of finished ones goes. A draft keeps
 * the account it was saved for: reconnecting as another account never sends it with that one's token.
 */
export async function forgetSent(store: QueueStore): Promise<void> {
  await store.update((entries) => ({
    change: {
      put: entries.filter((e) => e.state === 'pending' || e.state === 'draft').map((e) => ({ ...e, state: 'draft' as const, origin: null, account: null, owner: e.owner ?? (e.origin && e.account ? { origin: e.origin, account: e.account } : null) })),
      remove: entries.filter((e) => e.state !== 'pending' && e.state !== 'draft').map((e) => e.opId),
    },
    result: undefined,
  }));
}

/**
 * Saves kept in the old single storage key (0.2.0) move into the queue store, each once (by opId);
 * the key goes only after they are committed there, so a stop in between repeats harmlessly.
 */
export async function migrateLegacyQueue(area: Area, store: QueueStore): Promise<number> {
  const raw = (await area.get([KEYS.queue]))[KEYS.queue];
  if (raw === undefined) return 0;
  const legacy = (Array.isArray(raw) ? raw : []).filter((e): e is QueueEntry => !!e && typeof e === 'object' && typeof (e as QueueEntry).opId === 'string' && typeof (e as QueueEntry).url === 'string');
  const n = await store.update((entries) => {
    const have = new Set(entries.map((e) => e.opId));
    const put = legacy.filter((e) => !have.has(e.opId)).map((e) => ({ ...e, tags: Array.isArray(e.tags) ? e.tags : [], at: Number(e.at) || Date.now() }));
    return { change: { put }, result: put.length };
  });
  await area.remove(KEYS.queue);
  return n;
}

/** Why sending stopped with saves still waiting (the badge and pages may say so). */
export type FlushStop = 'offline' | 'unauthorized' | 'refused' | 'busy';

/**
 * Sends what is pending for this server and account, oldest first. Stops at the first save that
 * cannot go now (offline, server busy, rate limited, authorization gone) and keeps it; finishes the
 * ones the server answered for good (saved, already there, over the limit).
 *
 * Each answer is written in its own transaction and only to an entry that is still what was sent
 * (dropped, confirmed elsewhere or moved to drafts meanwhile: left as it is now).
 */
export async function flushQueue(store: QueueStore, server: ServerRecord | null, api: Pick<DeviceApi, 'createItem'>): Promise<{ sent: number; left: number; stopped?: FlushStop }> {
  if (!writable(server)) return { sent: 0, left: (await store.all()).filter((e) => e.state === 'pending').length };
  const pendingFor = (entries: QueueEntry[]) => entries.filter((e) => e.state === 'pending' && e.origin === server.origin && e.account === server.account.id);
  let sent = 0;
  let stopped: FlushStop | undefined;
  const tried = new Set<string>();
  for (;;) {
    // Another account's or another server's saves are never sent with this token.
    const next = pendingFor(await store.all()).find((e) => !tried.has(e.opId));
    if (!next) break;
    tried.add(next.opId);
    let update: Partial<QueueEntry>;
    try {
      const r = await api.createItem(server.token, { opId: next.opId, source: 'extension', item: { kind: 'page', title: next.title, url: next.url, folderId: next.folderId, tags: next.tags }, pinToHome: next.pinToHome, duplicatePolicy: 'prompt' });
      // Saved; a pin the home page had no room for is said, not implied (NEX-07).
      const refused = r.pin && !r.pin.pinned ? (r.pin.code === 'PINS_FULL' ? `首页已固定满 ${r.pin.limit ?? 36} 个，没有固定到首页` : '这个页面不能固定到首页') : undefined;
      update = { state: 'saved', item: { id: r.item.id, title: r.item.title, folderId: r.item.folderId }, message: refused, doneAt: Date.now() };
      sent++;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === 'DUPLICATE') update = { state: 'duplicate', item: e.details?.item as QueueEntry['item'], message: '已在我的收藏中', doneAt: Date.now() };
      else if (e.code === 'QUOTA_EXCEEDED') update = { state: 'held', message: e.message };
      else if (e.code === 'VALIDATION') update = { state: 'held', message: e.message };
      else {
        // offline / busy (503 IDENTITY_UNAVAILABLE, 429, 5xx) / 401 / 403: kept as it is, tried again
        // later — never dropped, never sent with another token. A 401 is the caller's to handle
        // (the background marks the device revoked and turns what is unsent into drafts).
        stopped = e.kind === 'unauthorized' ? 'unauthorized' : e.code === 'IDENTITY_UNAVAILABLE' || e.status === 429 || e.status >= 500 ? 'busy' : e.kind === 'offline' ? 'offline' : 'refused';
        break;
      }
    }
    await store.update((entries) => {
      const now = entries.find((e) => e.opId === next.opId);
      if (!now || now.state !== 'pending' || now.origin !== next.origin || now.account !== next.account) return { change: {}, result: undefined };
      return { change: settle(entries, [{ ...now, ...update }]), result: undefined };
    });
  }
  const left = pendingFor(await store.all()).length;
  return stopped ? { sent, left, stopped } : { sent, left };
}
