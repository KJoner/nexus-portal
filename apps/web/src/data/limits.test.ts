import { CONFIG_LIMITS, defaultConfig, type AppEntry } from '@nexus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../components/toast-store';
import { homeActions } from '../features/home/actions';
import { dispatch, discardHeld, flush, onSyncRejected, refresh, resetSync, retryHeld, useConfigStore } from './config-store';
import { HttpError, MemoryTransport } from './transport';

/**
 * TN-07 on the client: a limit reached never loses what the person typed, and being told to slow
 * down never drops a change.
 */
let server: MemoryTransport;
const state = () => useConfigStore.getState();
const quota = () => new HttpError(409, 'QUOTA_EXCEEDED', '「我的收藏」最多 500 个应用，请先删除一些', false, null, { kind: 'apps', limit: 500, used: 500 });

beforeEach(() => {
  localStorage.clear();
  server = new MemoryTransport();
  resetSync(server);
  useToastStore.setState({ current: null });
});
afterEach(() => vi.useRealTimers());

describe('limits on the client (TN-07)', () => {
  it('over a limit locally: refused before anything is sent, so the form keeps its draft', () => {
    const site = defaultConfig().apps.find((a) => a.kind === 'site')!;
    const apps: AppEntry[] = Array.from({ length: CONFIG_LIMITS.apps }, (_, i) => ({ ...site, id: `s-${i}`, name: `站 ${i}`, url: `https://s${i}.example.org/` }));
    useConfigStore.setState({ snapshot: { ...state().snapshot, config: { ...state().snapshot.config, apps, pins: [] } } });
    const r = dispatch({ type: 'app.upsert', app: { ...site, id: 'new-one', name: '新的', url: 'https://new.example.org/' } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.quota).toEqual({ kind: 'apps', limit: 500, used: 500 });
    expect(state().pending).toEqual([]);
  });

  it('QUOTA_EXCEEDED from the server (another device got there first): the change is held, not lost', async () => {
    const told: string[] = [];
    onSyncRejected((m) => told.push(m));
    server.postOps = async () => {
      throw quota();
    };
    homeActions.unpin('youtube');
    await flush();
    expect(state().pending).toEqual([]);
    expect(state().held).toHaveLength(1);
    expect(state().held[0]!.message).toContain('500');
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('已保留在本机');
    // Survives a reload: held changes are part of the account's cache.
    expect(JSON.parse(localStorage.getItem('nexus.cache.v3:legacy-admin')!).held).toHaveLength(1);

    // Room was made (here: the server accepts again); 重试 sends it, as a new batch.
    server.postOps = MemoryTransport.prototype.postOps.bind(server);
    retryHeld();
    await flush();
    expect(state().held).toEqual([]);
    expect(server.config.pins).not.toContain('youtube');
  });

  it('放弃 discards held changes for good', async () => {
    server.postOps = async () => {
      throw quota();
    };
    homeActions.unpin('gmail');
    await flush();
    expect(state().held).toHaveLength(1);
    discardHeld();
    expect(state().held).toEqual([]);
    expect(JSON.parse(localStorage.getItem('nexus.cache.v3:legacy-admin')!).held).toEqual([]);
  });

  it('RATE_LIMITED keeps the change queued and tries again after Retry-After', async () => {
    vi.useFakeTimers();
    let limited = true;
    const post = MemoryTransport.prototype.postOps.bind(server);
    server.postOps = async (b) => {
      if (limited) throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试', true, 3, { kind: 'write', retryAfterSeconds: 3 });
      return post(b);
    };
    homeActions.unpin('bilibili');
    await flush();
    expect(state().pending).toHaveLength(1); // not dropped
    expect(state().held).toEqual([]);
    expect(server.calls).toHaveLength(0);
    limited = false;
    await vi.advanceTimersByTimeAsync(2900);
    expect(server.config.pins).toContain('bilibili'); // not before Retry-After
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(server.config.pins).not.toContain('bilibili'));
    expect(state().pending).toEqual([]);
  });

  it('other refusals still drop only that change (unchanged behaviour)', async () => {
    server.postOps = async () => {
      throw new HttpError(422, 'invalid', '分类不存在');
    };
    homeActions.unpin('notion');
    await flush();
    expect(state().pending).toEqual([]);
    expect(state().held).toEqual([]);
    await refresh();
  });
});
