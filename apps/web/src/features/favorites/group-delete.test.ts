import { UNFILED, type Category, type Item, type Op } from '@nexus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, flush, resetLocal, useConfigStore } from '../../data/config-store';
import { libraryApi, loadLibrary, loadTrash, refileTrashed, useLibrary, type WriteOutcome } from '../../data/library';
import { memoryLocalStore } from '../../data/local/store';
import { localTransport, type LocalTransport } from '../../data/local/transport';
import { contentDeleteDone, contentDeletePlan, contentDeleteReport, runContentDelete, type ContentDeleteDeps } from './group-delete';

/**
 * 删除分组 › 连同内容删除 (spec 02 N4, 06 B09): a choice of its own whose favorites go to 回收站
 * first — every one of them — before any group is deleted; one that does not go stops it with no
 * group deleted, and says which ones are in 回收站. Restored, they come back to the deleted group's
 * parent (未分组 for a top-level group): what the server and the local engine do with tombstones of
 * a deleted group (apps/server/src/items/favorites.test.ts and packages/shared local-engine tests
 * lock the same place).
 */
const item = (id: string, folderId: string, over: Partial<Item> = {}): Item => ({ id, kind: 'page', source: 'manual', catalogId: null, title: id, url: `https://${id}.example.test`, folderId, tags: [], note: '', iconRef: '', version: 1, pinned: false, position: 1, createdAt: 1, updatedAt: 1, deletedAt: null, importId: null, ...over });
const groups: Category[] = [
  { id: 'work', label: '工作', locked: false, parentId: null },
  { id: 'proj', label: '项目', locked: false, parentId: 'work' },
  { id: 'docs', label: '资料', locked: false, parentId: 'proj' },
  { id: 'fe', label: '前端', locked: false, parentId: 'proj' },
  { id: 'life', label: '生活', locked: false, parentId: null },
  { id: 'none', label: '未分组', locked: true, parentId: null },
];
const items = [item('p1', 'proj', { position: 2 }), item('p0', 'proj', { position: 1 }), item('d1', 'docs'), item('f1', 'fe'), item('w1', 'work'), item('gone', 'docs', { deletedAt: 9 })];

describe('the plan: what 连同内容删除 would do, shown before anything is done', () => {
  it('every group below goes too, deepest first; live favorites in tree order; restored ones come back to the parent', () => {
    const plan = contentDeletePlan(groups, items, new Set(['d1']), 'proj')!;
    expect(plan.subgroups.map((g) => g.path)).toEqual(['工作 / 项目 / 资料', '工作 / 项目 / 前端']);
    expect(plan.items.map((i) => i.id)).toEqual(['p0', 'p1', 'd1', 'f1']);
    expect(plan.pinned).toBe(1);
    expect(plan.restoreTo).toEqual({ id: 'work', path: '工作' });
    expect(plan.ops).toEqual([
      { type: 'group.delete', groupId: 'fe' },
      { type: 'group.delete', groupId: 'docs' },
      { type: 'group.delete', groupId: 'proj' },
    ]);
  });
  it('a top-level group: restored favorites go to 未分组; locked groups and 未分组 have no such option', () => {
    expect(contentDeletePlan(groups, items, new Set(), 'work')!.restoreTo).toEqual({ id: UNFILED, path: '未分组' });
    expect(contentDeletePlan(groups, items, new Set(), 'none')).toBeNull();
    expect(contentDeletePlan([{ id: 'hosted', label: '我的服务', locked: true, parentId: null }], [], new Set(), 'hosted')).toBeNull();
  });
});

describe('the order: 回收站 first, all of it, then the groups', () => {
  const plan = contentDeletePlan(groups, items, new Set(), 'proj')!;
  const deps = (over: Partial<ContentDeleteDeps> = {}) => {
    const calls: string[] = [];
    const d: ContentDeleteDeps = {
      remove: vi.fn(async (i: Item): Promise<WriteOutcome> => {
        calls.push(`remove ${i.id}`);
        return { ok: true, item: { ...i, deletedAt: 5, version: i.version + 1 } };
      }),
      liveIn: () => [],
      deleteGroups: vi.fn((ops: Op[]) => {
        calls.push(`groups ${ops.map((o) => (o as { groupId: string }).groupId).join(',')}`);
        return { ok: true as const };
      }),
      ...over,
    };
    return { d, calls };
  };

  it('every favorite is in 回收站 before the groups are deleted (B09: nothing deleted for good)', async () => {
    const { d, calls } = deps();
    const r = await runContentDelete(plan, d);
    expect(calls).toEqual(['remove p0', 'remove p1', 'remove d1', 'remove f1', 'groups fe,docs,proj']);
    expect(r).toMatchObject({ ok: true, stayed: 0 });
    expect(r.ok && r.trashed.every((i) => i.deletedAt !== null)).toBe(true);
    expect(contentDeleteDone(plan, r as Extract<typeof r, { ok: true }>)).toBe('已删除分组「项目」及 2 个子分组；4 个收藏已移到回收站，恢复后放到「工作」');
  });

  it('one that does not go stops it: no group is deleted, and the message names what is in 回收站', async () => {
    let n = 0;
    const { d, calls } = deps({
      remove: async (i) => {
        calls.push(`remove ${i.id}`);
        return ++n === 3 ? { ok: false, code: 'REVISION_CONFLICT', message: '这条收藏在你上次看到之后被修改过，没有删除' } : { ok: true, item: { ...i, deletedAt: 5 } };
      },
    });
    const r = await runContentDelete(plan, d);
    expect(calls).toEqual(['remove p0', 'remove p1', 'remove d1']);
    expect(d.deleteGroups).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, stage: 'items', failed: { id: 'd1' }, left: 1, queued: false });
    const report = contentDeleteReport(plan, r as Exclude<typeof r, { ok: true }>);
    expect(report.title).toBe('没有全部完成，分组没有删除');
    expect(report.lines.join('\n')).toContain('「d1」没有移到回收站：这条收藏在你上次看到之后被修改过，没有删除');
    expect(report.lines.join('\n')).toContain('已移到回收站的 2 个：「p0」、「p1」（可以在回收站恢复，恢复后放到「工作」）');
    expect(report.lines.join('\n')).toContain('分组「项目」和它的 2 个子分组都没有删除；另外 1 个收藏还在原来的分组里。');
  });

  it('a removal only kept on this device (the connection dropped) is not 回收站 yet: it stops too', async () => {
    const { d } = deps({ remove: async (i) => (i.id === 'p0' ? { ok: true, queued: true } : { ok: true, item: i }) });
    const r = await runContentDelete(plan, d);
    expect(d.deleteGroups).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, stage: 'items', failed: { id: 'p0' }, queued: true, trashed: [] });
    expect(contentDeleteReport(plan, r as Exclude<typeof r, { ok: true }>).lines[1]).toBe('还没有收藏被移到回收站');
  });

  it('a thrown error stops it the same way', async () => {
    const { d } = deps({ remove: async () => Promise.reject(new Error('boom')) });
    const r = await runContentDelete(plan, d);
    expect(r).toMatchObject({ ok: false, stage: 'items', reason: 'boom' });
    expect(d.deleteGroups).not.toHaveBeenCalled();
  });

  it('all in 回收站 but the groups refused: said so, the groups are still there (empty)', async () => {
    const { d } = deps({ deleteGroups: () => ({ ok: false, reason: '分组不存在' }) });
    const r = await runContentDelete(plan, d);
    expect(r).toMatchObject({ ok: false, stage: 'groups', reason: '分组不存在' });
    expect(contentDeleteReport(plan, r as Exclude<typeof r, { ok: true }>).title).toBe('收藏都已移到回收站，但分组没有删除');
  });

  it('a favorite added to those groups meanwhile is not deleted with them (it was not in the preview)', async () => {
    const { d } = deps({ liveIn: () => [item('new', 'docs')] });
    const r = await runContentDelete(plan, d);
    expect(r).toMatchObject({ ok: true, stayed: 1 });
    expect(contentDeleteDone(plan, r as Extract<typeof r, { ok: true }>)).toContain('另有 1 个刚加入的收藏没有删除，已放到「工作」');
  });
});

describe('in a real space (the local collection: the same engine rules as the server)', () => {
  let store: ReturnType<typeof memoryLocalStore>;
  let t: LocalTransport;
  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network'))));
    store = memoryLocalStore('local:test-browser');
    t = localTransport({ store, bundledCatalog: async () => ({ catalogVersion: 'test', categories: [], items: [], nextCursor: null }) });
    useLibrary.setState({ status: 'idle', error: '', owner: null, items: {}, pins: [], folders: [], cursor: null, queued: 0, conflicts: [], trash: 'idle' });
    await resetLocal(t);
    expect(dispatch([
      { type: 'group.create', group: { id: 'arch', label: '归档', parentId: null } },
      { type: 'group.create', group: { id: 'proj', label: '项目', parentId: 'arch' } },
      { type: 'group.create', group: { id: 'docs', label: '资料', parentId: 'proj' } },
    ]).ok).toBe(true);
    await flush();
    await loadLibrary();
    for (const [title, folderId] of [['方案', 'proj'], ['手册', 'docs'], ['周报', 'arch']] as const) expect((await libraryApi.create({ title, url: `https://${encodeURIComponent(title)}.example.test`, folderId })).ok).toBe(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  const deps = (): ContentDeleteDeps => ({
    remove: (i) => libraryApi.remove(i),
    liveIn: (ids) => Object.values(useLibrary.getState().items).filter((i) => i.deletedAt === null && ids.has(i.folderId)),
    deleteGroups: (ops) => {
      const d = dispatch(ops);
      return d.ok ? { ok: true } : { ok: false, reason: d.error.message };
    },
  });
  const live = () => Object.values(useLibrary.getState().items).filter((i) => i.deletedAt === null);
  const byTitle = (title: string) => Object.values(useLibrary.getState().items).find((i) => i.title === title)!;

  it('both groups go, both favorites are in 回收站 — still there after reopening — and a restore lands in 归档', async () => {
    const categories = useConfigStore.getState().snapshot.config.categories;
    const plan = contentDeletePlan(categories, live(), new Set(), 'proj')!;
    expect(plan.items.map((i) => i.title)).toEqual(['方案', '手册']);
    const r = await runContentDelete(plan, deps());
    expect(r.ok).toBe(true);
    refileTrashed(categories, useConfigStore.getState().snapshot.config.categories);
    await flush();
    const stored = await store.read();
    expect(stored.doc.categories.map((c) => c.id)).not.toContain('proj');
    expect(stored.doc.categories.map((c) => c.id)).not.toContain('docs');
    // Reopened: the snapshot has live favorites only, 回收站 is read on its own.
    useLibrary.setState({ status: 'idle', owner: null, items: {} });
    await loadLibrary();
    expect(live().map((i) => i.title)).toEqual(['周报']);
    await loadTrash();
    const trashed = Object.values(useLibrary.getState().items).filter((i) => i.deletedAt !== null);
    expect(trashed.map((i) => i.title).sort()).toEqual(['手册', '方案']);
    // Their groups are gone: filed (quietly) under 归档, where a restore puts them.
    expect(trashed.every((i) => i.folderId === 'arch')).toBe(true);
    const back = await libraryApi.restore(byTitle('手册'));
    expect(back).toMatchObject({ ok: true, item: { folderId: 'arch', deletedAt: null } });
  });

  it('a top-level group: what is restored lands in 未分组', async () => {
    const categories = useConfigStore.getState().snapshot.config.categories;
    const r = await runContentDelete(contentDeletePlan(categories, live(), new Set(), 'arch')!, deps());
    expect(r).toMatchObject({ ok: true, trashed: [{ title: '周报' }, { title: '方案' }, { title: '手册' }] });
    await flush();
    expect((await libraryApi.restore(byTitle('方案'))).ok && byTitle('方案').folderId).toBe(UNFILED);
  });

  it('changed elsewhere since it was shown: that one is refused, nothing after it moves, no group is deleted', async () => {
    const categories = useConfigStore.getState().snapshot.config.categories;
    const plan = contentDeletePlan(categories, live(), new Set(), 'proj')!;
    // Another tab renames 手册 (the second one) after the preview.
    const handbook = byTitle('手册');
    await t.items.patch(handbook.id, { opId: 'other-tab-000001', baseVersion: handbook.version, patch: { title: '手册（新）' } });
    const r = await runContentDelete(plan, deps());
    expect(r).toMatchObject({ ok: false, stage: 'items', trashed: [{ title: '方案' }], failed: { id: handbook.id }, left: 0 });
    await flush();
    const stored = await store.read();
    expect(stored.doc.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['arch', 'proj', 'docs']));
    expect(stored.rows[handbook.id]).toMatchObject({ deletedAt: null, folderId: 'docs' });
  });

  it('保留内容 (the default) is unchanged: favorites move up, nothing goes to 回收站', async () => {
    expect(dispatch({ type: 'group.delete', groupId: 'proj' }).ok).toBe(true);
    await flush();
    const stored = await store.read();
    expect(Object.values(stored.rows).every((r) => r.deletedAt === null)).toBe(true);
    expect(Object.values(stored.rows).find((r) => r.title === '方案')!.folderId).toBe('arch');
  });
});
