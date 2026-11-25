import { defaultConfig, groupPath, MAX_PINS, STARTER_SITES, type Config, type CreateFavoritesAnswer, type Item, type MoveItemsAnswer, type SaveFavoriteAnswer, type SnapshotResponse } from '@nexus/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigRepo } from '../config/repo';
import { LEGACY_ADMIN_ID } from '../db';
import { DIALECTS } from '../db/testing';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp } from '../testing/fake-idp';

/**
 * UI v2 (v12.0.3 N1/N2/N3) on the server: 统一保存、分组树、三种次序、常用网站、服务迁移、导入导出 —
 * spec 06 B01–B16 and C06–C10 (data side), on SQLite and PostgreSQL.
 */
vi.setConfig({ testTimeout: 60_000 });
let n = 0;
const op = (p = 'op') => `${p}-${Date.now().toString(36)}-${++n}`;
type Json = Record<string, unknown> & { code?: string; details?: Record<string, unknown> };

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(dialect: 'sqlite' | 'pg', opts: { starterSites?: boolean } = {}) {
  t = await buildTestApp({ dialect, idp: await fakeIdp(), starterSites: opts.starterSites, quotas: { items: 1000, wallpapers: 50, icons: 200, storageBytes: 1 << 30 } });
  const app = t;
  const as = async (sub: string) => {
    const cookie = (await app.loginOidc({ sub, email: `${sub}@example.org` })).cookie;
    const req = async (method: string, path: string, body?: unknown) => {
      const res = await app.app.request(path, { method, headers: { ...write, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
    };
    const snapshot = async () => (await req('GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse;
    const config = async () => ((await req('GET', '/api/config')).body as unknown as { config: Config }).config;
    const ops = (...list: unknown[]) => req('POST', '/api/config/ops', { clientId: 'web', batchId: op('b'), ops: list });
    const page = async (title: string, url: string, folderId?: string) => ((await req('POST', '/api/v2/items', { opId: op('c'), item: { title, url, ...(folderId ? { folderId } : {}) } })).body as unknown as { item: Item }).item;
    const me = (await req('GET', '/api/v2/me')).body as { account: { id: string } };
    return { req, snapshot, config, ops, page, id: me.account.id };
  };
  return { app, as };
}

const byTitle = (s: SnapshotResponse, title: string) => s.items.find((i) => i.title === title)!;
const orderIn = (s: SnapshotResponse, folderId: string) => s.items.filter((i) => i.folderId === folderId).sort((a, b) => a.position - b.position).map((i) => i.title);

describe.each(DIALECTS)('UI v2 我的收藏 (%s)', (dialect) => {
  it('C07 / C08 / C09 新账号一次性放入 8 个常用网站；删掉不回来；旧账号与管理员不放', async () => {
    const { app, as } = await setup(dialect, { starterSites: true });
    const a = await as(`starter-${dialect}`);
    const first = await a.snapshot();
    expect(first.items.map((i) => i.catalogId)).toEqual(STARTER_SITES.map((s) => s.catalogId));
    expect(first.pins).toEqual(STARTER_SITES.map((s) => s.catalogId));
    expect(first.starterVersion).toBe(1);
    expect((await a.config()).settings.home).toMatchObject({ dockSize: 4, shortcuts: { mode: 'double', pageRows: 1 } });
    const row = await app.db.get<{ v: number; t: string }>('select starter_version as v, tree_migration as t from user_config where owner_id = ?', [a.id]);
    expect(Number(row!.v)).toBe(1);
    expect(JSON.parse(row!.t)).toMatchObject({ fresh: true, pinsAfter: STARTER_SITES.map((s) => s.catalogId) });
    // Deleted and unpinned ones stay so; reading again (or a restarted server) never seeds again.
    for (const i of first.items) expect((await a.req('DELETE', `/api/v2/items/${i.id}?opId=${op('d')}`)).status).toBe(200);
    const again = new ConfigRepo(app.db, undefined, undefined, undefined, { starterSites: true });
    expect((await again.snapshot(a.id)).config.apps).toEqual([]);
    expect((await a.snapshot()).items).toEqual([]);
    // The legacy administrator keeps the self-hosted seed (no starter sites added to it).
    const admin = await again.snapshot(LEGACY_ADMIN_ID);
    expect(admin.config.apps.some((x) => x.id === 'google')).toBe(false);
    expect(Number((await app.db.get<{ v: number }>('select starter_version as v from user_config where owner_id = ?', [LEGACY_ADMIN_ID]))!.v)).toBe(0);
  });

  it('C09 一个在本版之前就有的账号：不补常用网站', async () => {
    const { app, as } = await setup(dialect, { starterSites: false });
    const old = await as(`old-${dialect}`);
    expect((await old.snapshot()).items).toEqual([]);
    const upgraded = new ConfigRepo(app.db, undefined, undefined, undefined, { starterSites: true });
    expect((await upgraded.snapshot(old.id)).config.apps).toEqual([]);
    expect((await old.snapshot()).items).toEqual([]);
  });

  it('B12 服务迁移（管理员的旧集合）：我的服务成为普通分组，首页显示的服务固定在网站之后，并留有记录', async () => {
    const { app } = await setup(dialect);
    const repo = new ConfigRepo(app.db);
    // Before: what the document of a deployment before UI v2 holds.
    const before = await app.db.get<{ data: string }>('select data from user_config where owner_id = ?', [LEGACY_ADMIN_ID]);
    const snap = await repo.snapshot(LEGACY_ADMIN_ID);
    const record = JSON.parse((await app.db.get<{ t: string }>('select tree_migration as t from user_config where owner_id = ?', [LEGACY_ADMIN_ID]))!.t);
    expect(snap.config.categories.find((k) => k.id === 'hosted')).toMatchObject({ locked: false, label: '我的服务' });
    expect(record).toMatchObject({ version: 1, hostedGroup: { id: 'hosted' }, showServices: true, servicesPinned: ['litebox', 'obsync', 'linkwarden'], servicesNotPinned: [] });
    expect(snap.config.pins).toEqual([...record.pinsBefore, 'litebox', 'obsync', 'linkwarden']);
    // The ids, the groups of the services and their order did not change.
    expect(snap.config.apps.filter((x) => x.kind === 'service').map((x) => [x.id, x.categoryId])).toEqual([['litebox', 'hosted'], ['obsync', 'hosted'], ['linkwarden', 'hosted']]);
    // Once only.
    expect((await repo.snapshot(LEGACY_ADMIN_ID)).config.pins).toEqual(snap.config.pins);
    const out = process.env.NM_EVIDENCE_DIR;
    if (out && dialect === 'sqlite') {
      mkdirSync(out, { recursive: true });
      const doc = before ? (JSON.parse(before.data) as Config) : null;
      writeFileSync(join(out, 'service-migration.json'), `${JSON.stringify({ account: 'legacy-admin (self-hosted seed, synthetic)', before: { categories: doc?.categories ?? defaultConfig().categories, pins: record.pinsBefore, showServices: record.showServices }, after: { categories: snap.config.categories, pins: snap.config.pins }, record, counts: { servicesPinned: record.servicesPinned.length, servicesNotPinned: record.servicesNotPinned.length, groupsUnlocked: record.hostedGroup ? 1 : 0, idsChanged: 0, favoritesMoved: 0 } }, null, 2)}\n`);
    }
  });

  it('B01 / B02 / B03 统一保存：一次保存所有字段与固定；服务字段同一个编辑器；长文本不被截断', async () => {
    const { as } = await setup(dialect);
    const a = await as(`save-${dialect}`);
    const p = await a.page('长'.repeat(200), 'https://save.example.org/a', 'work');
    await a.req('PATCH', `/api/v2/items/${p.id}`, { opId: op('n'), baseVersion: p.version, patch: { note: '注'.repeat(2000) } });
    const cur = byTitle(await a.snapshot(), '长'.repeat(200));
    const r = await a.req('PATCH', `/api/v2/favorites/${p.id}`, { opId: op('s'), baseVersion: cur.version, patch: { folderId: 'life', tags: ['服务'], app: { kind: 'service', lanUrl: 'http://192.168.1.2:8080/', prefer: 'lan', icon: { source: 'letter', ref: '', letter: 'N', tone: 1 }, aliases: ['nas'], openIn: 'new' }, pin: true } });
    expect(r.status).toBe(200);
    const saved = (r.body as unknown as SaveFavoriteAnswer).item;
    expect(saved).toMatchObject({ title: '长'.repeat(200), note: '注'.repeat(2000), folderId: 'life', tags: ['服务'], pinned: true, app: { kind: 'service', lanUrl: 'http://192.168.1.2:8080/', prefer: 'lan', aliases: ['nas'], openIn: 'new' } });
    // A service pinned like any favorite: the home page shows it, and its name there is only a view.
    const cfg = await a.config();
    expect(cfg.pins).toEqual([p.id]);
    expect(cfg.apps.find((x) => x.id === p.id)!.name).toHaveLength(32);
    expect(byTitle(await a.snapshot(), '长'.repeat(200)).title).toHaveLength(200);
  });

  it('B04 部分失败：固定被拒时整次保存不写入（不是「已保存」一半）', async () => {
    const { as } = await setup(dialect);
    const a = await as(`atomic-${dialect}`);
    for (let i = 0; i < MAX_PINS; i++) expect((await a.req('POST', '/api/v2/items', { opId: op('c'), item: { title: `固定 ${i}`, url: `https://full.example.org/${i}` }, pinToHome: true })).status).toBe(201);
    const p = await a.page('原来的标题', 'https://full.example.org/x');
    const r = await a.req('PATCH', `/api/v2/favorites/${p.id}`, { opId: op('s'), baseVersion: p.version, patch: { title: '新标题', note: '新备注', pin: true } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('QUOTA_EXCEEDED');
    const now = byTitle(await a.snapshot(), '原来的标题');
    expect(now).toMatchObject({ note: '', version: p.version, pinned: false });
  });

  it('B05 并发：字段冲突返回当前值；同一 opId 重试只保存一次', async () => {
    const { as } = await setup(dialect);
    const a = await as(`conflict-${dialect}`);
    const p = await a.page('标题', 'https://cc.example.org/a');
    await a.req('PATCH', `/api/v2/items/${p.id}`, { opId: op('o'), baseVersion: p.version, patch: { title: '别的设备改的' } });
    const r = await a.req('PATCH', `/api/v2/favorites/${p.id}`, { opId: op('s'), baseVersion: p.version, patch: { title: '我改的', app: { aliases: ['x'] } } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('FIELD_CONFLICT');
    expect(r.body.details).toMatchObject({ conflictFields: ['title'], item: { title: '别的设备改的' } });
    const body = { opId: op('s'), baseVersion: p.version, patch: { app: { aliases: ['x'] } } };
    const once = await a.req('PATCH', `/api/v2/favorites/${p.id}`, body);
    const twice = await a.req('PATCH', `/api/v2/favorites/${p.id}`, body);
    expect(once.status).toBe(200);
    expect(twice.body).toEqual(once.body);
    expect(byTitle(await a.snapshot(), '别的设备改的').version).toBe((once.body as unknown as SaveFavoriteAnswer).item.version);
  });

  it('服务状态只对管理员：普通账号保存时关闭并如实说明', async () => {
    const { as } = await setup(dialect);
    const a = await as(`health-${dialect}`);
    const p = await a.page('NAS', 'https://nas.example.org/');
    const r = await a.req('PATCH', `/api/v2/favorites/${p.id}`, { opId: op('s'), baseVersion: p.version, patch: { app: { kind: 'service', health: { enabled: true, target: '/', intervalSec: 60 } } } });
    expect(r.body).toMatchObject({ healthForcedOff: true, item: { app: { health: { enabled: false } } } });
  });

  it('C02 / C05 批量添加：一次提交；超出固定上限只影响固定，收藏都保存；重复按选择处理', async () => {
    const { as } = await setup(dialect);
    const a = await as(`batch-${dialect}`);
    for (let i = 0; i < MAX_PINS - 1; i++) await a.req('POST', '/api/v2/items', { opId: op('c'), item: { title: `已固定 ${i}`, url: `https://b.example.org/${i}` }, pinToHome: true });
    const items = [
      { kind: 'app', title: 'Figma', url: 'https://www.figma.com', catalogId: 'figma' },
      { kind: 'app', title: 'Notion', url: 'https://www.notion.so', catalogId: 'notion' },
      { kind: 'app', title: 'Linear', url: 'https://linear.app' },
    ];
    const r = await a.req('POST', '/api/v2/favorites', { opId: op('f'), source: 'catalog', folderId: 'work', pin: true, items });
    expect(r.status).toBe(201);
    const ans = r.body as unknown as CreateFavoritesAnswer;
    expect(ans.results.map((x) => x.result)).toEqual(['created', 'created', 'created']);
    expect(ans.pin.pinned).toHaveLength(1);
    expect(ans.pin.notPinned.map((x) => x.code)).toEqual(['PINS_FULL', 'PINS_FULL']);
    expect((await a.snapshot()).items.filter((i) => i.folderId === 'work')).toHaveLength(3);
    // Again: `prompt` refuses the whole request (nothing written), `skip` reports them.
    const dup = await a.req('POST', '/api/v2/favorites', { opId: op('f'), items: [items[0], { title: '新的', url: 'https://new.example.org' }] });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
    expect((await a.snapshot()).items.some((i) => i.title === '新的')).toBe(false);
    const skip = (await a.req('POST', '/api/v2/favorites', { opId: op('f'), duplicatePolicy: 'skip', items: [items[0], { title: '新的', url: 'https://new.example.org' }] })).body as unknown as CreateFavoritesAnswer;
    expect(skip.results.map((x) => x.result)).toEqual(['skipped', 'created']);
  });

  it('B10 / B11 三种次序互不改写：分组内移动不改固定与分组顺序；锚点失效如实拒绝', async () => {
    const { as } = await setup(dialect);
    const a = await as(`order-${dialect}`);
    const [x, y, z] = [await a.page('X', 'https://o.example.org/x', 'work'), await a.page('Y', 'https://o.example.org/y', 'work'), await a.page('Z', 'https://o.example.org/z', 'work')];
    await a.req('POST', `/api/v2/pins/${z.id}`, { opId: op('p') });
    await a.req('POST', `/api/v2/pins/${x.id}`, { opId: op('p') });
    const groups = (await a.config()).categories.map((k) => k.id);
    const pins = (await a.snapshot()).pins;
    const mv = await a.req('POST', '/api/v2/items/move', { opId: op('m'), ids: [z.id], folderId: 'work', afterId: null });
    expect(mv.status).toBe(200);
    expect(orderIn(await a.snapshot(), 'work')).toEqual(['Z', 'X', 'Y']);
    // 下移 without dragging: after the next one.
    await a.req('POST', '/api/v2/items/move', { opId: op('m'), ids: [x.id], folderId: 'work', afterId: y.id });
    expect(orderIn(await a.snapshot(), 'work')).toEqual(['Z', 'Y', 'X']);
    // Across groups, two at once, in the order given.
    const across = (await a.req('POST', '/api/v2/items/move', { opId: op('m'), ids: [x.id, y.id], folderId: 'life' })).body as unknown as MoveItemsAnswer;
    expect(across.items.map((i) => i.folderId)).toEqual(['life', 'life']);
    expect(orderIn(await a.snapshot(), 'life')).toEqual(['X', 'Y']);
    expect((await a.snapshot()).pins).toEqual(pins);
    expect((await a.config()).categories.map((k) => k.id)).toEqual(groups);
    const stale = await a.req('POST', '/api/v2/items/move', { opId: op('m'), ids: [z.id], folderId: 'work', afterId: x.id });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('ORDER_CONFLICT');
  });

  it('B06 / B07 / B08 三层分组往返；非法关系（自身、后代、不存在、别人的分组、未分组）被服务端拒绝', async () => {
    const { as } = await setup(dialect);
    const a = await as(`tree-${dialect}`);
    const b = await as(`tree-other-${dialect}`);
    expect((await a.ops({ type: 'group.create', group: { id: 'proj', label: '项目', parentId: 'work' } }, { type: 'group.create', group: { id: 'docs', label: '资料', parentId: 'proj' } }, { type: 'group.create', group: { id: 'ldocs', label: '资料', parentId: 'life' } })).status).toBe(200);
    const folders = (await a.snapshot()).folders;
    expect(folders.find((f) => f.id === 'docs')).toMatchObject({ parentId: 'proj' });
    expect(folders.find((f) => f.id === 'ldocs')).toMatchObject({ parentId: 'life' });
    expect(groupPath((await a.config()).categories, 'docs')).toEqual(['工作', '项目', '资料']);
    for (const bad of [
      { type: 'group.move', groupId: 'proj', parentId: 'proj' },
      { type: 'group.move', groupId: 'proj', parentId: 'docs' },
      { type: 'group.move', groupId: 'proj', parentId: 'ghost' },
      { type: 'group.create', group: { id: 'x', label: 'X', parentId: 'none' } },
      { type: 'group.create', group: { id: 'x2', label: '资料', parentId: 'proj' } },
    ]) {
      const r = await a.ops(bad);
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    // Another account's group id is not a parent here (it does not exist in this tree).
    expect((await b.ops({ type: 'group.create', group: { id: 'mine', label: '我的', parentId: 'proj' } })).status).toBeGreaterThanOrEqual(400);
    expect(groupPath((await a.config()).categories, 'docs')).toEqual(['工作', '项目', '资料']);
  });

  it('B09 删除分组：首页之外的收藏也移到上级；B16 旧客户端整表替换不压平树', async () => {
    const { as } = await setup(dialect);
    const a = await as(`del-${dialect}`);
    await a.ops({ type: 'group.create', group: { id: 'proj', label: '项目', parentId: 'work' } }, { type: 'group.create', group: { id: 'fe', label: '前端', parentId: 'proj' } });
    await a.page('页面', 'https://del.example.org/p', 'proj');
    // An older client renames 前端 by sending the whole list, without parentId.
    const old = (await a.config()).categories.map(({ parentId: _p, ...k }) => (k.id === 'fe' ? { ...k, label: '前端开发' } : k));
    expect((await a.ops({ type: 'categories.replace', categories: old })).status).toBe(200);
    expect(groupPath((await a.config()).categories, 'fe')).toEqual(['工作', '项目', '前端开发']);
    expect((await a.ops({ type: 'group.delete', groupId: 'proj' })).status).toBe(200);
    const s = await a.snapshot();
    expect(byTitle(s, '页面').folderId).toBe('work');
    expect(s.folders.find((f) => f.id === 'fe')).toMatchObject({ parentId: 'work' });
  });

  it('B09 连同内容删除：收藏先进回收站、再删分组与子分组；回收站读得到，恢复后放到上级（顶层分组则未分组）', async () => {
    const { as } = await setup(dialect);
    const a = await as(`del-content-${dialect}`);
    await a.ops({ type: 'group.create', group: { id: 'proj', label: '项目', parentId: 'work' } }, { type: 'group.create', group: { id: 'docs', label: '资料', parentId: 'proj' } });
    const [p, d, w] = [await a.page('方案', 'https://del-content.example.test/p', 'proj'), await a.page('手册', 'https://del-content.example.test/d', 'docs'), await a.page('周报', 'https://del-content.example.test/w', 'work')];
    // The page's order: every favorite to 回收站 (against the version shown), then the groups, deepest first.
    for (const i of [p, d]) expect((await a.req('DELETE', `/api/v2/items/${i.id}?opId=${op('d')}&baseVersion=${i.version}`)).status).toBe(200);
    expect((await a.ops({ type: 'group.delete', groupId: 'docs' }, { type: 'group.delete', groupId: 'proj' })).status).toBe(200);
    expect((await a.config()).categories.map((k) => k.id)).not.toContain('proj');
    // 回收站 as the page reads it after reopening (the snapshot has live favorites only).
    const trash = (await a.req('GET', '/api/v2/items?deleted=1&limit=200')).body as unknown as { items: Item[] };
    expect(trash.items.map((i) => [i.title, i.folderId]).sort()).toEqual([['手册', 'work'], ['方案', 'work']]);
    expect((await a.snapshot()).items.map((i) => i.title)).toEqual(['周报']);
    const back = await a.req('POST', `/api/v2/items/${d.id}/restore`, { opId: op('r') });
    expect(back.body).toMatchObject({ result: 'restored', item: { folderId: 'work', deletedAt: null } });
    // A top-level group: 未分组.
    expect((await a.req('DELETE', `/api/v2/items/${w.id}?opId=${op('d')}&baseVersion=${w.version}`)).status).toBe(200);
    expect((await a.ops({ type: 'group.delete', groupId: 'work' })).status).toBe(200);
    expect(((await a.req('POST', `/api/v2/items/${w.id}/restore`, { opId: op('r') })).body as unknown as { item: Item }).item.folderId).toBe('none');
    expect(((await a.req('POST', `/api/v2/items/${p.id}/restore`, { opId: op('r') })).body as unknown as { item: Item }).item.folderId).toBe('none');
  });

  it('B15 书签导入：保留层级、预览不写入、同名叶子不合并、撤销删掉新建的空分组', async () => {
    const { as } = await setup(dialect);
    const a = await as(`import-${dialect}`);
    const items = [
      { title: 'MDN', url: 'https://developer.mozilla.org/', path: ['工作', '资料'] },
      { title: '菜谱', url: 'https://recipes.example.org/', path: ['生活', '资料'] },
    ];
    const preview = await a.req('POST', '/api/v2/import', { opId: op('i'), folderMode: 'tree', items, dryRun: true });
    expect(preview.body).toMatchObject({ dryRun: true, imported: 2, folders: { overDepth: [], overLimit: 0 } });
    expect((await a.snapshot()).items).toEqual([]);
    const r = await a.req('POST', '/api/v2/import', { opId: op('i'), folderMode: 'tree', items });
    expect(r.status).toBe(201);
    const s = await a.snapshot();
    const cats = (await a.config()).categories;
    expect(groupPath(cats, byTitle(s, 'MDN').folderId)).toEqual(['工作', '资料']);
    expect(groupPath(cats, byTitle(s, '菜谱').folderId)).toEqual(['生活', '资料']);
    const undo = await a.req('POST', `/api/v2/import/${(r.body as { importId: string }).importId}/undo`, { opId: op('u') });
    expect(undo.body).toMatchObject({ removed: 2, removedFolders: 2 });
    expect((await a.config()).categories.map((k) => k.id).sort()).toEqual(['common', 'life', 'none', 'work']);
  });

  it('B13 / B14 备份 v3 往返保留树、次序、固定与高级字段；v2 文件的分组成为根分组', async () => {
    const { as } = await setup(dialect);
    const src = await as(`bk-src-${dialect}`);
    await src.ops({ type: 'group.create', group: { id: 'dev', label: '开发', parentId: 'work' } });
    const [x, y] = [await src.page('X', 'https://bk.example.org/x', 'dev'), await src.page('Y', 'https://bk.example.org/y', 'dev')];
    await src.req('POST', '/api/v2/items/move', { opId: op('m'), ids: [y.id], folderId: 'dev', afterId: null });
    await src.req('PATCH', `/api/v2/favorites/${x.id}`, { opId: op('s'), baseVersion: x.version, patch: { app: { kind: 'service', lanUrl: 'http://10.0.0.9/', aliases: ['xx'] }, pin: true } });
    const file = (await src.req('GET', '/api/v2/export')).body as unknown as { version: number; folders: { id: string; parentId?: string | null }[] };
    expect(file.version).toBe(3);
    expect(file.folders.find((f) => f.id === 'dev')).toMatchObject({ parentId: 'work' });
    const dst = await as(`bk-dst-${dialect}`);
    expect((await dst.req('POST', '/api/v2/import/collection', { opId: op('r'), file })).status).toBe(201);
    const s = await dst.snapshot();
    expect(groupPath((await dst.config()).categories, 'dev')).toEqual(['工作', '开发']);
    expect(orderIn(s, 'dev')).toEqual(['Y', 'X']);
    expect(byTitle(s, 'X')).toMatchObject({ pinned: true, app: { kind: 'service', lanUrl: 'http://10.0.0.9/', aliases: ['xx'] } });
    const v2 = { format: 'nexus-collection', version: 2, folders: [{ id: 'misc', label: '杂项' }], pins: [], items: [{ id: 'm1', kind: 'page', title: '旧', url: 'https://v2.example.org/', folderId: 'misc' }] };
    expect((await dst.req('POST', '/api/v2/import/collection', { opId: op('r2'), file: v2 })).status).toBe(201);
    const misc = (await dst.config()).categories.find((k) => k.label === '杂项')!;
    expect(misc.parentId ?? null).toBe(null);
    expect(byTitle(await dst.snapshot(), '旧').folderId).toBe(misc.id);
  });
});
