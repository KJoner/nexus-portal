import type { Item, ItemInput, ItemPatch, ItemWriteResult, SnapshotResponse } from '@nexus/shared';
import { create } from 'zustand';
import { toast } from '../components/toast-store';
import { storage } from '../lib/storage';
import { currentTransport, onAccountChange, useConfigStore } from './config-store';
import { HttpError, NetworkError } from './transport';

/**
 * 收藏库 data (需求 §8.4, 契约 §6): a full snapshot once, then only changes after its cursor
 * (pulled whenever the account's revision moves). Writes go out with an opId; when the server
 * cannot be reached they wait in a queue kept per account on this device and are sent — with the
 * same opId, so never twice — when it can. Nothing of one account is ever sent as another.
 *
 * NEX-04: a queued change the server refuses because another device got there first (the item was
 * deleted, the same field changed, what it deletes was edited) is not dropped: it waits in this
 * account's conflict list until the person decides (apply mine / keep as a new item / discard).
 */
export type Folder = SnapshotResponse['folders'][number];

export interface QueuedOp {
  opId: string;
  kind: 'create' | 'patch' | 'remove' | 'restore' | 'pin' | 'unpin';
  id?: string;
  body?: unknown;
  /** The item as this device last saw it (title for the conflict list, content for 另存一条). */
  seen?: Pick<Item, 'title' | 'url' | 'folderId' | 'tags' | 'note'>;
}

/** A queued change the server refused for good; kept until the person decides. */
export interface LibraryConflict {
  op: QueuedOp;
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  at: number;
}

interface LibraryState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
  /** The account these items belong to. */
  owner: string | null;
  items: Record<string, Item>;
  pins: string[];
  folders: Folder[];
  cursor: string | null;
  queued: number;
  conflicts: LibraryConflict[];
}

const initial = (): LibraryState => ({ status: 'idle', error: '', owner: null, items: {}, pins: [], folders: [], cursor: null, queued: 0, conflicts: [] });
export const useLibrary = create<LibraryState>(() => initial());

const queueKey = (owner: string) => `nexus.library.queue.v1:${owner}`;
const conflictsKey = (owner: string) => `nexus.library.conflicts.v1:${owner}`;
const opId = (kind: string) => `${kind}-${(crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 20)}`;
const ownerNow = () => useConfigStore.getState().account?.account.id ?? null;
/** What the server says is final for this change and the person has to decide about. */
const KEPT = new Set(['ITEM_DELETED', 'FIELD_CONFLICT', 'REVISION_CONFLICT', 'DUPLICATE', 'QUOTA_EXCEEDED']);

function readQueue(owner: string | null): QueuedOp[] {
  return owner ? (storage.get<QueuedOp[]>(queueKey(owner)) ?? []) : [];
}
function writeQueue(owner: string, q: QueuedOp[]) {
  if (q.length) storage.set(queueKey(owner), q);
  else storage.remove(queueKey(owner));
  if (useLibrary.getState().owner === owner) useLibrary.setState({ queued: q.length });
}
function readConflicts(owner: string | null): LibraryConflict[] {
  return owner ? (storage.get<LibraryConflict[]>(conflictsKey(owner)) ?? []) : [];
}
function writeConflicts(owner: string, list: LibraryConflict[]) {
  if (list.length) storage.set(conflictsKey(owner), list.slice(-50));
  else storage.remove(conflictsKey(owner));
  if (useLibrary.getState().owner === owner) useLibrary.setState({ conflicts: list.slice(-50) });
}

/** Another account signed in here: nothing of the previous one stays in memory. */
onAccountChange(() => useLibrary.setState(initial()));

function put(items: Item[]) {
  if (!items.length) return;
  const next = { ...useLibrary.getState().items };
  for (const i of items) {
    const old = next[i.id];
    // A change applied twice (snapshot page + changes, or a replay) never moves an item back.
    if (!old || old.version <= i.version) next[i.id] = i;
  }
  useLibrary.setState({ items: next });
}

export async function loadLibrary(): Promise<void> {
  const owner = ownerNow();
  if (!owner) return;
  const t = currentTransport();
  useLibrary.setState({ status: useLibrary.getState().owner === owner && useLibrary.getState().status === 'ready' ? 'ready' : 'loading', error: '', owner, queued: readQueue(owner).length, conflicts: readConflicts(owner) });
  try {
    let page = await t.items.snapshot();
    const items: Item[] = [...page.items];
    const first = page;
    while (page.nextPage) {
      page = await t.items.snapshot(page.nextPage);
      items.push(...page.items);
    }
    if (ownerNow() !== owner) return;
    useLibrary.setState({ items: Object.fromEntries(items.map((i) => [i.id, i])), pins: first.pins, folders: first.folders, cursor: first.cursor, status: 'ready' });
    // Pages and changes share the snapshot's watermark: what changed while paging comes next.
    await pullLibrary();
    await flushLibrary();
  } catch (e) {
    if (ownerNow() !== owner) return;
    useLibrary.setState({ status: 'error', error: e instanceof NetworkError ? '无法连接 Nexus 服务端' : e instanceof Error ? e.message : '加载失败' });
  }
}

let pulling: Promise<void> | null = null;
export function pullLibrary(): Promise<void> {
  pulling ??= (async () => {
    const owner = useLibrary.getState().owner;
    let cursor = useLibrary.getState().cursor;
    if (!owner || !cursor || owner !== ownerNow()) return;
    try {
      for (;;) {
        const r = await currentTransport().items.changes(cursor);
        if (useLibrary.getState().owner !== owner) return;
        put(r.changes.flatMap((c) => (c.item ? [c.item] : [])));
        useLibrary.setState({ cursor: r.nextCursor, ...(r.pins ? { pins: r.pins } : {}), ...(r.folders ? { folders: r.folders } : {}) });
        cursor = r.nextCursor;
        if (!r.hasMore) break;
      }
    } catch (e) {
      // Too old (history pruned) or no longer valid: rebuild from a snapshot.
      if (e instanceof HttpError && (e.code === 'CURSOR_EXPIRED' || e.code === 'INVALID_CURSOR')) await loadLibrary();
    }
  })().finally(() => {
    pulling = null;
  });
  return pulling;
}

/** What a write answered: the item (applied here), or why it could not be done. */
export type WriteOutcome = { ok: true; item?: Item; queued?: boolean } | { ok: false; code: string; message: string; details?: Record<string, unknown> | null };

async function send(op: QueuedOp): Promise<ItemWriteResult | { pins: string[] }> {
  const t = currentTransport().items;
  const base = (op.body as { baseVersion?: number } | undefined)?.baseVersion;
  switch (op.kind) {
    case 'create':
      return t.create({ opId: op.opId, ...(op.body as object) } as Parameters<typeof t.create>[0]);
    case 'patch':
      return t.patch(op.id!, { opId: op.opId, ...(op.body as { baseVersion: number; patch: ItemPatch }) });
    case 'remove':
      return t.remove(op.id!, op.opId, base);
    case 'restore':
      return t.restore(op.id!, op.opId, base);
    case 'pin':
      return t.pin(op.id!, op.opId, (op.body as { position?: number } | undefined)?.position);
    case 'unpin':
      return t.unpin(op.id!, op.opId);
  }
}

function applyAnswer(res: ItemWriteResult | { pins: string[] }) {
  if ('pins' in res) useLibrary.setState({ pins: res.pins });
  else {
    put([res.item]);
    const pins = useLibrary.getState().pins;
    if (res.item.pinned && !pins.includes(res.item.id)) useLibrary.setState({ pins: [...pins, res.item.id] });
    if (!res.item.pinned && pins.includes(res.item.id)) useLibrary.setState({ pins: pins.filter((x) => x !== res.item.id) });
  }
}

const retryable = (e: unknown) => e instanceof NetworkError || (e instanceof HttpError && e.retryable && e.status !== 401);

async function run(op: QueuedOp): Promise<WriteOutcome> {
  const owner = useLibrary.getState().owner;
  if (!owner) return { ok: false, code: 'NOT_READY', message: '收藏库还没有加载' };
  // Changes still waiting go first: a new one never overtakes them (a delete before the queued edit).
  if (readQueue(owner).length) {
    writeQueue(owner, [...readQueue(owner), op]);
    void flushLibrary();
    return { ok: true, queued: true };
  }
  try {
    const res = await send(op);
    if (useLibrary.getState().owner === owner) applyAnswer(res);
    return { ok: true, item: 'item' in res ? res.item : undefined };
  } catch (e) {
    if (retryable(e)) {
      // Kept on this device with the same opId: sent later, applied once.
      writeQueue(owner, [...readQueue(owner), op]);
      if (e instanceof HttpError && e.retryAfter) setTimeout(() => void flushLibrary(), e.retryAfter * 1000);
      return { ok: true, queued: true };
    }
    if (e instanceof HttpError) {
      // Conflicts carry the current item: show it, so nothing is overwritten blindly.
      const current = (e.details?.item ?? null) as Item | null;
      if (current) put([current]);
      return { ok: false, code: e.code, message: e.message, details: e.details };
    }
    throw e;
  }
}

/** Sends what waited while offline, in order; stops at the first one that still cannot go. */
let flushing: Promise<void> | null = null;
export function flushLibrary(): Promise<void> {
  flushing ??= (async () => {
    const owner = useLibrary.getState().owner;
    if (!owner || owner !== ownerNow()) return;
    let q = readQueue(owner);
    while (q.length) {
      const op = q[0]!;
      try {
        applyAnswer(await send(op));
      } catch (e) {
        if (retryable(e)) return;
        if (!(e instanceof HttpError)) throw e;
        const current = (e.details?.item ?? null) as Item | null;
        if (current) put([current]);
        if (KEPT.has(e.code)) {
          // Another device got there first: kept for the person to decide, never dropped (NEX-04).
          writeConflicts(owner, [...readConflicts(owner), { op, code: e.code, message: e.message, details: e.details, at: Date.now() }]);
          toast({ msg: `一项离线时的更改没有完成：${e.message}。已保留在本机，请在收藏库中处理`, tone: 'warn' });
        } else toast({ msg: `一项离线时的更改未能保存：${e.message}`, tone: 'warn' });
      }
      // Re-read: changes made while this one was on its way were appended meanwhile.
      writeQueue(owner, readQueue(owner).filter((x) => x.opId !== op.opId));
      q = readQueue(owner);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
if (typeof window !== 'undefined') window.addEventListener('online', () => void flushLibrary());

export type LibraryChoice = 'mine' | 'copy' | 'discard';

/** What can be done about a kept conflict (the page shows these buttons). */
export function conflictChoices(c: LibraryConflict): LibraryChoice[] {
  if (c.op.kind === 'patch' && (c.code === 'ITEM_DELETED' || c.code === 'FIELD_CONFLICT')) return ['mine', 'copy', 'discard'];
  if (c.op.kind === 'create' && c.code === 'DUPLICATE') return ['mine', 'copy', 'discard'];
  return ['mine', 'discard'];
}

/**
 * NEX-04: the person's decision about a kept conflict, sent as new requests (new opIds):
 *  - mine     a patch of a deleted item restores it (explicitly) and then applies the change; a
 *             field conflict applies my fields over the current version; a delete / restore goes
 *             ahead against what is there now; a duplicate updates the existing item;
 *  - copy     my version as a new item;
 *  - discard  keep what is there now.
 */
export async function resolveConflict(index: number, choice: LibraryChoice): Promise<WriteOutcome> {
  const owner = useLibrary.getState().owner;
  const c = useLibrary.getState().conflicts[index];
  if (!owner || !c) return { ok: false, code: 'NOT_READY', message: '收藏库还没有加载' };
  const done = () => writeConflicts(owner, readConflicts(owner).filter((x) => x.at !== c.at || x.op.opId !== c.op.opId));
  if (choice === 'discard') {
    done();
    return { ok: true };
  }
  const current = (c.details?.item ?? null) as Item | null;
  const version = current?.version;
  let r: WriteOutcome;
  if (choice === 'copy') {
    const body = c.op.body as { patch?: ItemPatch; item?: ItemInput } | undefined;
    const from = c.op.kind === 'create' ? body?.item : current ? { title: current.title, url: current.url, folderId: current.folderId, tags: current.tags, note: current.note, ...body?.patch } : c.op.seen ? { ...c.op.seen, ...body?.patch } : null;
    if (!from) return { ok: false, code: 'NOT_AVAILABLE', message: '没有可另存的内容' };
    r = await run({ opId: opId('create'), kind: 'create', body: { source: 'manual', item: { kind: 'page', title: from.title, url: from.url, folderId: from.folderId, tags: from.tags, note: from.note }, pinToHome: false, duplicatePolicy: 'create' } });
  } else if (c.op.kind === 'patch' && c.code === 'ITEM_DELETED' && current && version !== undefined) {
    const back = await run({ opId: opId('restore'), kind: 'restore', id: c.op.id, body: { baseVersion: version } });
    // The edit goes after the restore (queued behind it when offline); a restore adds one version.
    if (!back.ok) r = back;
    else r = await run({ ...c.op, opId: opId('patch'), body: { ...(c.op.body as object), baseVersion: back.item?.version ?? version + 1 } });
  } else if (c.op.kind === 'create') {
    r = await run({ ...c.op, opId: opId('create'), body: { ...(c.op.body as object), duplicatePolicy: c.code === 'DUPLICATE' ? 'update' : (c.op.body as { duplicatePolicy?: string })?.duplicatePolicy } });
  } else {
    // A newer base: what is there now (the server sent it along with the refusal).
    r = await run({ ...c.op, opId: opId(c.op.kind), body: { ...(c.op.body as object), ...(version !== undefined ? { baseVersion: version } : {}) } });
  }
  if (r.ok) done();
  return r;
}

// ── operations used by the page ─────────────────────────────────────────
const seenOf = (i: Item): QueuedOp['seen'] => ({ title: i.title, url: i.url, folderId: i.folderId, tags: i.tags, note: i.note });
export const libraryApi = {
  create: (item: ItemInput, opts: { pinToHome?: boolean; duplicatePolicy?: 'prompt' | 'update' | 'create' } = {}) => run({ opId: opId('create'), kind: 'create', body: { source: 'manual', item, pinToHome: !!opts.pinToHome, duplicatePolicy: opts.duplicatePolicy ?? 'prompt' } }),
  patch: (item: Item, patch: ItemPatch) => {
    // Shown at once; the server's answer (or its conflict) replaces it.
    put([{ ...item, ...patch, version: item.version }]);
    return run({ opId: opId('patch'), kind: 'patch', id: item.id, body: { baseVersion: item.version, patch }, seen: seenOf(item) });
  },
  /** With the version shown here (NEX-04): what was changed elsewhere since is not deleted blindly. */
  remove: (item: Item) => run({ opId: opId('remove'), kind: 'remove', id: item.id, body: { baseVersion: item.version }, seen: seenOf(item) }),
  /** Explicit, from the version shown in 回收站: a deletion undone (and redone) since is not overturned. */
  restore: (item: Item) => run({ opId: opId('restore'), kind: 'restore', id: item.id, body: { baseVersion: item.version }, seen: seenOf(item) }),
  pin: (item: Item, position?: number) => run({ opId: opId('pin'), kind: 'pin', id: item.id, body: { position } }),
  unpin: (item: Item) => run({ opId: opId('unpin'), kind: 'unpin', id: item.id }),
  async importItems(items: ItemInput[], folderId: string | undefined) {
    return currentTransport().items.importItems({ opId: opId('import'), folderId, items, skipDuplicates: true });
  },
  async undoImport(importId: string) {
    return currentTransport().items.undoImport(importId, opId('undo'));
  },
};
