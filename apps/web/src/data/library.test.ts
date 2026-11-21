import type { Item, ItemPatch, ItemWriteResult } from '@nexus/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../components/toast-store';
import { resetSync, useConfigStore } from './config-store';
import { flushLibrary, libraryApi, loadLibrary, resolveConflict, useLibrary } from './library';
import { HttpError, MemoryTransport, NetworkError, type ItemsTransport } from './transport';

/**
 * NEX-04 在收藏库（v2）一侧：离线排队的修改被服务端以冲突拒绝时保留下来由人决定（不再丢弃），
 * 恢复与删除带上看到的版本；排队中的写入按顺序发出，新写入不插队、发送中追加的不被覆盖。
 * 服务端是一个只实现这些规则的替身（真实规则由 apps/server 的 deletion.test.ts 覆盖）。
 */
class FakeItems implements ItemsTransport {
  online = true;
  items = new Map<string, Item>();
  fields = new Map<string, Record<string, number>>();
  calls: string[] = [];
  /** While set, a PATCH waits here (after saying it arrived): a request on its way. */
  gate: Promise<void> | null = null;
  arrived: (() => void) | null = null;
  private guard() {
    if (!this.online) throw new NetworkError();
  }
  add(over: Partial<Item> & { id: string }): Item {
    const i: Item = { kind: 'page', source: 'manual', catalogId: null, title: '文章', url: `https://${over.id}.example.org/`, folderId: 'none', tags: [], note: '', iconRef: '', version: 1, pinned: false, position: 1, createdAt: 0, updatedAt: 0, deletedAt: null, importId: null, ...over };
    this.items.set(i.id, i);
    return i;
  }
  /** Another device changes the item (bumps the version, remembers the fields). */
  elsewhere(id: string, change: Partial<Item>) {
    const i = this.items.get(id)!;
    const version = i.version + 1;
    const f = this.fields.get(id) ?? {};
    for (const k of Object.keys(change)) if (k !== 'deletedAt') f[k] = version;
    if (change.deletedAt === null && i.deletedAt !== null) f.restored = version;
    this.fields.set(id, f);
    this.items.set(id, { ...i, ...change, version });
  }
  private answer(i: Item, result: ItemWriteResult['result']): ItemWriteResult {
    return { item: i, result, ownerRevision: 0 };
  }
  async snapshot() {
    this.guard();
    return { items: [...this.items.values()], pins: [], folders: [{ id: 'none', label: '未分类', locked: true }], watermark: 0, cursor: 'c0', nextPage: null };
  }
  async changes() {
    this.guard();
    return { changes: [], nextCursor: 'c0', hasMore: false };
  }
  async create(): Promise<ItemWriteResult> {
    throw new HttpError(501, 'not_in_test', '');
  }
  async patch(id: string, body: { opId: string; baseVersion: number; patch: ItemPatch }) {
    this.guard();
    if (this.gate) {
      this.arrived?.();
      await this.gate;
    }
    this.calls.push(`patch:${id}`);
    const i = this.items.get(id)!;
    if (i.deletedAt !== null) throw new HttpError(409, 'ITEM_DELETED', '这条收藏已被删除；需要时先恢复', false, null, { item: i });
    const f = this.fields.get(id) ?? {};
    const clash = Object.keys(body.patch).filter((k) => (f[k] ?? 0) > body.baseVersion);
    if (clash.length) throw new HttpError(409, 'FIELD_CONFLICT', '这些字段在别处已被修改，请先合并', false, null, { currentVersion: i.version, conflictFields: clash, item: i });
    this.elsewhere(id, body.patch as Partial<Item>);
    return this.answer(this.items.get(id)!, 'updated');
  }
  async remove(id: string, _opId: string, baseVersion?: number) {
    this.guard();
    this.calls.push(`remove:${id}@${baseVersion}`);
    const i = this.items.get(id)!;
    if (i.deletedAt !== null) return this.answer(i, 'unchanged');
    const f = this.fields.get(id) ?? {};
    if (baseVersion !== undefined && Object.entries(f).some(([k, v]) => k !== 'restored' && v > baseVersion)) throw new HttpError(409, 'REVISION_CONFLICT', '这条收藏在你上次看到之后被修改过，没有删除', false, null, { item: i });
    this.elsewhere(id, { deletedAt: 1 });
    return this.answer(this.items.get(id)!, 'deleted');
  }
  async restore(id: string, _opId: string, baseVersion?: number) {
    this.guard();
    this.calls.push(`restore:${id}@${baseVersion}`);
    const i = this.items.get(id)!;
    if (i.deletedAt === null) return this.answer(i, 'unchanged');
    if (baseVersion !== undefined && (this.fields.get(id)?.restored ?? 0) > baseVersion) throw new HttpError(409, 'REVISION_CONFLICT', '已被恢复过、又被再次删除', false, null, { item: i });
    this.elsewhere(id, { deletedAt: null });
    return this.answer(this.items.get(id)!, 'restored');
  }
  async pin(): Promise<{ pins: string[] }> {
    throw new HttpError(501, 'not_in_test', '');
  }
  async unpin(): Promise<{ pins: string[] }> {
    throw new HttpError(501, 'not_in_test', '');
  }
  async importItems(): Promise<{ importId: string; imported: number; skipped: number }> {
    throw new HttpError(501, 'not_in_test', '');
  }
  async undoImport(): Promise<{ removed: number; kept: number }> {
    throw new HttpError(501, 'not_in_test', '');
  }
  async exportAll(): Promise<unknown> {
    throw new HttpError(501, 'not_in_test', '');
  }
}

let items: FakeItems;
const lib = () => useLibrary.getState();

beforeEach(async () => {
  localStorage.clear();
  const server = new MemoryTransport();
  items = new FakeItems();
  server.items = items;
  resetSync(server);
  useConfigStore.setState({ account: await server.me() });
  useLibrary.setState({ status: 'idle', owner: null, items: {}, conflicts: [], queued: 0 });
  useToastStore.setState({ current: null });
});

describe('NEX-04 · 收藏库离线更改', () => {
  it('离线修改遇到别处的删除：保留为冲突（刷新后仍在），「恢复并应用修改」先显式恢复再修改', async () => {
    const x = items.add({ id: 'it-a', title: '原标题' });
    await loadLibrary();
    items.online = false;
    expect(await libraryApi.patch(lib().items[x.id]!, { title: '离线改' })).toMatchObject({ ok: true, queued: true });
    items.online = true;
    items.elsewhere(x.id, { deletedAt: 5 });
    await flushLibrary();
    expect(lib().queued).toBe(0);
    expect(lib().conflicts).toHaveLength(1);
    expect(lib().conflicts[0]).toMatchObject({ code: 'ITEM_DELETED', op: { kind: 'patch', body: { patch: { title: '离线改' } } } });
    expect(JSON.parse(localStorage.getItem('nexus.library.conflicts.v1:legacy-admin')!)).toHaveLength(1);
    expect(items.items.get(x.id)!.deletedAt).not.toBeNull();

    expect(await resolveConflict(0, 'mine')).toMatchObject({ ok: true });
    expect(items.calls.slice(-2)).toEqual([`restore:${x.id}@2`, `patch:${x.id}`]);
    expect(items.items.get(x.id)).toMatchObject({ deletedAt: null, title: '离线改' });
    expect(lib().conflicts).toEqual([]);
  });

  it('同字段冲突保留下来；「放弃」保留别处的版本', async () => {
    const x = items.add({ id: 'it-b', title: '原标题' });
    await loadLibrary();
    items.online = false;
    await libraryApi.patch(lib().items[x.id]!, { title: '我改的' });
    items.online = true;
    items.elsewhere(x.id, { title: '别处改的' });
    await flushLibrary();
    expect(lib().conflicts[0]).toMatchObject({ code: 'FIELD_CONFLICT' });
    await resolveConflict(0, 'discard');
    expect(lib().conflicts).toEqual([]);
    expect(items.items.get(x.id)!.title).toBe('别处改的');
  });

  it('删除与恢复带上看到的版本：恢复之后又被删除的，旧的恢复不会推翻它', async () => {
    const x = items.add({ id: 'it-c' });
    await loadLibrary();
    await libraryApi.remove(lib().items[x.id]!);
    expect(items.calls.at(-1)).toBe(`remove:${x.id}@1`);
    const tomb = lib().items[x.id]!;
    items.online = false;
    await libraryApi.restore(tomb);
    items.online = true;
    // Elsewhere, meanwhile: restored and deleted again.
    items.elsewhere(x.id, { deletedAt: null });
    items.elsewhere(x.id, { deletedAt: 9 });
    await flushLibrary();
    expect(items.items.get(x.id)!.deletedAt).not.toBeNull();
    expect(lib().conflicts[0]).toMatchObject({ code: 'REVISION_CONFLICT', op: { kind: 'restore' } });
  });

  it('排队中的写入按顺序发出：之后的删除不插队；发送途中追加的写入不会被覆盖掉', async () => {
    const x = items.add({ id: 'it-d' });
    const y = items.add({ id: 'it-e' });
    const z = items.add({ id: 'it-f' });
    await loadLibrary();
    items.online = false;
    await libraryApi.patch(lib().items[x.id]!, { title: '先改' });
    items.online = true;
    let open!: () => void;
    items.gate = new Promise<void>((r) => (open = r));
    const arrived = new Promise<void>((r) => (items.arrived = r));
    // A new write while one is still queued waits behind it (and starts sending the queue).
    expect(await libraryApi.remove(lib().items[y.id]!)).toMatchObject({ ok: true, queued: true });
    await arrived;
    // Appended while the first one is on its way: must not be lost when that one finishes.
    expect(await libraryApi.patch(lib().items[z.id]!, { note: '发送途中追加' })).toMatchObject({ ok: true, queued: true });
    items.gate = null;
    open();
    await flushLibrary();
    expect(items.calls.map((c) => c.split('@')[0])).toEqual([`patch:${x.id}`, `remove:${y.id}`, `patch:${z.id}`]);
    expect(items.items.get(z.id)!.note).toBe('发送途中追加');
    expect(lib().queued).toBe(0);
  });
});
