import { newUserConfig } from '@nexus/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { homeActions } from '../features/home/actions';
import { flush, logout, logoutEverywhere, refresh, resetSync, useConfigStore } from './config-store';
import { useRecentStore } from './recent';
import { MemoryTransport } from './transport';

/**
 * v0.4 · TN-05 / NP-A03 / NP-A11: one browser, two accounts. Account A's cache and unsent changes
 * are keyed by account; when B signs in here, nothing of A is shown, and A's queue is never sent
 * with B's session.
 */
let server: MemoryTransport;
const state = () => useConfigStore.getState();

beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  resetSync(server);
  useRecentStore.setState({ items: [] });
});

describe('one browser, several accounts', () => {
  it('A’s unsent change is never sent as B, nothing of A stays on screen, and A finds it again later', async () => {
    // A edits while offline: the change waits in A's queue.
    server.online = false;
    homeActions.unpin('youtube');
    await flush();
    expect(state().pending).toHaveLength(1);
    useRecentStore.getState().record({ kind: 'search', title: 'A 的私密搜索', query: 'A 的私密搜索', engineId: 'google' });

    // The session now belongs to B (A's expired; B signed in on this browser).
    server.online = true;
    const bServer = { ...newUserConfig(), pins: [] };
    server.config = bServer;
    server.account = { id: 'u-bbbb', role: 'user', session: 'oidc', canLinkIdentity: false };
    await refresh();

    expect(server.calls).toHaveLength(0); // A's batch did not go out with B's session
    expect(state().account?.account.id).toBe('u-bbbb');
    expect(state().pending).toEqual([]);
    expect(state().snapshot.config.apps).toEqual([]); // B's own (empty) collection, none of A's
    expect(useRecentStore.getState().items).toEqual([]);
    // A's queue is still there, under A's key.
    expect(JSON.parse(localStorage.getItem('nexus.cache.v3:legacy-admin')!).pending).toHaveLength(1);

    // A signs in again here: the queue goes out, as A.
    server.config = (await import('@nexus/shared')).defaultConfig();
    server.account = { id: 'legacy-admin', role: 'admin', session: 'password', canLinkIdentity: false };
    await refresh();
    expect(server.calls).toHaveLength(1);
    expect(server.config.pins).not.toContain('youtube');
  });

  it('nothing is sent before the server has said who the session belongs to', async () => {
    useConfigStore.setState({ verified: false });
    homeActions.unpin('gmail');
    await flush();
    expect(server.calls).toHaveLength(0);
    await refresh();
    expect(server.calls).toHaveLength(1);
  });

  it('a cache from before v0.4 goes to the legacy administrator only', async () => {
    const legacy = { confirmed: null, pending: [{ id: 'old-batch', ops: [{ type: 'pin.remove', appId: 'github' }] }], wallpapers: [] };
    localStorage.clear();
    localStorage.setItem('nexus.cache.v2', JSON.stringify(legacy));
    server.account = { id: 'u-cccc', role: 'user', session: 'oidc', canLinkIdentity: false };
    resetSync(server, 'u-cccc');
    localStorage.setItem('nexus.cache.v2', JSON.stringify(legacy));
    await refresh();
    // Someone else: dropped, never adopted, never sent.
    expect(localStorage.getItem('nexus.cache.v2')).toBeNull();
    expect(server.calls).toHaveLength(0);

    localStorage.setItem('nexus.cache.v2', JSON.stringify(legacy));
    server.account = { id: 'legacy-admin', role: 'admin', session: 'password', canLinkIdentity: false };
    await refresh();
    expect(localStorage.getItem('nexus.cache.v2')).toBeNull();
    // Adopted as the administrator's — and its queued change goes out as the administrator.
    expect(server.calls.map((c) => c.batchId)).toEqual(['old-batch']);
    expect(server.config.pins).not.toContain('github');
  });

  it('退出当前产品 forgets only this account’s cache; 退出所有设备 also ends it on the server', async () => {
    await refresh();
    localStorage.setItem('nexus.cache.v3:u-other', '{"confirmed":null,"pending":[],"wallpapers":[]}');
    await logout();
    expect(localStorage.getItem('nexus.cache.v3:legacy-admin')).toBeNull();
    expect(localStorage.getItem('nexus.account.v1')).toBeNull();
    expect(localStorage.getItem('nexus.cache.v3:u-other')).not.toBeNull();
    expect(state().auth).toBe('anonymous');

    server.authenticated = true; // signs in again
    resetSync(server);
    await refresh();
    // 动作 B: nothing to do at the identity service (no end-session hop any more).
    expect(await logoutEverywhere()).toMatchObject({ endSessionUrl: null });
    expect(server.loggedOutAll).toBe(1);
    expect(state().auth).toBe('anonymous');
    expect(state().snapshot.config.apps.length).toBeGreaterThan(0); // built-in defaults, nothing private
    expect(state().confirmed).toBeNull();
  });
});
