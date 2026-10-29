import { applyOps, defaultConfig, type Config, type ConfigResponse } from '@nexus/shared';
import { useConfigStore } from '@web/data/config-store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Area, ServerRecord } from './storage';
import { connect, initEngine, load, phaseOf, sync, THROTTLE_MS, useExt } from './sync';

const ORIGIN = 'https://nexus.example.com';
const SERVER: ServerRecord = { origin: ORIGIN, token: `nxd_${'a'.repeat(43)}`, deviceId: 'dev1', deviceName: 'Chrome · Windows', pairedAt: '2026-10-29T00:00:00.000Z' };

function memoryArea() {
  const data = new Map<string, unknown>();
  const writes: string[] = [];
  const area: Area = {
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        writes.push(k);
        data.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      for (const k of [keys].flat()) data.delete(k);
    },
  };
  return { area, data, writes };
}

/** A stand-in Nexus server: /api/sync/config with ETags, /api/sync/status, and failure switches. */
function fakeServer() {
  const s = {
    revision: 7,
    config: defaultConfig() as Config,
    mode: 'up' as 'up' | 'offline' | 'revoked' | 'proxy401' | 'garbage',
    calls: [] as { path: string; etag: string | null; auth: string | null }[],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const h = new Headers(init?.headers);
      s.calls.push({ path: url.pathname, etag: h.get('if-none-match'), auth: h.get('authorization') });
      if (s.mode === 'offline') throw new TypeError('Failed to fetch');
      if (s.mode === 'revoked') return Response.json({ error: { code: 'device_unauthorized', message: '此设备的授权已失效或已被撤销' } }, { status: 401 });
      if (s.mode === 'proxy401') return new Response('<html>login</html>', { status: 401 });
      const etag = `"${s.revision}-x"`;
      if (url.pathname === '/api/sync/config') {
        if (h.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
        const body: ConfigResponse = { revision: s.revision, updatedAt: '2026-10-29T00:00:00.000Z', config: s.config, wallpapers: [] };
        return s.mode === 'garbage' ? Response.json({ revision: 'x' }, { headers: { etag } }) : Response.json(body, { headers: { etag } });
      }
      if (url.pathname === '/api/sync/status') return Response.json([{ appId: 'litebox', level: 'ok', message: 'HTTP 200', checkedAt: new Date().toISOString(), latencyMs: 3 }]);
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  return s;
}

let t: number;
let wiped: number;
let store: ReturnType<typeof memoryArea>;
let server: ReturnType<typeof fakeServer>;

beforeEach(async () => {
  t = 1_000_000_000;
  wiped = 0;
  store = memoryArea();
  server = fakeServer();
  initEngine({ area: store.area, fetch: server.fetch, now: () => t, lock: async (_mode, fn) => fn(), wipe: async () => void wiped++ });
  useExt.setState({ loaded: false, server: null, cache: null, syncing: false });
  await store.area.set({ server: SERVER });
  await load();
});

const configCalls = () => server.calls.filter((c) => c.path === '/api/sync/config');

describe('sync', () => {
  it('first sync downloads the configuration and shows it through the portal store', async () => {
    expect(phaseOf(useExt.getState())).toBe('empty');
    expect(await sync()).toBe('updated');
    expect(phaseOf(useExt.getState())).toBe('ready');
    expect(useConfigStore.getState().snapshot.revision).toBe(7);
    expect(server.calls[0]!.auth).toBe(`Bearer ${SERVER.token}`);
  });

  it('within the throttle a new tab asks nothing; after it, a 304 rewrites nothing', async () => {
    await sync();
    const calls = server.calls.length;
    t += 5_000;
    expect(await sync()).toBe('skipped');
    expect(server.calls.length).toBe(calls);
    t += THROTTLE_MS;
    store.writes.length = 0;
    expect(await sync()).toBe('unchanged');
    expect(configCalls().at(-1)!.etag).toBe('"7-x"');
    expect(store.writes).toEqual(['sync']);
  });

  it('picks up a change made in the portal', async () => {
    await sync();
    server.config = applyOps(server.config, [{ type: 'pin.remove', appId: 'github' }]);
    server.revision = 8;
    t += THROTTLE_MS + 1;
    expect(await sync()).toBe('updated');
    expect(useConfigStore.getState().snapshot.config.pins).not.toContain('github');
  });

  it('offline keeps the cache and says so', async () => {
    await sync();
    server.mode = 'offline';
    t += THROTTLE_MS + 1;
    expect(await sync()).toBe('failed');
    const s = useExt.getState();
    expect(phaseOf(s)).toBe('ready');
    expect(s.sync.error?.kind).toBe('offline');
    expect(useConfigStore.getState().online).toBe(false);
    expect(useConfigStore.getState().snapshot.revision).toBe(7);
    // Back online: the error clears.
    server.mode = 'up';
    expect(await sync({ force: true })).toBe('unchanged');
    expect(useExt.getState().sync.error).toBeNull();
  });

  it('a revoked token wipes the cached data and asks to pair again', async () => {
    await sync();
    server.mode = 'revoked';
    expect(await sync({ force: true })).toBe('revoked');
    expect(phaseOf(useExt.getState())).toBe('revoked');
    expect(store.data.has('cache')).toBe(false);
    expect((store.data.get('server') as ServerRecord).token).toBe('-');
    expect(wiped).toBe(1);
    // Nothing more is asked with a dead token.
    const calls = server.calls.length;
    expect(await sync({ force: true })).toBe('skipped');
    expect(server.calls.length).toBe(calls);
  });

  it('a 401 from a proxy in front is an error, not a revocation', async () => {
    await sync();
    server.mode = 'proxy401';
    expect(await sync({ force: true })).toBe('failed');
    expect(phaseOf(useExt.getState())).toBe('ready');
  });

  it('an unreadable answer keeps the cache', async () => {
    await sync();
    server.mode = 'garbage';
    server.revision = 9;
    expect(await sync({ force: true })).toBe('failed');
    expect(useConfigStore.getState().snapshot.revision).toBe(7);
  });

  it('a damaged cache is dropped and downloaded again, never shown', async () => {
    await sync();
    await store.area.set({ cache: { ...(store.data.get('cache') as object), data: { revision: 7, config: { apps: 'broken' }, wallpapers: [] } } });
    await load();
    expect(phaseOf(useExt.getState())).toBe('empty');
    expect(store.data.has('cache')).toBe(false);
    expect(await sync()).toBe('updated');
  });

  it('a cache from another server is never shown', async () => {
    await sync();
    await store.area.set({ server: { ...SERVER, origin: 'https://other.example.com' } });
    await load();
    expect(useExt.getState().cache).toBeNull();
  });

  it('another tab syncing means this one does not', async () => {
    initEngine({ area: store.area, fetch: server.fetch, now: () => t, lock: async () => 'busy', wipe: async () => undefined });
    expect(await sync()).toBe('busy');
    expect(server.calls).toEqual([]);
  });

  it('connecting another server starts from a clean slate', async () => {
    await sync();
    const next: ServerRecord = { ...SERVER, origin: 'https://other.example.com', deviceId: 'dev2' };
    expect(await connect(next)).toBe('updated');
    expect(wiped).toBe(1);
    expect(useExt.getState().cache?.origin).toBe('https://other.example.com');
    // The old token was revoked on the old server (best effort).
    expect(server.calls.some((c) => c.path === '/api/sync/revoke' && c.auth === `Bearer ${SERVER.token}`)).toBe(true);
  });
});
