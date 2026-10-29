import { defaultConfig } from '@nexus/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runUndo, useToastStore } from '../components/toast-store';
import { homeActions } from '../features/home/actions';
import { dispatch, flush, login, onSyncRejected, refresh, resetSync, useConfigStore } from './config-store';
import { MemoryTransport, NetworkError } from './transport';

let server: MemoryTransport;
const state = () => useConfigStore.getState();
const pins = () => state().snapshot.config.pins;

beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  resetSync(server);
  useToastStore.setState({ current: null });
});

describe('sync engine', () => {
  it('sends ops to the server and adopts its revision', async () => {
    homeActions.unpin('youtube');
    expect(pins()).not.toContain('youtube'); // optimistic
    await flush();
    expect(server.config.pins).not.toContain('youtube');
    expect(state().confirmed?.revision).toBe(2);
    expect(state().pending).toEqual([]);
  });

  it('still sends after an idle refresh (regression: flush stuck after a no-op run)', async () => {
    await refresh();
    homeActions.unpin('gmail');
    await flush();
    expect(server.calls).toHaveLength(1);
    expect(server.config.pins).not.toContain('gmail');
  });

  it('keeps edits while offline and sends them when the connection returns', async () => {
    server.online = false;
    homeActions.unpin('youtube');
    await flush();
    expect(state().online).toBe(false);
    expect(state().pending).toHaveLength(1);
    expect(pins()).not.toContain('youtube');
    // Survives a reload: the outbox is persisted.
    expect(JSON.parse(localStorage.getItem('nexus.cache.v2')!).pending).toHaveLength(1);
    server.online = true;
    await refresh();
    expect(state().online).toBe(true);
    expect(server.config.pins).not.toContain('youtube');
    expect(state().pending).toEqual([]);
  });

  it('retrying after a lost response does not apply the batch twice', async () => {
    const post = server.postOps.bind(server);
    let drop = true;
    server.postOps = async (b) => {
      const r = await post(b);
      if (drop) {
        drop = false;
        throw new NetworkError();
      }
      return r;
    };
    homeActions.move('github', 1);
    await flush();
    expect(state().pending).toHaveLength(1);
    await refresh();
    expect(server.revision).toBe(2);
    expect(server.calls).toHaveLength(2);
    expect(server.config.pins.slice(0, 2)).toEqual(['gmail', 'github']);
  });

  it('merges a remote change with a local pending change by intent', async () => {
    server.online = false;
    homeActions.unpin('youtube');
    await flush();
    server.online = true;
    server.remoteChange([{ type: 'pin.add', appId: 'figma' }]);
    await refresh();
    expect(pins()).toEqual(['github', 'gmail', 'bilibili', 'notion', 'figma']);
    expect(server.config.pins).toEqual(pins());
  });

  it('drops a change the server rejects and says so', async () => {
    const rejected = vi.fn();
    onSyncRejected(rejected);
    server.online = false;
    homeActions.pin('vercel');
    await flush();
    server.online = true;
    server.remoteChange([{ type: 'app.setHidden', appId: 'vercel', hidden: true }]);
    await refresh();
    expect(rejected).toHaveBeenCalledOnce();
    expect(pins()).not.toContain('vercel');
    expect(state().pending).toEqual([]);
  });

  it('a 401 shows the login page and keeps the outbox for after sign-in', async () => {
    server.authenticated = false;
    homeActions.unpin('gmail');
    await flush();
    expect(state().auth).toBe('anonymous');
    expect(state().pending).toHaveLength(1);
    await login('pw');
    expect(state().auth).toBe('authenticated');
    expect(server.config.pins).not.toContain('gmail');
  });

  it('a corrupt cache falls back to defaults instead of crashing', () => {
    localStorage.setItem('nexus.cache.v2', '{"confirmed":{"revision":3,"config":{"apps":"nope"}},"pending":[]}');
    resetSync(server);
    expect(pins()).toEqual(defaultConfig().pins);
  });
});

describe('structural changes are undoable', () => {
  it('hide → toast → undo restores visibility and position, also on the server', async () => {
    homeActions.hide('gmail');
    const t = useToastStore.getState().current!;
    expect(t.msg).toContain('已隐藏 Gmail');
    runUndo(t);
    await flush();
    expect(pins()[1]).toBe('gmail');
    expect(server.config.pins[1]).toBe('gmail');
    expect(server.config.apps.find((a) => a.id === 'gmail')!.hidden).toBe(false);
    expect(useToastStore.getState().current!.msg).toBe('已撤销');
  });

  it('pinning beyond the Dock capacity explains where it appears', () => {
    homeActions.pin('figma');
    expect(useToastStore.getState().current!.msg).toBe('已固定 Figma 到首页，位于桌面扩展区');
    homeActions.unpin('figma');
    dispatch({ type: 'settings.patch', section: 'home', patch: { shortcuts: { ...useConfigStore.getState().snapshot.config.settings.home.shortcuts, mode: 'single' } } });
    homeActions.pin('figma');
    expect(useToastStore.getState().current!.msg).toBe('已固定 Figma 到首页；桌面首排只显示前 5 个');
  });

  it('reordering does not raise a toast', () => {
    homeActions.move('github', 1);
    expect(pins().slice(0, 2)).toEqual(['gmail', 'github']);
    expect(useToastStore.getState().current).toBeNull();
  });
});
