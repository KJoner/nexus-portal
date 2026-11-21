import { defaultConfig, type AppEntry, type Config, type Item, type ItemWriteResult } from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIALECTS } from '../db/testing';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp } from '../testing/fake-idp';

/**
 * NEX-04 回归：删除过的收藏只有显式恢复才能回来（ADR-017 I-3）。
 *
 * 审查反例（v0.4 @ 498a037）：旧首页的离线 `app.upsert` 晚于 v2 删除到达，服务端返回 200，
 * `deletedAt` 变回 null、标题成了离线标题。这里断言修复后的正确行为：v1/v2、首页/收藏库、
 * 重试请求都不能让墓碑复活；离线修改以冲突（409 + 当前内容）交还给客户端保留，而不是被覆盖或丢弃。
 */
let n = 0;
const op = (p = 'op') => `${p}-${Date.now().toString(36)}-${++n}`;
type Json = Record<string, unknown> & { code?: string; details?: Record<string, unknown>; error?: { code: string } };

describe.each(DIALECTS)('NEX-04 删除与恢复 (%s)', (dialect) => {
  let t: TestApp;
  let admin: string;
  let member: string;
  const req = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await t.app.request(path, { method, headers: { ...write, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
  const ops = (cookie: string, list: unknown[], batchId = op('batch')) => req(cookie, 'POST', '/api/config/ops', { clientId: 'home', batchId, ops: list });
  const view = async (cookie: string) => ((await req(cookie, 'GET', '/api/config')).body as unknown as { config: Config }).config;
  const appOf = async (cookie: string, id: string) => (await view(cookie)).apps.find((a) => a.id === id);
  const item = async (cookie: string, id: string): Promise<Item | undefined> => {
    const live = ((await req(cookie, 'GET', '/api/v2/items?limit=200')).body.items as Item[]).find((i) => i.id === id);
    return live ?? ((await req(cookie, 'GET', '/api/v2/items?deleted=1&limit=200')).body.items as Item[]).find((i) => i.id === id);
  };
  /** A site created through the home page (v1), as a new client sends it. */
  const newApp = async (cookie: string, id: string, name: string, extra: unknown[] = []) => {
    const gh = defaultConfig().apps.find((a) => a.id === 'github')!;
    const app: AppEntry = { ...gh, id, name, url: `https://${id}.example.org/`, categoryId: 'none', catalogId: undefined, catalogVersion: undefined };
    const r = await ops(cookie, [{ type: 'app.upsert', app, base: null }, ...extra]);
    expect(r.status).toBe(200);
    return (await appOf(cookie, id))!;
  };

  beforeAll(async () => {
    t = await buildTestApp({ dialect, idp: await fakeIdp(), legacyPasswordLogin: 'on' });
    admin = await t.loginLegacy();
    member = (await t.loginOidc({ sub: 'nex04-member', email: 'nex04@example.org' })).cookie;
  });
  afterAll(() => t.close());

  it('审查反例：v2 删除后，旧首页的离线修改不能复活它；修改以冲突交回客户端', async () => {
    const before = await view(admin);
    const stale: AppEntry = { ...before.apps[0]!, name: 'Offline old title' };
    const del = await req(admin, 'DELETE', `/api/v2/items/${stale.id}?opId=${op('del')}`);
    expect(del.status).toBe(200);
    expect((del.body as unknown as ItemWriteResult).item.deletedAt).not.toBeNull();

    // A current client sends the entry it edited from; an older client sends no base at all.
    for (const sent of [{ type: 'app.upsert', app: stale, base: before.apps[0] }, { type: 'app.upsert', app: stale }]) {
      const batchId = op('offline');
      const replay = await ops(admin, [sent], batchId);
      expect(replay.status).toBe(409);
      expect(replay.body).toMatchObject({ code: 'ITEM_DELETED', retryable: false, error: { code: 'deleted' } });
      // What is there now comes along, so the client can show it next to the kept edit.
      expect((replay.body.details!.item as Item).deletedAt).not.toBeNull();
      // A retry of the same batch (lost answer, reconnect) is refused the same way.
      expect((await ops(admin, [sent], batchId)).status).toBe(409);
    }
    const row = await t.deps.repo.items.get('legacy-admin', stale.id);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.title).not.toBe('Offline old title');
    expect((await view(admin)).apps.some((a) => a.id === stale.id)).toBe(false);
  });

  it('冲突的处理「恢复并应用我的修改」：同一批次先显式恢复、再按原 base 应用修改', async () => {
    const a = await newApp(member, 'resolve-me', '原来的名字');
    expect((await req(member, 'DELETE', `/api/v2/items/${a.id}?opId=${op('del')}`)).status).toBe(200);
    const refused = await ops(member, [{ type: 'app.upsert', app: { ...a, name: '离线时改的' }, base: a }]);
    expect(refused.status).toBe(409);
    const current = refused.body.details!.current as AppEntry;
    const tomb = refused.body.details!.item as Item;
    const r = await ops(member, [
      { type: 'app.restore', app: current, baseVersion: tomb.version },
      { type: 'app.upsert', app: { ...a, name: '离线时改的' }, base: a },
    ]);
    expect(r.status).toBe(200);
    expect(await item(member, a.id)).toMatchObject({ deletedAt: null, title: '离线时改的' });
  });

  it('首页「撤销删除」是显式恢复：回到原位置，固定也回来；重试同一批次只恢复一次', async () => {
    const a = await newApp(member, 'undo-me', '要撤销的', [{ type: 'pin.add', appId: 'undo-me' }]);
    const cfg = await view(member);
    const index = cfg.apps.findIndex((x) => x.id === a.id);
    const pinAt = cfg.pins.indexOf(a.id);
    expect((await ops(member, [{ type: 'app.delete', appId: a.id, base: a }])).status).toBe(200);
    expect(await appOf(member, a.id)).toBeUndefined();
    const undo = [{ type: 'app.restore', app: a, index, baseVersion: a.version }, { type: 'pin.add', appId: a.id, index: pinAt }];
    const batchId = op('undo');
    const r = await ops(member, undo, batchId);
    expect(r.status).toBe(200);
    const after = (r.body as unknown as { config: Config }).config;
    expect(after.apps.findIndex((x) => x.id === a.id)).toBe(index);
    expect(after.pins.indexOf(a.id)).toBe(pinAt);
    const restored = (await item(member, a.id))!;
    expect(restored.deletedAt).toBeNull();
    // Lost answer, sent again: the same batch is not applied twice.
    expect((await ops(member, undo, batchId)).status).toBe(200);
    expect((await item(member, a.id))!.version).toBe(restored.version);
  });

  it('旧的撤销不能推翻之后的删除：已被恢复又再次删除时，显式恢复返回 REVISION_CONFLICT', async () => {
    const a = await newApp(member, 'deleted-twice', '删了两次');
    expect((await ops(member, [{ type: 'app.delete', appId: a.id, base: a }])).status).toBe(200);
    // Elsewhere: restored from 回收站, then deliberately deleted again.
    const tomb = (await item(member, a.id))!;
    expect((await req(member, 'POST', `/api/v2/items/${a.id}/restore`, { opId: op('r'), baseVersion: tomb.version })).status).toBe(200);
    expect((await req(member, 'DELETE', `/api/v2/items/${a.id}?opId=${op('d2')}`)).status).toBe(200);
    // This device's undo, made from the version it saw before the first deletion, arrives late.
    const late = await ops(member, [{ type: 'app.restore', app: a, baseVersion: a.version }]);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('REVISION_CONFLICT');
    expect((await item(member, a.id))!.deletedAt).not.toBeNull();
    // The same rule in v2: a restore made from the first tombstone is refused too…
    expect((await req(member, 'POST', `/api/v2/items/${a.id}/restore`, { opId: op('r-old'), baseVersion: tomb.version })).body.code).toBe('REVISION_CONFLICT');
    // …while one made from what 回收站 shows now goes through.
    const now = (await item(member, a.id))!;
    expect((await req(member, 'POST', `/api/v2/items/${a.id}/restore`, { opId: op('r-new'), baseVersion: now.version })).status).toBe(200);
  });

  it('首页编辑按字段三方合并：不同字段都保留，同一字段被别处改过则 FIELD_CONFLICT 且不覆盖', async () => {
    const base = await newApp(member, 'merge-me', '原名称');
    expect((await ops(member, [{ type: 'app.upsert', app: { ...base, name: '设备一改名' }, base }])).status).toBe(200);
    // Device two still has the old entry: a URL change merges with the rename.
    expect((await ops(member, [{ type: 'app.upsert', app: { ...base, url: 'https://merged.example.org/' }, base }])).status).toBe(200);
    expect(await appOf(member, base.id)).toMatchObject({ name: '设备一改名', url: 'https://merged.example.org/' });
    // Its rename would overwrite device one's: refused with what is there now.
    const clash = await ops(member, [{ type: 'app.upsert', app: { ...base, name: '设备二改名' }, base }]);
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'FIELD_CONFLICT', details: { conflictFields: ['name'], current: { name: '设备一改名' } } });
    expect((await appOf(member, base.id))!.name).toBe('设备一改名');
    // v2 PATCH follows the same rule for the same item.
    const now = (await item(member, base.id))!;
    expect((await req(member, 'PATCH', `/api/v2/items/${base.id}`, { opId: op('p'), baseVersion: 1, patch: { title: '收藏库改名' } })).body.code).toBe('FIELD_CONFLICT');
    expect((await req(member, 'PATCH', `/api/v2/items/${base.id}`, { opId: op('p2'), baseVersion: now.version, patch: { title: '收藏库改名' } })).status).toBe(200);
  });

  it('删除别处刚改过的条目要先确认：v1 与 v2 都返回 REVISION_CONFLICT；只是顺序变化不算', async () => {
    const a = await newApp(member, 'edited-elsewhere', '会被改');
    expect((await ops(member, [{ type: 'app.upsert', app: { ...a, name: '别处改过' }, base: a }])).status).toBe(200);
    const v1 = await ops(member, [{ type: 'app.delete', appId: a.id, base: a }]);
    expect(v1.status).toBe(409);
    expect(v1.body.code).toBe('REVISION_CONFLICT');
    expect((await item(member, a.id))!.deletedAt).toBeNull();
    const v2 = await req(member, 'DELETE', `/api/v2/items/${a.id}?opId=${op('d')}&baseVersion=${a.version}`);
    expect(v2.status).toBe(409);
    expect(v2.body).toMatchObject({ code: 'REVISION_CONFLICT', details: { conflictFields: ['title'] } });
    // Only moved elsewhere (another app's order changed its position): the delete goes through.
    const b = await newApp(member, 'only-moved', '只是挪了位置');
    const fresh = (await item(member, b.id))!;
    expect((await ops(member, [{ type: 'app.move', appId: b.id, toIndex: 0 }])).status).toBe(200);
    expect((await item(member, b.id))!.version).toBeGreaterThan(fresh.version);
    expect((await req(member, 'DELETE', `/api/v2/items/${b.id}?opId=${op('d2')}&baseVersion=${fresh.version}`)).status).toBe(200);
  });

  it('新建与回收站中的 id 相同：得到新 id，回收站里的那条原样保留（同批次的固定跟着新 id）', async () => {
    const old = await newApp(member, 'reuse-id', '旧的那条');
    expect((await ops(member, [{ type: 'app.delete', appId: old.id, base: old }])).status).toBe(200);
    const gh = defaultConfig().apps.find((a) => a.id === 'github')!;
    const again: AppEntry = { ...gh, id: 'reuse-id', name: '新的同名应用', url: 'https://reuse-new.example.org/', categoryId: 'none', catalogId: undefined, catalogVersion: undefined };
    const r = await ops(member, [{ type: 'app.upsert', app: again, base: null }, { type: 'pin.add', appId: 'reuse-id' }]);
    expect(r.status).toBe(200);
    const cfg = (r.body as unknown as { config: Config }).config;
    expect(cfg.apps.find((a) => a.id === 'reuse-id-2')?.name).toBe('新的同名应用');
    expect(cfg.pins).toContain('reuse-id-2');
    const tomb = (await item(member, 'reuse-id'))!;
    expect(tomb).toMatchObject({ title: '旧的那条', deletedAt: expect.any(Number) });
  });

  it('首页编辑一个已取消固定的网页：原地修改，仍是网页、不回到首页', async () => {
    const created = (await req(member, 'POST', '/api/v2/items', { opId: op('c'), item: { title: '一篇文章', url: 'https://page.example.org/a?x=1#y' }, pinToHome: true })).body as unknown as ItemWriteResult;
    const shown = (await appOf(member, created.item.id))!;
    expect(shown).toBeDefined();
    expect((await req(member, 'DELETE', `/api/v2/pins/${created.item.id}?opId=${op('unpin')}`)).status).toBe(200);
    const r = await ops(member, [{ type: 'app.upsert', app: { ...shown, name: '首页改的标题' }, base: shown }]);
    expect(r.status).toBe(200);
    expect(await item(member, created.item.id)).toMatchObject({ kind: 'page', title: '首页改的标题', deletedAt: null, pinned: false });
    expect(await appOf(member, created.item.id)).toBeUndefined();
  });

  it('导入整份配置（显式替换）会恢复其中被删除的条目；收藏库 v2 PATCH 仍不能改墓碑', async () => {
    const a = await newApp(member, 'in-backup', '备份里有它');
    const backup = await view(member);
    expect((await ops(member, [{ type: 'app.delete', appId: a.id, base: a }])).status).toBe(200);
    const tomb = (await item(member, a.id))!;
    expect((await req(member, 'PATCH', `/api/v2/items/${a.id}`, { opId: op('p'), baseVersion: tomb.version, patch: { title: '改墓碑' } })).body.code).toBe('ITEM_DELETED');
    expect((await ops(member, [{ type: 'config.replace', config: backup }])).status).toBe(200);
    expect(await item(member, a.id)).toMatchObject({ deletedAt: null, title: '备份里有它' });
  });
});
