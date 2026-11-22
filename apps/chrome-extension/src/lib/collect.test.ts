import { describe, expect, it } from 'vitest';
import { ApiError, deviceApi } from './api';
import { coalesce } from './coalesce';
import { adoptDrafts, captureFromMenu, dropEntry, enqueue, flushQueue, forgetSent, MENU, migrateLegacyQueue, readQueue } from './collect';
import { saveThroughBackground, type QueueCommand, type SaveReply } from './queue-client';
import { memoryQueueStore } from './queue-store';
import { markRevoked } from './revoke';
import { KEYS, readServer, type Area, type ServerRecord } from './storage';

/**
 * EX-01 / EX-03 / NEX-05: what the menu captures, and a save queue that survives, never doubles
 * and never loses a save to another one. These run on the store's stand-in (memoryQueueStore:
 * serialized transactions, copies, a turn of the event loop per commit); the IndexedDB store
 * itself runs in real Chrome / Edge in e2e/extension-release.spec.ts.
 */
function memoryArea(): Area & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const k of [keys].flat()) delete data[k];
    },
  };
}

const server = (over: Partial<ServerRecord> = {}): ServerRecord => ({ origin: 'https://home.example.org', token: 'nxd_test', deviceId: 'dev-1', deviceName: 'Chrome', pairedAt: '', scopes: ['config:read', 'items:read', 'items:write', 'pins:write'], account: { id: 'u-a', label: 'a@example.org' }, ...over });

/** A server that keeps opIds like the real one: the same opId is the same item, whatever happens. */
function fakeServer(opts: { slow?: () => Promise<void> } = {}) {
  const items = new Map<string, { id: string; title: string; token: string }>();
  const calls: { opId: string; token: string }[] = [];
  return {
    items,
    calls,
    api: {
      createItem: async (token: string, body: { opId: string; item: { title: string } }) => {
        calls.push({ opId: body.opId, token });
        await opts.slow?.();
        const seen = items.get(body.opId) ?? { id: `it-${items.size + 1}`, title: body.item.title, token };
        items.set(body.opId, seen);
        return { item: { id: seen.id, title: seen.title, folderId: 'none' }, result: 'created', ownerRevision: 1 } as never;
      },
    },
  };
}

/** A gate: requests wait at it until opened (a request on its way). */
function gate() {
  let open!: () => void;
  let arrived!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (arrived = r));
  return { open, reached, wait: async () => (arrived(), opened) };
}

describe('context menu capture (EX-01)', () => {
  it('收藏此链接 takes the link, never the page it sits on', () => {
    const c = captureFromMenu({ menuItemId: MENU.link, linkUrl: 'https://docs.example.org/guide/install?x=1#top', pageUrl: 'https://news.example.org/today' }, { title: '今日新闻', url: 'https://news.example.org/today' });
    expect(c).toEqual({ title: 'install · docs.example.org', url: 'https://docs.example.org/guide/install?x=1#top' });
    expect(captureFromMenu({ menuItemId: MENU.link, linkUrl: 'https://a.example.org/x', selectionText: ' 选中的文字 ' }, { url: 'https://b.example.org/' })).toMatchObject({ title: '选中的文字', url: 'https://a.example.org/x' });
  });

  it('收藏当前页面 takes the tab; browser pages and odd links are refused with a reason', () => {
    expect(captureFromMenu({ menuItemId: MENU.page, pageUrl: 'https://x.example.org/' }, { title: '文章标题', url: 'https://x.example.org/a?b=1#c' })).toEqual({ title: '文章标题', url: 'https://x.example.org/a?b=1#c' });
    expect(captureFromMenu({ menuItemId: MENU.page }, { title: '扩展', url: 'chrome://extensions/' })).toHaveProperty('error');
    expect(captureFromMenu({ menuItemId: MENU.link, linkUrl: 'javascript:void(0)' })).toHaveProperty('error');
    expect(captureFromMenu({ menuItemId: MENU.link, linkUrl: 'https://user:pw@x.example.org/' })).toHaveProperty('error');
  });
});

describe('the save queue (EX-03)', () => {
  it('is on disk before anything is sent; a lost answer is resent with the same opId', async () => {
    const store = memoryQueueStore();
    const e = await enqueue(store, server(), { title: '文章', url: 'https://x.example.org/a' });
    expect(store.rows.get(e.opId)).toMatchObject({ opId: e.opId, state: 'pending', account: 'u-a' });
    const seen: string[] = [];
    let lose = true;
    const api = {
      createItem: async (_t: string, body: { opId: string }) => {
        seen.push(body.opId);
        if (lose) {
          lose = false;
          throw new ApiError('offline', '无法连接'); // the answer never arrived
        }
        return { item: { id: 'it-1', title: '文章', folderId: 'none' }, result: 'created', ownerRevision: 2 } as never;
      },
    };
    expect(await flushQueue(store, server(), api)).toEqual({ sent: 0, left: 1, stopped: 'offline' });
    expect(await flushQueue(store, server(), api)).toEqual({ sent: 1, left: 0 });
    expect(seen).toEqual([e.opId, e.opId]);
    expect((await readQueue(store))[0]).toMatchObject({ state: 'saved', item: { id: 'it-1' } });
  });

  it('never sends one account’s saves with another account’s token', async () => {
    const store = memoryQueueStore();
    await enqueue(store, server(), { title: 'A 的', url: 'https://a.example.org/' });
    const calls: string[] = [];
    const api = { createItem: async (_t: string, b: { opId: string }) => (calls.push(b.opId), { item: { id: 'x', title: '', folderId: 'none' } } as never) };
    expect(await flushQueue(store, server({ account: { id: 'u-b', label: 'b' }, token: 'nxd_b' }), api)).toEqual({ sent: 0, left: 0 });
    expect(calls).toEqual([]);
    expect((await readQueue(store))[0]).toMatchObject({ state: 'pending', account: 'u-a' });
  });

  it('signed out or read-only: a draft, sent only after the person confirms the account', async () => {
    const store = memoryQueueStore();
    await enqueue(store, null, { title: '草稿', url: 'https://draft.example.org/' });
    await enqueue(store, server({ scopes: ['config:read'] }), { title: '只读设备的草稿', url: 'https://draft.example.org/2' });
    const api = { createItem: async () => ({ item: { id: 'x', title: '', folderId: 'none' } }) as never };
    expect((await flushQueue(store, server(), api)).sent).toBe(0);
    expect((await readQueue(store)).map((e) => e.state)).toEqual(['draft', 'draft']);
    expect(await adoptDrafts(store, server())).toBe(2);
    expect((await flushQueue(store, server(), api)).sent).toBe(2);
  });

  it('answers for good finish the entry: already saved, or over the limit (kept, with the reason)', async () => {
    const store = memoryQueueStore();
    await enqueue(store, server(), { title: '重复', url: 'https://dup.example.org/' });
    await enqueue(store, server(), { title: '超限', url: 'https://full.example.org/' });
    const api = {
      createItem: async (_t: string, b: { opId: string; item: { url: string } }) => {
        if (b.item.url.includes('dup')) throw new ApiError('server', '这个网址已经在「我的收藏」里', 409, 'DUPLICATE', { item: { id: 'it-old', title: '原来的', folderId: 'work' } });
        throw new ApiError('server', '「我的收藏」最多 5000 条，请先删除一些', 409, 'QUOTA_EXCEEDED', { kind: 'items', limit: 5000, used: 5000 });
      },
    };
    await flushQueue(store, server(), api);
    const q = await readQueue(store);
    expect(q.find((e) => e.title === '重复')).toMatchObject({ state: 'duplicate', item: { id: 'it-old' } });
    expect(q.find((e) => e.title === '超限')).toMatchObject({ state: 'held', message: expect.stringContaining('5000') });
  });

  it('pinning is only asked for when the device may pin', async () => {
    const e = await enqueue(memoryQueueStore(), server({ scopes: ['config:read', 'items:read', 'items:write'] }), { title: 't', url: 'https://p.example.org/', pinToHome: true });
    expect(e.pinToHome).toBe(false);
  });
});

describe('pins the home page has no room for (NEX-07)', () => {
  it('a save whose pin was refused is saved, and says it was not pinned', async () => {
    const store = memoryQueueStore();
    await enqueue(store, server(), { title: '满了', url: 'https://full-home.example.org/', pinToHome: true });
    const api = { createItem: async () => ({ item: { id: 'it-9', title: '满了', folderId: 'none', pinned: false }, result: 'created', ownerRevision: 3, pin: { pinned: false, code: 'PINS_FULL', limit: 36, used: 36 } }) as never };
    await flushQueue(store, server(), api);
    expect((await readQueue(store))[0]).toMatchObject({ state: 'saved', message: expect.stringContaining('36') });
  });
});

describe('NEX-05 · concurrent changes never lose a save (store stand-in)', () => {
  it('审查反例：两次同时保存都返回成功，也都在队列里（此前只剩第二条）', async () => {
    const store = memoryQueueStore();
    const entries = await Promise.all([enqueue(store, null, { title: 'first concurrent save', url: 'https://audit.example.org/first' }), enqueue(store, null, { title: 'second concurrent save', url: 'https://audit.example.org/second' })]);
    expect(entries).toHaveLength(2);
    expect((await readQueue(store)).map((e) => e.title).sort()).toEqual(['first concurrent save', 'second concurrent save']);
  });

  it('twenty saves at once from popup and menu: all twenty kept, then sent once each', async () => {
    const store = memoryQueueStore();
    await Promise.all(Array.from({ length: 20 }, (_, i) => enqueue(store, server(), { title: `第 ${i}`, url: `https://many.example.org/${i}` })));
    expect(store.rows.size).toBe(20);
    const s = fakeServer();
    expect(await flushQueue(store, server(), s.api)).toEqual({ sent: 20, left: 0 });
    expect(s.items.size).toBe(20);
  });

  it('a save made while another one is being sent is kept, and the answer does not overwrite it', async () => {
    const store = memoryQueueStore();
    await enqueue(store, server(), { title: '先存的', url: 'https://during.example.org/1' });
    const g = gate();
    const s = fakeServer({ slow: () => g.wait() });
    const sending = flushQueue(store, server(), s.api);
    await g.reached;
    const later = await enqueue(store, server(), { title: '发送途中存的', url: 'https://during.example.org/2' });
    g.open();
    await sending;
    const q = await readQueue(store);
    expect(q).toHaveLength(2);
    expect(q.find((e) => e.opId === later.opId)?.state).toMatch(/pending|saved/);
    expect((await flushQueue(store, server(), s.api)).left).toBe(0);
    expect(s.items.size).toBe(2);
  });

  // Found by the release-package test in a real browser: the background's send was single-flight,
  // so a save committed after the send had read the queue for the last time joined that send, was
  // not in it, and waited for the next popup or new tab. The background now sends through coalesce.
  it('a save committed while the background send is finishing gets one more send — it is not left waiting', async () => {
    const store = memoryQueueStore();
    const s = fakeServer();
    const tail = gate(); // the first send's last step (the toolbar badge) is still under way
    let first = true;
    const flush = coalesce(async () => {
      await flushQueue(store, server(), s.api);
      if (first) {
        first = false;
        await tail.wait();
      }
    });
    const a = await enqueue(store, server(), { title: '先存的', url: 'https://tail.example.org/a' });
    const sending = flush();
    await tail.reached; // A is on the server; this send will not read the queue again
    const b = await enqueue(store, server(), { title: '收尾时存的', url: 'https://tail.example.org/b' });
    const again = flush();
    tail.open();
    await Promise.all([sending, again]);
    expect(s.calls.map((c) => c.opId)).toEqual([a.opId, b.opId]);
    expect((await readQueue(store)).map((e) => [e.title, e.state]).sort()).toEqual([
      ['先存的', 'saved'],
      ['收尾时存的', 'saved'],
    ]);
  });

  it('drafts confirmed while a send is on its way: both changes land', async () => {
    const store = memoryQueueStore();
    await enqueue(store, server(), { title: '待发送', url: 'https://adopt.example.org/1' });
    await enqueue(store, null, { title: '草稿', url: 'https://adopt.example.org/2' });
    const g = gate();
    const s = fakeServer({ slow: () => g.wait() });
    const sending = flushQueue(store, server(), s.api);
    await g.reached;
    expect(await adoptDrafts(store, server())).toBe(1);
    g.open();
    await sending;
    await flushQueue(store, server(), s.api);
    expect((await readQueue(store)).map((e) => e.state)).toEqual(['saved', 'saved']);
  });

  it('dropped while being sent: the late answer does not bring the entry back', async () => {
    const store = memoryQueueStore();
    const e = await enqueue(store, server(), { title: '要丢弃的', url: 'https://drop.example.org/' });
    const g = gate();
    const s = fakeServer({ slow: () => g.wait() });
    const sending = flushQueue(store, server(), s.api);
    await g.reached;
    await dropEntry(store, e.opId);
    g.open();
    await sending;
    expect(store.rows.has(e.opId)).toBe(false);
  });

  it('signed out while a save is on its way: it stays a draft (never deleted), and after confirming it is sent again with the same opId — one item', async () => {
    const store = memoryQueueStore();
    const e = await enqueue(store, server(), { title: '撤销时在路上', url: 'https://revoke.example.org/' });
    const g = gate();
    const s = fakeServer({ slow: () => g.wait() });
    const sending = flushQueue(store, server(), s.api);
    await g.reached;
    await forgetSent(store);
    g.open();
    await sending;
    expect(store.rows.get(e.opId)).toMatchObject({ state: 'draft', origin: null, account: null });
    await adoptDrafts(store, server());
    await flushQueue(store, server(), s.api);
    expect(s.calls.map((c) => c.opId)).toEqual([e.opId, e.opId]);
    expect(s.items.size).toBe(1);
  });

  it('the background stopped mid-send: a new one (same store) resends with the same opId; the server creates it once', async () => {
    const store = memoryQueueStore();
    const e = await enqueue(store, server(), { title: '后台被停止', url: 'https://stopped.example.org/' });
    const s = fakeServer();
    // The first worker reached the server and was stopped before writing the answer down.
    await s.api.createItem('nxd_test', { opId: e.opId, item: { title: e.title } });
    expect(store.rows.get(e.opId)?.state).toBe('pending');
    // The next worker starts from the store alone.
    expect(await flushQueue(store, server(), s.api)).toEqual({ sent: 1, left: 0 });
    expect(s.calls.map((c) => c.opId)).toEqual([e.opId, e.opId]);
    expect(s.items.size).toBe(1);
  });

  it('offline, then another account connects: the first account’s saves are never sent with the second token', async () => {
    const store = memoryQueueStore();
    await enqueue(store, server(), { title: 'A 离线时存的', url: 'https://switch.example.org/a' });
    const b = server({ token: 'nxd_b', deviceId: 'dev-2', account: { id: 'u-b', label: 'b@example.org' } });
    await enqueue(store, b, { title: 'B 存的', url: 'https://switch.example.org/b' });
    const s = fakeServer();
    await flushQueue(store, b, s.api);
    expect(s.calls).toEqual([{ opId: expect.any(String), token: 'nxd_b' }]);
    expect((await readQueue(store)).find((e) => e.title === 'A 离线时存的')).toMatchObject({ state: 'pending', account: 'u-a' });
    // A reconnects: its save goes with A's token.
    await flushQueue(store, server(), s.api);
    expect(s.calls.map((c) => c.token)).toEqual(['nxd_b', 'nxd_test']);
  });

  it('the same opId saved twice (a command repeated after the background stopped) is one entry', async () => {
    const store = memoryQueueStore();
    const [a, b] = await Promise.all([enqueue(store, server(), { title: '一次', url: 'https://once.example.org/' }, { opId: 'ext-same-op-0000000000001' }), enqueue(store, server(), { title: '一次', url: 'https://once.example.org/' }, { opId: 'ext-same-op-0000000000001' })]);
    expect(a.opId).toBe(b.opId);
    expect(store.rows.size).toBe(1);
  });

  it('saves of 0.2.0 (one storage key) move into the store once, even if moving is interrupted and repeated', async () => {
    const area = memoryArea();
    const store = memoryQueueStore();
    const old = [
      { opId: 'ext-old-1', title: '旧的待发送', url: 'https://old.example.org/1', tags: [], pinToHome: false, at: 1, state: 'pending', origin: 'https://home.example.org', account: 'u-a' },
      { opId: 'ext-old-2', title: '旧的草稿', url: 'https://old.example.org/2', tags: [], pinToHome: false, at: 2, state: 'draft', origin: null, account: null },
    ];
    area.data[KEYS.queue] = old;
    // Interrupted after committing to the store, before the key went: the next start repeats it.
    expect(await migrateLegacyQueue({ ...area, remove: async () => undefined }, store)).toBe(2);
    expect(await migrateLegacyQueue(area, store)).toBe(0);
    expect(area.data[KEYS.queue]).toBeUndefined();
    expect((await readQueue(store)).map((e) => e.opId)).toEqual(['ext-old-1', 'ext-old-2']);
  });
});

describe('NEX-05 · the popup is told 「已保存」 only for what is stored', () => {
  const capture = { title: '弹窗保存', url: 'https://popup.example.org/a?x=1#y' };

  it('the background answered: its reply', async () => {
    const store = memoryQueueStore();
    const send = async (m: QueueCommand): Promise<SaveReply> => {
      if (m.type !== 'queue:save') throw new Error('unexpected');
      return { ok: true, persisted: true, entry: await enqueue(store, server(), m.capture, { opId: m.opId }) };
    };
    const r = await saveThroughBackground(capture, { store, send });
    expect(r).toMatchObject({ ok: true, persisted: true, entry: { url: capture.url, state: 'pending' } });
  });

  it('stopped after committing, before answering: the store says it is kept', async () => {
    const store = memoryQueueStore();
    const send = async (m: QueueCommand) => {
      if (m.type === 'queue:save') await enqueue(store, server(), m.capture, { opId: m.opId });
      throw new Error('The message port closed before a response was received.');
    };
    expect(await saveThroughBackground(capture, { store, send })).toMatchObject({ persisted: true, entry: { url: capture.url } });
    expect(store.rows.size).toBe(1);
  });

  it('stopped before committing: asked again with the same opId — kept once; never reported kept when it is not', async () => {
    const store = memoryQueueStore();
    let calls = 0;
    const flaky = async (m: QueueCommand) => {
      calls++;
      if (calls === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
      if (m.type !== 'queue:save') throw new Error('unexpected');
      return { ok: true, persisted: true, entry: await enqueue(store, server(), m.capture, { opId: m.opId }) };
    };
    expect(await saveThroughBackground(capture, { store, send: flaky })).toMatchObject({ persisted: true });
    expect(store.rows.size).toBe(1);
    const down = async () => {
      throw new Error('Receiving end does not exist.');
    };
    expect(await saveThroughBackground(capture, { store: memoryQueueStore(), send: down })).toMatchObject({ ok: false, persisted: false });
  });
});

describe('NEX-05 / ADR-019 · revoked (401) and identity service unavailable (503) while sending', () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('the API keeps what the server said: 401 DEVICE_REVOKED is unauthorized; 503 IDENTITY_UNAVAILABLE is temporary, with Retry-After', async () => {
    const revoked = await deviceApi('https://home.example.org', answer(401, { code: 'DEVICE_REVOKED', message: '此设备的授权已失效或已被撤销，请在扩展中重新连接', retryable: false }))
      .createItem('nxd_x', { opId: 'ext-a', source: 'extension', item: { title: 't', url: 'https://a.example.org/' }, pinToHome: false, duplicatePolicy: 'prompt' })
      .catch((e: unknown) => e);
    expect(revoked).toMatchObject({ kind: 'unauthorized', status: 401, code: 'DEVICE_REVOKED' });
    const busy = await deviceApi('https://home.example.org', answer(503, { code: 'IDENTITY_UNAVAILABLE', message: '暂时无法向账号中心确认这个账号的状态，请稍后重试（未发送的内容已保留）', retryable: true }, { 'retry-after': '30' }))
      .createItem('nxd_x', { opId: 'ext-b', source: 'extension', item: { title: 't', url: 'https://b.example.org/' }, pinToHome: false, duplicatePolicy: 'prompt' })
      .catch((e: unknown) => e);
    expect(busy).toMatchObject({ kind: 'offline', status: 503, code: 'IDENTITY_UNAVAILABLE', details: { retryAfterSeconds: 30 } });
  });

  it('503 IDENTITY_UNAVAILABLE: kept as it is (busy), and sent later with the same opId', async () => {
    const store = memoryQueueStore();
    const e = await enqueue(store, server(), { title: '账号中心暂时不可用', url: 'https://idp-down.example.org/' });
    let down = true;
    const seen: string[] = [];
    const api = {
      createItem: async (_t: string, b: { opId: string }) => {
        seen.push(b.opId);
        if (down) throw new ApiError('offline', '暂时无法向账号中心确认这个账号的状态', 503, 'IDENTITY_UNAVAILABLE', { retryAfterSeconds: 30 });
        return { item: { id: 'it-1', title: 't', folderId: 'none' }, result: 'created', ownerRevision: 1 } as never;
      },
    };
    expect(await flushQueue(store, server(), api)).toEqual({ sent: 0, left: 1, stopped: 'busy' });
    expect(store.rows.get(e.opId)?.state).toBe('pending');
    down = false;
    expect(await flushQueue(store, server(), api)).toEqual({ sent: 1, left: 0 });
    expect(seen).toEqual([e.opId, e.opId]);
  });

  it('401 while sending: the device is marked revoked at once, unsent saves become drafts (none deleted), nothing goes out with another token', async () => {
    const area = memoryArea();
    const store = memoryQueueStore();
    const s = server();
    area.data[KEYS.server] = s;
    area.data[KEYS.cache] = { origin: s.origin };
    const a = await enqueue(store, s, { title: '撤销前存的一', url: 'https://revoked.example.org/1' });
    const b = await enqueue(store, s, { title: '撤销前存的二', url: 'https://revoked.example.org/2' });
    const calls: string[] = [];
    const api = {
      createItem: async (t: string, x: { opId: string }) => {
        calls.push(`${t}:${x.opId}`);
        throw new ApiError('unauthorized', '此设备的授权已失效或已被撤销', 401, 'DEVICE_REVOKED');
      },
    };
    expect(await flushQueue(store, s, api)).toMatchObject({ sent: 0, stopped: 'unauthorized' });
    expect(calls).toEqual([`nxd_test:${a.opId}`]); // stopped at the first refusal
    expect(await markRevoked(area, store, s)).toBe(true);
    expect(area.data[KEYS.server]).toMatchObject({ revoked: true, token: '-' });
    expect(area.data[KEYS.cache]).toBeUndefined();
    expect((await readQueue(store)).map((e) => [e.opId, e.state, e.account])).toEqual([
      [a.opId, 'draft', null],
      [b.opId, 'draft', null],
    ]);
    // Revoked: the flush sends nothing (and certainly not with some other token).
    expect(await flushQueue(store, readServer(area.data[KEYS.server])!, api)).toMatchObject({ sent: 0 });
    expect(calls).toHaveLength(1);
    // Another account connects: the drafts wait for an explicit confirmation.
    const other = server({ token: 'nxd_other', deviceId: 'dev-9', account: { id: 'u-b', label: 'b' } });
    expect(await flushQueue(store, other, api)).toMatchObject({ sent: 0 });
    expect(calls).toHaveLength(1);
  });

  it('a revocation found late does not touch a connection made since (another device or token)', async () => {
    const area = memoryArea();
    const store = memoryQueueStore();
    const old = server();
    const fresh = server({ token: 'nxd_new', deviceId: 'dev-new' });
    area.data[KEYS.server] = fresh;
    expect(await markRevoked(area, store, old)).toBe(false);
    expect(area.data[KEYS.server]).toMatchObject({ token: 'nxd_new', deviceId: 'dev-new' });
    expect((area.data[KEYS.server] as ServerRecord).revoked).toBeFalsy();
  });
});

describe('ADR-017 I-6 · drafts of a revoked account are never confirmed into another one', () => {
  it('after a revocation, only the same account may confirm its saves; another account sees none of them', async () => {
    const store = memoryQueueStore();
    const a = await enqueue(store, server(), { title: 'A 的', url: 'https://owner.example.org/a' });
    const loose = await enqueue(store, null, { title: '连接前存的', url: 'https://owner.example.org/loose' });
    await forgetSent(store);
    expect(store.rows.get(a.opId)).toMatchObject({ state: 'draft', owner: { origin: 'https://home.example.org', account: 'u-a' } });
    const b = server({ token: 'nxd_b', deviceId: 'dev-b', account: { id: 'u-b', label: 'b' } });
    // B may take the draft that never had an account, not A's.
    expect(await adoptDrafts(store, b)).toBe(1);
    expect(store.rows.get(loose.opId)).toMatchObject({ state: 'pending', account: 'u-b' });
    expect(store.rows.get(a.opId)).toMatchObject({ state: 'draft' });
    const s = fakeServer();
    await flushQueue(store, b, s.api);
    expect(s.calls.map((c) => c.opId)).toEqual([loose.opId]);
    // A reconnects (a new device token): its own draft can be confirmed and goes with A's token.
    const aAgain = server({ token: 'nxd_a2', deviceId: 'dev-a2' });
    expect(await adoptDrafts(store, aAgain)).toBe(1);
    await flushQueue(store, aAgain, s.api);
    expect(s.calls.map((c) => [c.opId, c.token])).toEqual([
      [loose.opId, 'nxd_b'],
      [a.opId, 'nxd_a2'],
    ]);
  });
});
