import type { PairingRequest } from '@nexus/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../../components/toast-store';
import { refresh, resetSync, useConfigStore } from '../../../data/config-store';
import { MemoryTransport } from '../../../data/transport';
import { LoginPage } from '../../auth/LoginPage';
import { AccountSection } from './AccountSection';
import { AdminAccountsSection } from './AdminAccountsSection';
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
  sessionStorage.clear();
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
    // The account center only signs out browsers: the row must not promise devices, and says where those are (stage, 2026-11-22).
    expect(screen.getByText(/各浏览器里的登录/)).toHaveTextContent('那里不列已连接的浏览器扩展与 Obsidian');
    expect(screen.getByText(/各浏览器里的登录/)).toHaveTextContent('退出所有产品与设备');
    expect(screen.queryByText(/查看并退出各设备上的登录/)).toBeNull();
  });

  it('退出 Nexus 的全部设备 (动作 B) asks first, says what it leaves alone, then ends everything of the account in Nexus', async () => {
    server.options = { oidc: true, legacyPassword: false, registration: 'open', accountUrl: 'https://id.example.org/realms/accounts/account' };
    await signInAs('user');
    const user = open(<AccountSection />);
    await user.click(await screen.findByRole('button', { name: /全部退出/ }));
    const dialog = await screen.findByRole('dialog', { name: '退出 Nexus 的全部设备？' });
    expect(dialog).toHaveTextContent('已批准但扩展还没领取的授权');
    expect(dialog).toHaveTextContent('账号中心与 LiteSync 不受影响');
    expect(server.loggedOutAll).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: '全部退出' }));
    await waitFor(() => expect(server.loggedOutAll).toBe(1));
    expect(server.revokedEverywhere).toBe(0);
    expect(useConfigStore.getState().auth).toBe('anonymous');
  });

  it('退出所有产品与设备 (动作 C) is a separate action, lists its three steps, and the login page shows each part as it really ended', async () => {
    server.options = { oidc: true, legacyPassword: false, registration: 'open', accountUrl: 'https://id.example.org/realms/accounts/account' };
    server.everywhere = {
      ok: false,
      local: { state: 'done', revokedSessions: 2, revokedDevices: 1, revokedGrants: 1 },
      identityCenter: { state: 'failed', error: 'forbidden', accountUrl: 'https://id.example.org/realms/accounts/account' },
      peers: [{ product: 'litesync', state: 'pending', eventId: 'e'.repeat(32), attempts: 1, nextAttemptAt: new Date(Date.now() + 5000).toISOString(), error: 'network', result: null }],
    };
    await signInAs('user');
    const user = open(<AccountSection />);
    await user.click(await screen.findByRole('button', { name: /退出所有产品/ }));
    const dialog = await screen.findByRole('dialog', { name: '退出所有产品与设备？' });
    expect(dialog).toHaveTextContent('账号中心：结束你在所有浏览器的账号中心登录');
    expect(dialog).toHaveTextContent('LiteSync：通知它撤销你的网页登录、Obsidian 设备');
    await user.click(within(dialog).getByRole('button', { name: '退出所有产品' }));
    await waitFor(() => expect(server.revokedEverywhere).toBe(1));
    expect(server.loggedOutAll).toBe(0);
    expect(useConfigStore.getState().auth).toBe('anonymous');
    cleanup();
    render(<LoginPage />);
    const result = await screen.findByRole('region', { name: '退出所有产品与设备的结果' });
    expect(result).toHaveTextContent('已退出 Nexus；其余部分见下方');
    expect(result).not.toHaveTextContent('已退出所有产品与设备');
    expect(result).toHaveTextContent('Nexus：已完成，结束 2 个网页登录，撤销 1 台已连接的扩展和 1 个尚未领取的扩展授权');
    expect(result).toHaveTextContent('账号中心：没有完成');
    expect(result).toHaveTextContent('LiteSync：还没有确认（已尝试 1 次，连不上对方的服务端）');
    expect(within(result).getByRole('link', { name: /账号中心/ })).toHaveAttribute('href', 'https://id.example.org/realms/accounts/account');
    await userEvent.setup().click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByRole('region', { name: '退出所有产品与设备的结果' })).toBeNull();
  });

  it('shows the real state of earlier cross-product revocations, and resends one that did not arrive', async () => {
    server.options = { oidc: true, legacyPassword: false, registration: 'open', accountUrl: 'https://id.example.org/realms/accounts/account' };
    const at = new Date(Date.now() - 60_000).toISOString();
    server.revocations = {
      peer: { product: 'litesync', configured: true },
      identityCenter: { configured: true, accountUrl: null },
      centralCheck: { configured: true },
      events: [
        { eventId: 'a'.repeat(32), direction: 'outgoing', product: 'litesync', reason: 'user-request', state: 'failed', attempts: 9, nextAttemptAt: null, error: 'signature_rejected', result: null, createdAt: at, deliveredAt: null },
        { eventId: 'b'.repeat(32), direction: 'incoming', product: 'litesync', reason: 'user-request', state: 'applied', attempts: null, nextAttemptAt: null, error: null, result: 'applied', createdAt: at, deliveredAt: null },
      ],
    };
    await signInAs('user');
    const user = open(<AccountSection />);
    expect(await screen.findByText(/LiteSync：没有送达（对方拒绝了签名/)).toBeInTheDocument();
    expect(screen.getByText('在 LiteSync 中执行的「退出所有产品与设备」')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新发送' }));
    await waitFor(() => expect(server.retried).toEqual(['a'.repeat(32)]));
    expect(await screen.findByText(/LiteSync：已送达/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新发送' })).toBeNull();
  });

  it('says so when this deployment cannot reach LiteSync at all', async () => {
    server.options = { oidc: true, legacyPassword: false, registration: 'open', accountUrl: null };
    server.revocations = { ...server.revocations, peer: { product: 'litesync', configured: false } };
    await signInAs('user');
    const user = open(<AccountSection />);
    expect(await screen.findByText(/本部署没有配置跨产品撤销：LiteSync 不会收到通知/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /退出所有产品/ }));
    expect(await screen.findByRole('dialog', { name: '退出所有产品与设备？' })).toHaveTextContent('第 3 步不会发生');
  });

  it('the administrator sees whether cross-product revocation and the central check are configured, and what is wrong', async () => {
    server.options = { oidc: true, legacyPassword: true, registration: 'invite', accountUrl: null };
    server.adminStatus = { oidc: true, peer: { configured: true, product: 'litesync', pending: 1, failed: 2, lastError: 'signature_rejected', lastDeliveredAt: null }, centralCheck: { configured: false, lastError: null, lastErrorAt: null, lastSuccessAt: null } };
    await signInAs('admin', 'password');
    open(<AdminAccountsSection />);
    expect(await screen.findByText('跨产品撤销：已配置')).toBeInTheDocument();
    expect(screen.getByText(/失败 2 条；最近的问题：对方拒绝了签名：两边的撤销密钥不一致/)).toBeInTheDocument();
    expect(screen.getByText('中心停用检查：未开启')).toBeInTheDocument();
    expect(screen.getByText(/开放公众注册前必须开启：NEXUS_IDENTITY_STATUS_CHECK=on/)).toBeInTheDocument();
  });

  it('only a unified account is offered 退出所有产品与设备', async () => {
    server.options = { oidc: true, legacyPassword: true, registration: 'invite', accountUrl: 'https://id.example.org/realms/accounts/account' };
    await signInAs('admin', 'password');
    open(<AccountSection />);
    expect(await screen.findByRole('button', { name: /全部退出/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /退出所有产品/ })).toBeNull();
  });
});
