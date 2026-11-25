import { AppSchema, localCounts } from '@nexus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, flush, resetLocal, useConfigStore, useIsAdmin, useSaveState, workspaceOwner } from './config-store';
import { libraryApi, loadLibrary, loadTrash, useLibrary } from './library';
import { memoryLocalStore } from './local/store';
import { localTransport, type LocalTransport } from './local/transport';
import { renderHook } from '@testing-library/react';

/**
 * 本地收藏 in the portal (v0.5 · U1): the same pages, over this browser's own store. What a person
 * relies on: saving needs no account and no server, a save is only reported once it is stored,
 * a failed save is kept (never dropped), and nothing of it reaches an account or the network.
 */
let store: ReturnType<typeof memoryLocalStore>;
let t: LocalTransport;
const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in a local collection')));

const site = (id: string, name: string) => AppSchema.parse({ id, name, url: `https://${id}.example.com`, kind: 'site', categoryId: 'common', icon: { source: 'auto', ref: '', letter: '', tone: 0 } });

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  store = memoryLocalStore('local:test-browser');
  t = localTransport({ store, bundledCatalog: async () => ({ catalogVersion: 'test', categories: [], items: [], nextCursor: null }) });
  useLibrary.setState({ status: 'idle', error: '', owner: null, items: {}, pins: [], folders: [], cursor: null, queued: 0, conflicts: [] });
  await resetLocal(t);
});

afterEach(() => vi.unstubAllGlobals());

describe('local collection in the portal', () => {
  it('a site added on the home page is stored in this browser, with no request to any server', async () => {
    const r = dispatch([{ type: 'app.upsert', app: site('docs', '文档'), base: null }, { type: 'pin.add', appId: 'docs' }]);
    expect(r.ok).toBe(true);
    await flush();
    expect(useConfigStore.getState().pending).toEqual([]);
    const s = await store.read();
    expect(localCounts(s)).toMatchObject({ items: 1, pins: 1 });
    expect(useConfigStore.getState().snapshot.config.pins).toEqual(['docs']);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing of it goes into an account's cache.
    expect(Object.keys(localStorage).filter((k) => k.startsWith('nexus.cache.'))).toEqual([]);
  });

  it('saves in 收藏库 are keyed by the local collection, and a page saved without pinning stays findable', async () => {
    expect(workspaceOwner()).toBe('local:test-browser');
    await loadLibrary();
    const r = await libraryApi.create({ title: '一篇长文', url: 'https://read.example.com/a?b=1' });
    expect(r.ok).toBe(true);
    expect(Object.values(useLibrary.getState().items).map((i) => i.title)).toEqual(['一篇长文']);
    expect(useConfigStore.getState().snapshot.config.apps).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a change the browser refuses to store stays on screen and queued, and is not reported as saved', async () => {
    store.failNext = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    dispatch({ type: 'app.upsert', app: site('kept', '保留'), base: null });
    await flush();
    const st = useConfigStore.getState();
    expect(st.pending).toHaveLength(1);
    expect(st.storageError).toMatch(/存储空间不足/);
    expect(st.snapshot.config.apps.map((a) => a.id)).toEqual(['kept']);
    expect(renderHook(() => useSaveState()).result.current.kind).toBe('error');
    // The next attempt stores it; the error goes away.
    await flush();
    expect(useConfigStore.getState().pending).toEqual([]);
    expect(useConfigStore.getState().storageError).toBeNull();
    expect(localCounts(await store.read()).items).toBe(1);
  });

  it('a local collection is never the operator: no administrator tools', () => {
    localStorage.setItem('nexus.account.v1', JSON.stringify({ id: 'legacy-admin', role: 'admin' }));
    expect(renderHook(() => useIsAdmin()).result.current).toBe(false);
  });

  it('another page of this browser changing the collection shows up here', async () => {
    // As the extension's popup or another tab would: a write straight to the store.
    await t.items.create({ opId: 'popup-000000001', item: { title: '从别处保存', url: 'https://elsewhere.example.com' }, pinToHome: true });
    await (await import('./config-store')).refresh();
    expect(useConfigStore.getState().snapshot.config.apps.map((a) => a.name)).toEqual(['从别处保存']);
  });

  it('回收站 after reopening still lists what was deleted before (the snapshot has live favorites only)', async () => {
    await loadLibrary();
    const made = await libraryApi.create({ title: '旧文章', url: 'https://old.example.test/a' });
    if (!made.ok || !made.item) throw new Error('not saved');
    expect((await libraryApi.remove(made.item)).ok).toBe(true);
    // Opened again: nothing deleted in the snapshot…
    useLibrary.setState({ status: 'idle', owner: null, items: {} });
    await loadLibrary();
    expect(useLibrary.getState().trash).toBe('idle');
    expect(Object.values(useLibrary.getState().items).filter((i) => i.deletedAt !== null)).toEqual([]);
    // …and 回收站, read on its own, has it back.
    await loadTrash();
    expect(useLibrary.getState().trash).toBe('ready');
    expect(Object.values(useLibrary.getState().items).filter((i) => i.deletedAt !== null).map((i) => i.title)).toEqual(['旧文章']);
  });
});
