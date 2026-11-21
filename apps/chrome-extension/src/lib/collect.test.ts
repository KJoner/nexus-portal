import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { adoptDrafts, captureFromMenu, enqueue, flushQueue, MENU, readQueue } from './collect';
import type { Area, ServerRecord } from './storage';

/** EX-01 / EX-03: what the menu captures, and a save queue that survives and never doubles. */
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
    const area = memoryArea();
    const e = await enqueue(area, server(), { title: '文章', url: 'https://x.example.org/a' });
    expect((await readQueue(area))[0]).toMatchObject({ opId: e.opId, state: 'pending', account: 'u-a' });
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
    expect(await flushQueue(area, server(), api)).toEqual({ sent: 0, left: 1 });
    expect(await flushQueue(area, server(), api)).toEqual({ sent: 1, left: 0 });
    expect(seen).toEqual([e.opId, e.opId]);
    expect((await readQueue(area))[0]).toMatchObject({ state: 'saved', item: { id: 'it-1' } });
  });

  it('never sends one account’s saves with another account’s token', async () => {
    const area = memoryArea();
    await enqueue(area, server(), { title: 'A 的', url: 'https://a.example.org/' });
    const calls: string[] = [];
    const api = { createItem: async (_t: string, b: { opId: string }) => (calls.push(b.opId), { item: { id: 'x', title: '', folderId: 'none' } } as never) };
    expect(await flushQueue(area, server({ account: { id: 'u-b', label: 'b' }, token: 'nxd_b' }), api)).toEqual({ sent: 0, left: 1 });
    expect(calls).toEqual([]);
  });

  it('signed out or read-only: a draft, sent only after the person confirms the account', async () => {
    const area = memoryArea();
    await enqueue(area, null, { title: '草稿', url: 'https://draft.example.org/' });
    await enqueue(area, server({ scopes: ['config:read'] }), { title: '只读设备的草稿', url: 'https://draft.example.org/2' });
    const api = { createItem: async () => ({ item: { id: 'x', title: '', folderId: 'none' } }) as never };
    expect((await flushQueue(area, server(), api)).sent).toBe(0);
    expect((await readQueue(area)).map((e) => e.state)).toEqual(['draft', 'draft']);
    expect(await adoptDrafts(area, server())).toBe(2);
    expect((await flushQueue(area, server(), api)).sent).toBe(2);
  });

  it('answers for good finish the entry: already saved, or over the limit (kept, with the reason)', async () => {
    const area = memoryArea();
    await enqueue(area, server(), { title: '重复', url: 'https://dup.example.org/' });
    await enqueue(area, server(), { title: '超限', url: 'https://full.example.org/' });
    const api = {
      createItem: async (_t: string, b: { opId: string; item: { url: string } }) => {
        if (b.item.url.includes('dup')) throw new ApiError('server', '这个网址已经在收藏库里', 409, 'DUPLICATE', { item: { id: 'it-old', title: '原来的', folderId: 'work' } });
        throw new ApiError('server', '收藏库最多 5000 条，请先删除一些', 409, 'QUOTA_EXCEEDED', { kind: 'items', limit: 5000, used: 5000 });
      },
    };
    await flushQueue(area, server(), api);
    const q = await readQueue(area);
    expect(q.find((e) => e.title === '重复')).toMatchObject({ state: 'duplicate', item: { id: 'it-old' } });
    expect(q.find((e) => e.title === '超限')).toMatchObject({ state: 'held', message: expect.stringContaining('5000') });
  });

  it('pinning is only asked for when the device may pin', async () => {
    const area = memoryArea();
    const e = await enqueue(area, server({ scopes: ['config:read', 'items:read', 'items:write'] }), { title: 't', url: 'https://p.example.org/', pinToHome: true });
    expect(e.pinToHome).toBe(false);
  });
});
