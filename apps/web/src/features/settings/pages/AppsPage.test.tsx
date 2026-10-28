import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { runUndo, useToastStore } from '../../../components/toast-store';
import { flush, resetSync } from '../../../data/config-store';
import { MemoryTransport } from '../../../data/transport';
import { AppsPage } from './AppsPage';

let server: MemoryTransport;

function open(path: string) {
  const router = createMemoryRouter([{ path: '/settings/apps', element: <AppsPage /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  resetSync(server);
  useToastStore.setState({ current: null });
});

describe('app editor (R2 · 表单手动保存)', () => {
  it('adds an app, completing the scheme on blur, and syncs it', async () => {
    const { router, user } = open('/settings/apps?new=Jellyfin');
    const dialog = await screen.findByRole('dialog', { name: '新增应用' });
    expect(screen.getByRole('textbox', { name: /名称/ })).toHaveValue('Jellyfin');
    const url = screen.getByRole('textbox', { name: /网址/ });
    await user.type(url, 'jellyfin.home');
    await user.tab();
    expect(url).toHaveValue('https://jellyfin.home');
    await user.click(screen.getByRole('button', { name: '添加' }));
    await flush();
    expect(server.config.apps.find((a) => a.id === 'jellyfin')?.url).toBe('https://jellyfin.home');
    expect(useToastStore.getState().current?.msg).toBe('已添加 Jellyfin');
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(router.state.location.search).toBe('');
  });

  it('blocks saving while a required field is missing', async () => {
    const { user } = open('/settings/apps?new=');
    await screen.findByRole('dialog', { name: '新增应用' });
    await user.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByText('请填写名称')).toBeInTheDocument();
    expect(screen.getByText('还有 2 项需要修正')).toBeInTheDocument();
    expect(server.calls).toHaveLength(0);
  });

  it('asks before discarding unsaved changes', async () => {
    const { user } = open('/settings/apps?edit=github');
    await screen.findByRole('dialog', { name: '编辑 GitHub' });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: /名称/ }), '!');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('有未保存的更改，确定放弃？')).toBeInTheDocument();
  });

  it('deletes after confirmation and can be undone', async () => {
    const { user } = open('/settings/apps?edit=github');
    await screen.findByRole('dialog', { name: '编辑 GitHub' });
    await user.click(screen.getByRole('button', { name: '删除' }));
    const confirm = await screen.findByRole('dialog', { name: '删除「GitHub」？' });
    expect(confirm).toHaveTextContent('它会从首页、全部应用和搜索结果中移除');
    await user.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!);
    await flush();
    expect(server.config.apps.some((a) => a.id === 'github')).toBe(false);
    runUndo(useToastStore.getState().current!);
    await flush();
    expect(server.config.apps.some((a) => a.id === 'github')).toBe(true);
    expect(server.config.pins[0]).toBe('github');
  });
});
