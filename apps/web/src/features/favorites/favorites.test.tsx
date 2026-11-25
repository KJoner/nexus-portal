import { servedCatalog, type Category, type Item } from '@nexus/shared';
import { CATALOG } from '@nexus/shared/catalog-data';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../components/toast-store';
import { refresh, resetSync, useConfigStore } from '../../data/config-store';
import { libraryApi, useLibrary } from '../../data/library';
import { MemoryTransport } from '../../data/transport';
import { SpaceBadge } from '../account/SpaceBadge';
import { resetCatalog, useCatalog } from '../catalog/catalog-store';
import { AddFavoriteDialog } from './AddFavoriteDialog';
import { useFavoriteDialogs } from './dialog-store';
import { draftOf, FavoriteEditor, patchOf, validate } from './FavoriteEditor';
import { canReorder, groupCounts, inView, matches, pathLabel, sortItems } from './model';
import { LegacyCatalogRedirect, LegacyLibraryRedirect } from './redirects';

/**
 * 我的收藏 (UI v2 · v12.0.3 N1–N4) — what the page does with the data contract: views and counts,
 * one save with only what changed (long text never cut), refusals said as they are (nothing half
 * saved), one primary action in 添加收藏, old links, and a status pill that never names the account.
 */
const item = (id: string, over: Partial<Item> = {}): Item => ({ id, kind: 'app', source: 'manual', catalogId: null, title: id, url: `https://${id}.example.org`, folderId: 'none', tags: [], note: '', iconRef: '', version: 1, pinned: false, position: 1, createdAt: 1, updatedAt: 1, deletedAt: null, importId: null, ...over });
const groups: Category[] = [
  { id: 'work', label: '工作', locked: false, parentId: null },
  { id: 'dev', label: '开发', locked: false, parentId: 'work' },
  { id: 'docs', label: '资料', locked: false, parentId: 'dev' },
  { id: 'life', label: '生活', locked: false, parentId: null },
  { id: 'docs2', label: '资料', locked: false, parentId: 'life' },
  { id: 'none', label: '未分组', locked: true, parentId: null },
];

let server: MemoryTransport;
beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  useToastStore.setState({ current: null });
  useFavoriteDialogs.setState({ add: null, edit: null });
  resetCatalog();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('views, counts and orders', () => {
  const items = [item('a', { folderId: 'work' }), item('b', { folderId: 'dev', tags: ['前端'] }), item('c', { folderId: 'docs' }), item('d', { folderId: 'docs2' }), item('e', { deletedAt: 5 })];
  it('counts direct and total per group; same-name leaves under different parents stay apart (B08)', () => {
    const live = items.filter((i) => !i.deletedAt);
    const { direct, total } = groupCounts(groups, live);
    expect(direct.get('work')).toBe(1);
    expect(total.get('work')).toBe(3);
    expect(total.get('docs')).toBe(1);
    expect(total.get('docs2')).toBe(1);
    expect(pathLabel(groups, 'docs')).toBe('工作 / 开发 / 资料');
    expect(pathLabel(groups, 'docs2')).toBe('生活 / 资料');
  });
  it('a group shows its own favorites; 包含子分组 adds every level below', () => {
    const ctx = { pins: new Set<string>(), categories: groups };
    expect(items.filter((i) => inView(i, { kind: 'group', id: 'work' }, { ...ctx, withSub: false })).map((i) => i.id)).toEqual(['a']);
    expect(items.filter((i) => inView(i, { kind: 'group', id: 'work' }, { ...ctx, withSub: true })).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(items.filter((i) => inView(i, { kind: 'trash' }, { ...ctx, withSub: false })).map((i) => i.id)).toEqual(['e']);
  });
  it('search covers tags and addresses; manual order only where one group owns it (B10)', () => {
    expect(matches(items[1]!, '前端', null)).toBe(true);
    expect(matches(items[2]!, 'c.example', null)).toBe(true);
    expect(canReorder({ kind: 'group', id: 'work' }, 'manual', '', false)).toBe(true);
    expect(canReorder({ kind: 'group', id: 'work' }, 'manual', '', true)).toBe(false);
    expect(canReorder({ kind: 'all' }, 'manual', '', false)).toBe(false);
    expect(canReorder({ kind: 'group', id: 'work' }, 'name', '', false)).toBe(false);
    const g = [item('x', { folderId: 'work', position: 3, title: 'B' }), item('y', { folderId: 'work', position: 1, title: 'C' }), item('z', { folderId: 'work', position: 2, title: 'A' })];
    expect(sortItems(g, 'manual', { pins: [], categories: groups, view: { kind: 'group', id: 'work' } }).map((i) => i.id)).toEqual(['y', 'z', 'x']);
    expect(sortItems(g, 'name', { pins: [], categories: groups, view: { kind: 'group', id: 'work' } }).map((i) => i.id)).toEqual(['z', 'x', 'y']);
  });
});

describe('the unified editor saves only what changed, in one call', () => {
  const long = item('long', { title: '长'.repeat(200), note: '记'.repeat(2000), folderId: 'work', app: { aliases: ['旧'] } });
  it('changing only the icon sends only the icon: a 200-character title and 2000-character note are untouched (B03)', () => {
    const from = draftOf(long, false);
    const p = patchOf(from, { ...from, icon: { source: 'letter', ref: '', letter: 'L', tone: 2 } }, long);
    expect(p).toEqual({ app: { icon: { source: 'letter', ref: '', letter: 'L', tone: 2 } } });
    expect(validate(from)).toEqual({});
  });
  it('basic, more and service options together are one patch (B01, B02)', () => {
    const from = draftOf(long, false);
    const p = patchOf(from, { ...from, title: '新名字', folderId: 'dev', pin: true, aliases: ['旧', '新'], openIn: 'new', service: true, lanUrl: 'http://10.0.0.2:8096' }, { ...long, kind: 'page' });
    expect(p).toMatchObject({ title: '新名字', folderId: 'dev', pin: true, kind: 'app', app: { aliases: ['旧', '新'], openIn: 'new', kind: 'service', lanUrl: 'http://10.0.0.2:8096' } });
  });

  async function openEditor(it: Item) {
    resetSync(server, 'legacy-admin');
    server.account = { id: 'legacy-admin', role: 'admin', session: 'password', canLinkIdentity: false };
    await refresh();
    useConfigStore.setState((s) => ({ snapshot: { ...s.snapshot, config: { ...s.snapshot.config, categories: groups } } }));
    useLibrary.setState({ status: 'ready', owner: 'test', items: { [it.id]: it }, pins: [], folders: [] });
    useFavoriteDialogs.setState({ edit: it.id, add: null });
    const router = createMemoryRouter([{ path: '*', element: <FavoriteEditor /> }]);
    render(<RouterProvider router={router} />);
    return userEvent.setup();
  }

  it('a field changed elsewhere saves nothing, keeps what was typed and offers both ways (B05)', async () => {
    const current = { ...long, title: '别处改的', version: 2 };
    const save = vi.spyOn(libraryApi, 'saveFavorite').mockResolvedValue({ ok: false, code: 'FIELD_CONFLICT', message: '冲突', details: { conflictFields: ['title'], item: current } });
    const user = await openEditor(long);
    const name = await screen.findByRole('textbox', { name: /名称/ });
    await user.clear(name);
    await user.type(name, '我的名字');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(save).toHaveBeenCalledTimes(1);
    const alert = await screen.findByText('这条收藏在别处被改过，这次没有保存');
    expect(alert).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /名称/ }) as HTMLInputElement).value).toBe('我的名字');
    save.mockResolvedValue({ ok: true });
    await user.click(screen.getByRole('button', { name: '用我的修改覆盖' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0].version).toBe(2);
    expect(save.mock.calls[1]![1]).toEqual({ title: '我的名字' });
  });

  it('a refused pin saves nothing and says so; the dialog stays open (B04)', async () => {
    vi.spyOn(libraryApi, 'saveFavorite').mockResolvedValue({ ok: false, code: 'QUOTA_EXCEEDED', message: 'full' });
    const user = await openEditor(item('p', { folderId: 'work' }));
    await user.click(await screen.findByRole('switch', { name: '固定到首页' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/这次没有保存任何修改/)).toBeTruthy();
    expect(useFavoriteDialogs.getState().edit).toBe('p');
    expect(useToastStore.getState().current).toBeNull();
  });
});

describe('添加收藏 has one primary action', () => {
  it('picking from 应用商店 turns the left side into the list, and 返回手动填写 brings the form back (C02, C03)', async () => {
    server.catalogData = { catalogVersion: CATALOG.catalogVersion, categories: CATALOG.categories.map((c) => ({ ...c, count: 1 })), items: servedCatalog(CATALOG, {}), nextCursor: null };
    resetSync(server);
    await refresh();
    useLibrary.setState({ status: 'ready', owner: 'test', items: {}, pins: [], folders: [] });
    await act(() => useCatalog.getState().load());
    window.innerWidth = 1440;
    window.innerHeight = 960;
    useFavoriteDialogs.setState({ add: { tab: 'manual', q: '', title: '', url: '' } });
    const router = createMemoryRouter([{ path: '*', element: <AddFavoriteDialog /> }]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: /网址/ }), 'https://docs.example.org');
    expect(screen.getByRole('button', { name: '添加这个收藏' })).toBeTruthy();
    const store = screen.getByRole('region', { name: '应用商店' });
    await user.click(within(store).getAllByRole('button', { name: /^选择 / })[0]!);
    expect(screen.getByRole('button', { name: '添加 1 个网站' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添加这个收藏' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /返回手动填写/ }));
    expect((screen.getByRole('textbox', { name: /网址/ }) as HTMLInputElement).value).toBe('https://docs.example.org');
  });
});

describe('old links land on the same task', () => {
  const where = async (path: string, element: React.ReactNode) => {
    const router = createMemoryRouter(
      [
        { path: path.split('?')[0]!, element },
        { path: '/settings/favorites', element: <p>我的收藏</p> },
      ],
      { initialEntries: [path] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText('我的收藏');
    return router.state.location;
  };
  it('/catalog?q= opens 添加收藏 › 应用商店 with the search kept', async () => {
    const at = await where('/catalog?q=bili', <LegacyCatalogRedirect />);
    expect(at.pathname).toBe('/settings/favorites');
    expect(new URLSearchParams(at.search).get('add')).toBe('store');
    expect(new URLSearchParams(at.search).get('sq')).toBe('bili');
  });
  it('/library?edit=<id> opens the editor of that favorite', async () => {
    const at = await where('/library?edit=abc', <LegacyLibraryRedirect />);
    expect(new URLSearchParams(at.search).get('edit')).toBe('abc');
  });
});

describe('the status pill says where changes stand, never who is signed in (C11)', () => {
  const pill = () => {
    const router = createMemoryRouter([{ path: '*', element: <SpaceBadge variant="desktop" /> }]);
    render(<RouterProvider router={router} />);
    return screen.getByRole('link');
  };
  it('account, all confirmed: 已同步 — and no e-mail, nickname or login name anywhere', async () => {
    server.account = { id: 'u-member', role: 'user', session: 'oidc', canLinkIdentity: false, email: 'someone@example.test', displayName: '小林', username: 'xiaolin_login' };
    resetSync(server, 'u-member');
    await refresh();
    // The account really carries all three (the page could show them), so their absence below means something.
    expect(useConfigStore.getState().account?.account).toMatchObject({ email: 'someone@example.test', displayName: '小林', username: 'xiaolin_login' });
    const el = pill();
    expect(el.textContent).toBe('已同步');
    const all = `${el.textContent} ${el.getAttribute('aria-label')} ${el.getAttribute('title')}`;
    for (const who of ['someone@example.test', '小林', 'xiaolin_login']) expect(all).not.toContain(who);
  });
  it('offline is 离线, never 已同步; changes waiting are 待同步', async () => {
    resetSync(server, 'u-member');
    await refresh();
    useConfigStore.setState({ online: false });
    pill();
    expect(screen.getByRole('link').textContent).toBe('离线');
    cleanup();
    localStorage.setItem(`nexus.library.queue.v1:u-member`, JSON.stringify([{ opId: 'x', kind: 'patch' }]));
    useConfigStore.setState({ online: false, account: { account: { id: 'u-member' } } as never });
    pill();
    expect(screen.getByRole('link').textContent).toBe('待同步');
  });
});
