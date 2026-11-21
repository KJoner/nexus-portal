import type { PairingRequest } from '@nexus/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../../components/toast-store';
import { refresh, resetSync, useConfigStore } from '../../../data/config-store';
import { MemoryTransport } from '../../../data/transport';
import { AccountSection } from './AccountSection';
import { AppEditor } from './AppEditor';
import { DevicesSection } from './DevicesSection';
import { SearchPage } from './SearchPage';

/**
 * v0.4 account UI. The server enforces every rule; these check what people are offered: operator
 * tools only for the administrator, least privilege when approving an extension, and both ways out.
 */
let server: MemoryTransport;

function open(element: React.ReactNode, path = '/settings/data') {
  const router = createMemoryRouter([{ path: '/settings/:page?', element }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return userEvent.setup();
}

async function signInAs(role: 'admin' | 'user', session: 'password' | 'oidc' = role === 'admin' ? 'password' : 'oidc') {
  server.account = { id: role === 'admin' ? 'legacy-admin' : 'u-member', role, session, canLinkIdentity: role === 'admin' && session === 'password' && server.options.oidc };
  resetSync(server, server.account.id);
  await refresh();
}

beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  useToastStore.setState({ current: null });
});

describe('operator tools are offered to the administrator only', () => {
  it('another account sees no Linkwarden and never asks the server about it', async () => {
    const status = vi.spyOn(server, 'linkwarden');
    await signInAs('user');
    open(<SearchPage />, '/settings/search');
    await screen.findByRole('heading', { name: '搜索' });
    expect(screen.queryByText(/Linkwarden/)).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });

  it('the administrator keeps them', async () => {
    await signInAs('admin');
    open(<SearchPage />, '/settings/search');
    expect((await screen.findAllByText(/Linkwarden/)).length).toBeGreaterThan(0);
  });

  it.each([
    ['user', false],
    ['admin', true],
  ] as const)('health checks on a self-hosted service: offered to %s → %s', async (role, offered) => {
    await signInAs(role);
    open(<AppEditor appId={null} initialName="Jellyfin" initialUrl="https://jellyfin.example.org" onClose={() => undefined} onDelete={() => undefined} />, '/settings/apps');
    await screen.findByRole('textbox', { name: /名称/ });
    await userEvent.setup().click(screen.getByRole('radio', { name: /自托管服务/ }));
    expect(!!screen.queryByRole('switch', { name: '健康检查' })).toBe(offered);
  });
});

describe('approving a browser extension', () => {
  const request: PairingRequest = { code: 'ABCD-EFGH', name: 'Chrome 扩展', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Chrome/140', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), scopes: ['config:read', 'items:read', 'items:write', 'pins:write'] };

  it('shows what it asks for, and grants only what stays switched on', async () => {
    const decide = vi.fn(async () => undefined);
    server.pairingRequest = async () => request;
    server.decidePairing = decide;
    await signInAs('admin');
    const user = open(<DevicesSection />, '/settings/data?pair=ABCD-EFGH');
    const dialog = await screen.findByRole('dialog', { name: /允许「Chrome 扩展」连接/ });
    const asked = within(dialog).getByLabelText('申请的权限');
    expect(asked).toHaveTextContent('读取首页导航与外观');
    expect(asked).toHaveTextContent('添加、编辑和删除我的收藏');
    await user.click(within(asked).getByRole('switch', { name: '添加、编辑和删除我的收藏' }));
    await user.click(within(dialog).getByRole('button', { name: '连接码一致，允许连接' }));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide).toHaveBeenCalledWith('ABCD-EFGH', true, ['config:read', 'items:read', 'pins:write']);
  });

  it('an old extension that names no scopes is approved read-only', async () => {
    const decide = vi.fn(async () => undefined);
    server.pairingRequest = async () => ({ ...request, scopes: undefined });
    server.decidePairing = decide;
    await signInAs('admin');
    const user = open(<DevicesSection />, '/settings/data?pair=ABCD-EFGH');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('switch')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: '连接码一致，允许连接' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('ABCD-EFGH', true, ['config:read']));
  });
});

describe('账号与登录', () => {
  it('the administrator signed in with the password is offered the claim', async () => {
    server.options = { oidc: true, legacyPassword: true, registration: 'invite', accountUrl: 'https://id.example.org/realms/accounts/account' };
    await signInAs('admin', 'password');
    const user = open(<AccountSection />);
    await user.click(await screen.findByRole('button', { name: /绑定/ }));
    expect(await screen.findByRole('dialog', { name: '绑定统一账号？' })).toHaveTextContent('访问密码登录随之关闭');
  });

  it('a unified account gets the account console, and no claim', async () => {
    server.options = { oidc: true, legacyPassword: false, registration: 'open', accountUrl: 'https://id.example.org/realms/accounts/account' };
    await signInAs('user');
    open(<AccountSection />);
    expect(await screen.findByRole('link', { name: /打开账号中心/ })).toHaveAttribute('href', 'https://id.example.org/realms/accounts/account');
    expect(screen.queryByRole('button', { name: /绑定/ })).toBeNull();
  });

  it('退出全部设备 asks first, explains the limit, then ends everything of the account', async () => {
    server.options = { oidc: true, legacyPassword: false, registration: 'open', accountUrl: 'https://id.example.org/realms/accounts/account' };
    await signInAs('user');
    const user = open(<AccountSection />);
    await user.click(await screen.findByRole('button', { name: /全部退出/ }));
    const dialog = await screen.findByRole('dialog', { name: '退出全部设备？' });
    expect(dialog).toHaveTextContent('其他浏览器如果仍登录着账号中心');
    expect(server.loggedOutAll).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: '全部退出' }));
    await waitFor(() => expect(server.loggedOutAll).toBe(1));
    expect(useConfigStore.getState().auth).toBe('anonymous');
  });
});
