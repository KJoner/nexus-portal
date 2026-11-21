import { canonicalUrl, ITEM_LIMITS, type Item } from '@nexus/shared';
import { ApiError, type DeviceApi } from './api';
import { KEYS, type Area, type ServerRecord } from './storage';

/**
 * 收藏当前页面 / 收藏此链接 (需求 §9.1 · EX-01/03): what is captured, and a save queue that is on
 * disk before anything is sent. The background service worker can stop at any moment; a queued
 * save keeps its opId, so sending it again (after a lost answer, a restart, a day offline) never
 * creates a second item.
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
}

const newOpId = () => `ext-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export async function readQueue(area: Area): Promise<QueueEntry[]> {
  const raw = (await area.get([KEYS.queue]))[KEYS.queue];
  return Array.isArray(raw) ? (raw as QueueEntry[]) : [];
}

async function writeQueue(area: Area, entries: QueueEntry[]) {
  // Keep every unsent entry, and only the last few finished ones (the popup shows them).
  const unsent = entries.filter((e) => e.state === 'pending' || e.state === 'draft' || e.state === 'held');
  const done = entries.filter((e) => !unsent.includes(e)).slice(-10);
  const all = [...unsent, ...done];
  if (all.length) await area.set({ [KEYS.queue]: all });
  else await area.remove(KEYS.queue);
}

/** This device lost its authorization: unsent saves become drafts (confirmed again later), the rest goes. */
export async function forgetSent(area: Area): Promise<void> {
  const unsent = (await readQueue(area)).filter((e) => e.state === 'pending' || e.state === 'draft').map((e) => ({ ...e, state: 'draft' as const, origin: null, account: null }));
  await writeQueue(area, unsent);
}

/**
 * Puts a save on disk first. Without a writing grant it becomes a draft: kept here, sent only after
 * the person has connected and confirmed which account it goes to.
 */
export async function enqueue(area: Area, server: ServerRecord | null, c: Captured & { folderId?: string; tags?: string[]; pinToHome?: boolean }): Promise<QueueEntry> {
  const writable = !!server && !server.revoked && !!server.scopes?.includes('items:write') && !!server.account;
  const entry: QueueEntry = { opId: newOpId(), title: c.title, url: c.url, folderId: c.folderId, tags: c.tags ?? [], pinToHome: !!c.pinToHome && !!server?.scopes?.includes('pins:write'), at: Date.now(), state: writable ? 'pending' : 'draft', origin: writable ? server!.origin : null, account: writable ? server!.account!.id : null };
  await writeQueue(area, [...(await readQueue(area)), entry]);
  return entry;
}

/** 草稿 → 待发送, for the account the person just confirmed. */
export async function adoptDrafts(area: Area, server: ServerRecord, opIds?: readonly string[]): Promise<number> {
  let n = 0;
  const q = (await readQueue(area)).map((e) => {
    if (e.state !== 'draft' || (opIds && !opIds.includes(e.opId))) return e;
    n++;
    return { ...e, state: 'pending' as const, origin: server.origin, account: server.account!.id };
  });
  await writeQueue(area, q);
  return n;
}

export async function dropEntry(area: Area, opId: string): Promise<void> {
  await writeQueue(area, (await readQueue(area)).filter((e) => e.opId !== opId));
}

/**
 * Sends what is pending for this server and account, oldest first. Stops at the first save that
 * cannot go now (offline, server busy, rate limited, authorization gone) and keeps it; finishes the
 * ones the server answered for good (saved, already there, over the limit).
 */
export async function flushQueue(area: Area, server: ServerRecord | null, api: Pick<DeviceApi, 'createItem'>): Promise<{ sent: number; left: number }> {
  if (!server || server.revoked || !server.account || !server.scopes?.includes('items:write')) return { sent: 0, left: (await readQueue(area)).filter((e) => e.state === 'pending').length };
  let sent = 0;
  for (;;) {
    const q = await readQueue(area);
    // Another account's or another server's saves are never sent with this token.
    const next = q.find((e) => e.state === 'pending' && e.origin === server.origin && e.account === server.account!.id);
    if (!next) break;
    let update: Partial<QueueEntry>;
    try {
      const r = await api.createItem(server.token, { opId: next.opId, source: 'extension', item: { kind: 'page', title: next.title, url: next.url, folderId: next.folderId, tags: next.tags }, pinToHome: next.pinToHome, duplicatePolicy: 'prompt' });
      update = { state: 'saved', item: { id: r.item.id, title: r.item.title, folderId: r.item.folderId }, message: undefined };
      sent++;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === 'DUPLICATE') update = { state: 'duplicate', item: e.details?.item as QueueEntry['item'], message: '已在收藏库中' };
      else if (e.code === 'QUOTA_EXCEEDED') update = { state: 'held', message: e.message };
      else if (e.code === 'VALIDATION') update = { state: 'held', message: e.message };
      else break; // offline / busy / 429 / 401 / 403: kept as it is, tried again later
    }
    await writeQueue(area, (await readQueue(area)).map((e) => (e.opId === next.opId ? { ...e, ...update } : e)));
  }
  return { sent, left: (await readQueue(area)).filter((e) => e.state === 'pending').length };
}
