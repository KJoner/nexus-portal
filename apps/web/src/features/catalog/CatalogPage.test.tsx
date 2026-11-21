import { newUserConfig, servedCatalog } from '@nexus/shared';
import { CATALOG } from '@nexus/shared/catalog-data';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../../components/toast-store';
import { flush, refresh, resetSync } from '../../data/config-store';
import { MemoryTransport } from '../../data/transport';
import { resetCatalog } from './catalog-store';
import CatalogPage, { customAddPath } from './CatalogPage';

let server: MemoryTransport;

function open(path = '/catalog') {
  const router = createMemoryRouter(
    [
      { path: '/catalog', element: <CatalogPage /> },
      { path: '/settings/apps', element: <p>编辑器</p> },
      { path: '/', element: <p>首页</p> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

const card = (name: string) => screen.getByRole('checkbox', { name: `选择 ${name}` }).closest('li')!;

beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  server.catalogData = { catalogVersion: CATALOG.catalogVersion, categories: CATALOG.categories.map((c) => ({ ...c, count: 1 })), items: servedCatalog(CATALOG, { NEXUS_LITESYNC_URL: 'https://sync.example.net' }), nextCursor: null };
  resetSync(server);
  resetCatalog();
  useToastStore.setState({ current: null });
});

describe('应用目录页', () => {
  it('marks what the collection already has and offers the rest', async () => {
    open();
    await screen.findByRole('checkbox', { name: '选择 知乎' });
    // The seed already has GitHub (same address) and 哔哩哔哩 (same site, without www.).
    expect(within(card('GitHub')).getByText('已在收藏库')).toBeInTheDocument();
    expect(within(card('哔哩哔哩')).getByText('已在收藏库')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 GitHub' })).toBeDisabled();
    expect(within(card('知乎')).getByRole('button', { name: '添加 知乎' })).toBeInTheDocument();
  });

  it('adds one template to 未分类 without pinning, and shows it as added', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: '添加 知乎' }));
    await flush();
    const app = server.config.apps.find((a) => a.catalogId === 'zhihu')!;
    expect(app).toMatchObject({ name: '知乎', url: 'https://www.zhihu.com', categoryId: 'none', kind: 'site' });
    expect(server.config.pins).not.toContain(app.id);
    expect(useToastStore.getState().current?.msg).toBe('已把「知乎」加入「未分类」');
    await waitFor(() => expect(within(card('知乎')).getByText('已添加')).toBeInTheDocument());
  });

  it('pins only when 同时固定到首页 is ticked', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('checkbox', { name: '同时固定到首页' }));
    await user.click(screen.getByRole('button', { name: '添加 豆瓣' }));
    await flush();
    expect(server.config.pins).toContain(server.config.apps.find((a) => a.catalogId === 'douban')!.id);
  });

  it('adds several at once into the chosen group', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('checkbox', { name: '选择 知乎' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 豆瓣' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '添加到分组' }), 'work');
    const bar = screen.getByRole('region', { name: '批量添加' });
    expect(bar).toHaveTextContent('已选 2 个网站 · 加入「工作」');
    await user.click(within(bar).getByRole('button', { name: '添加 2 项' }));
    await flush();
    expect(server.config.apps.filter((a) => a.catalogId === 'zhihu' || a.catalogId === 'douban').map((a) => a.categoryId)).toEqual(['work', 'work']);
    expect(screen.queryByRole('region', { name: '批量添加' })).not.toBeInTheDocument();
  });

  it('finds templates by Chinese name, alias, English name and domain, and filters by category', async () => {
    const { user } = open();
    const search = await screen.findByRole('textbox', { name: '搜索应用目录' });
    await user.type(search, 'b站');
    expect(screen.getByRole('checkbox', { name: '选择 哔哩哔哩' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'ycombinator');
    expect(screen.getByRole('checkbox', { name: '选择 Hacker News' })).toBeInTheDocument();
    await user.clear(search);
    await user.click(screen.getByRole('button', { name: /^邮箱/ }));
    expect(screen.getByRole('checkbox', { name: '选择 Gmail' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择 知乎' })).not.toBeInTheDocument();
  });

  it('offers 自定义添加 when nothing matches', async () => {
    const { router, user } = open('/catalog?q=没有这个网站');
    await user.click(await screen.findByRole('button', { name: '自定义添加' }));
    expect(router.state.location.pathname).toBe('/settings/apps');
    expect(new URLSearchParams(router.state.location.search).get('new')).toBe('没有这个网站');
    expect(customAddPath('docs.example.org/guide')).toBe(`/settings/apps?new=docs.example.org&url=${encodeURIComponent('https://docs.example.org/guide')}`);
  });

  it('offers a skippable starter pick to an empty collection, with nothing pre-selected', async () => {
    server.config = newUserConfig();
    resetSync(server);
    await refresh();
    const { user } = open();
    const starter = await screen.findByRole('region', { name: '从常用网站开始' });
    expect(within(starter).getByRole('button', { name: '先勾选网站' })).toBeDisabled();
    await user.click(within(starter).getByRole('button', { name: /ChatGPT/ }));
    await user.click(within(starter).getByRole('button', { name: /GitHub/ }));
    await user.click(within(starter).getByRole('button', { name: '加入所选 2 个' }));
    await flush();
    expect(server.config.apps.map((a) => a.catalogId)).toEqual(['chatgpt', 'github']);
    expect(server.config.pins).toEqual([]);
  });

  it('lets a new account skip the starter pick', async () => {
    server.config = newUserConfig();
    resetSync(server);
    await refresh();
    const { user } = open();
    const starter = await screen.findByRole('region', { name: '从常用网站开始' });
    await user.click(within(starter).getByRole('button', { name: '跳过' }));
    expect(screen.queryByRole('region', { name: '从常用网站开始' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加 知乎' })).toBeInTheDocument();
  });

  it('shows an error with a retry instead of a blank page', async () => {
    server.online = false;
    const { user } = open();
    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接 Nexus 服务端');
    server.online = true;
    await user.click(screen.getByRole('button', { name: /重试/ }));
    expect(await screen.findByRole('checkbox', { name: '选择 知乎' })).toBeInTheDocument();
  });
});
