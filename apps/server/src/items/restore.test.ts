import { CLIENT_HEADER, defaultConfig, MAX_PINS, type AppEntry, type Config, type ItemWriteResult, type SnapshotResponse } from '@nexus/shared';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DIALECTS } from '../db/testing';
import { buildTestApp, write, type TestApp } from '../testing/app';
import { fakeIdp } from '../testing/fake-idp';

/**
 * NEX-06 回归：产品 JSON 是可恢复的备份，与浏览器书签导入分开。
 *
 * 审查反例（v0.4 @ 498a037）：带自定义分组 work-folder、固定项、kind=app、catalogId=github 的产品
 * JSON 经 parser/toInputs 与导入 API 导入空账号再导出，kind 变 page、分组变 none、catalogId 变 null、
 * 固定丢失。这里断言：恢复后再导出语义等价；合并导入有预览与冲突选择；撤销只撤该次新增且未被
 * 编辑的部分；整体事务化（失败时什么都不留下，包括图标文件）。
 */
vi.setConfig({ testTimeout: 60_000 });
let n = 0;
const op = (p = 'op') => `${p}-${Date.now().toString(36)}-${++n}`;
type Json = Record<string, unknown> & { code?: string; details?: Record<string, unknown> };
interface Exported {
  format: string;
  version: number;
  folders: { id: string; label: string; locked: boolean }[];
  pins: string[];
  items: (Record<string, unknown> & { id: string; app?: Record<string, unknown> & { icon?: { source: string; ref: string } } })[];
  icons: Record<string, string>;
}
interface Summary {
  folders: { create: { id: string; label: string }[] };
  items: { create: number; update: number; skip: number; kinds: { app: number; page: number } };
  duplicateCount: number;
  pins: { restore: number; notPinned: number };
  icons: { upload: number; missing: number };
}

const REVIEW_FILE = { format: 'nexus-collection', version: 1, folders: [{ id: 'work-folder', label: 'Work' }], pins: ['exported-app'], items: [{ id: 'exported-app', kind: 'app', title: 'Original app', url: 'https://audit.example.org/export', folderId: 'work-folder', tags: ['keep'], note: 'keep', catalogId: 'github', pinned: true }] };

describe.each(DIALECTS)('NEX-06 产品 JSON 恢复 (%s)', (dialect) => {
  let t: TestApp;
  let idp: Awaited<ReturnType<typeof fakeIdp>>;
  const who = async (sub: string) => (await t.loginOidc({ sub: `${sub}-${dialect}`, email: `${sub}@example.org` })).cookie;
  const req = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await t.app.request(path, { method, headers: { ...write, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
  const restore = (cookie: string, file: unknown, opts: { duplicates?: string; dryRun?: boolean; basis?: number; opId?: string } = {}) => req(cookie, 'POST', '/api/v2/import/collection', { opId: opts.opId ?? op('restore'), file, duplicates: opts.duplicates ?? 'skip', dryRun: opts.dryRun ?? false, ...(opts.basis !== undefined ? { basis: opts.basis } : {}) });
  const exportOf = async (cookie: string) => (await req(cookie, 'GET', '/api/v2/export')).body as unknown as Exported;
  const config = async (cookie: string) => ((await req(cookie, 'GET', '/api/config')).body as unknown as { config: Config }).config;
  const ops = (cookie: string, list: unknown[]) => req(cookie, 'POST', '/api/config/ops', { clientId: 'home', batchId: op('b'), ops: list });
  const uploadIcon = async (cookie: string, color: string) => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new File([new Uint8Array(png)], 'icon.png', { type: 'image/png' }));
    const res = await t.app.request('/api/icons', { method: 'POST', headers: { [CLIENT_HEADER]: '1', cookie }, body: form });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const site = (over: Partial<AppEntry>): AppEntry => ({ ...defaultConfig().apps.find((a) => a.id === 'github')!, catalogId: undefined, catalogVersion: undefined, ...over }) as AppEntry;

  beforeAll(async () => {
    idp = await fakeIdp();
    t = await buildTestApp({ dialect, idp, quotas: { items: 40, wallpapers: 50, icons: 200, storageBytes: 1 << 30 } });
  });
  afterAll(() => t.close());

  it('审查反例：产品 JSON 恢复到空账号后再导出，分组、kind、catalogId、固定都还在；首页也一致', async () => {
    const fresh = await who('review');
    const r = await restore(fresh, REVIEW_FILE);
    expect(r.status).toBe(201);
    const exp = await exportOf(fresh);
    expect(exp.items).toHaveLength(1);
    expect(exp.items[0]).toMatchObject({ id: 'exported-app', kind: 'app', title: 'Original app', url: 'https://audit.example.org/export', folderId: 'work-folder', tags: ['keep'], note: 'keep', catalogId: 'github', pinned: true });
    expect(exp.folders.find((f) => f.id === 'work-folder')).toMatchObject({ label: 'Work', locked: false });
    expect(exp.pins).toEqual(['exported-app']);
    const view = await config(fresh);
    expect(view.apps.find((a) => a.id === 'exported-app')).toMatchObject({ categoryId: 'work-folder', catalogId: 'github' });
    expect(view.pins).toEqual(['exported-app']);
  });

  it('新账号 export → 恢复 → export 语义等价：自定义分组、标签、应用与网页、目录关联、上传的图标、固定顺序', async () => {
    const src = await who('roundtrip-src');
    const cats = (await config(src)).categories;
    expect((await ops(src, [{ type: 'categories.replace', categories: [...cats.slice(0, -1), { id: 'reading', label: '阅读', locked: false }, cats.at(-1)] }])).status).toBe(200);
    const ref = await uploadIcon(src, '#335577');
    expect((await ops(src, [{ type: 'app.upsert', app: site({ id: 'my-wiki', name: '我的维基', url: 'https://wiki.example.org/', categoryId: 'reading', aliases: ['wk'], description: '内部文档', icon: { source: 'upload', ref, letter: '', tone: 0 } }), base: null }])).status).toBe(200);
    const page = ((await req(src, 'POST', '/api/v2/items', { opId: op('p'), item: { kind: 'page', title: '一篇文章（标题可以很长）', url: 'https://blog.example.org/post?id=7#part-2', folderId: 'reading', tags: ['读', '收藏'], note: '下周看' } })).body as unknown as ItemWriteResult).item;
    const gh = ((await req(src, 'POST', '/api/v2/items', { opId: op('g'), source: 'catalog', item: { kind: 'app', title: 'GitHub', url: 'https://github.com/', catalogId: 'github', folderId: 'common' } })).body as unknown as ItemWriteResult).item;
    for (const id of [page.id, 'my-wiki', gh.id]) expect((await req(src, 'POST', `/api/v2/pins/${id}`, { opId: op('pin') })).status).toBe(200);
    const a = await exportOf(src);
    expect(a.version).toBe(2);
    expect(a.icons[ref]).toMatch(/^data:image\/png;base64,/);

    const dst = await who('roundtrip-dst');
    const preview = await restore(dst, a, { dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.summary as Summary).toMatchObject({ items: { create: 3, kinds: { app: 2, page: 1 } }, folders: { create: [{ id: 'reading', label: '阅读' }] }, pins: { restore: 3, notPinned: 0 }, icons: { upload: 1, missing: 0 } });
    // Nothing was written by the preview.
    expect(((await req(dst, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items).toEqual([]);
    expect((await restore(dst, a, { basis: preview.body.basis as number })).status).toBe(201);
    const b = await exportOf(dst);

    // Same structure; the icon is the same picture under this account's own id.
    const norm = (e: Exported) => ({
      folders: e.folders,
      pins: e.pins,
      items: e.items.map(({ position: _p, app, ...rest }) => ({ ...rest, ...(app ? { app: { ...app, icon: app.icon?.source === 'upload' ? { ...app.icon, ref: e.icons[app.icon.ref]?.length } : app.icon } } : {}) })),
    });
    expect(norm(b)).toEqual(norm(a));
    const newRef = (b.items.find((i) => i.id === 'my-wiki')!.app!.icon as { ref: string }).ref;
    expect(newRef).not.toBe(ref);
    expect(b.icons[newRef]).toBe(a.icons[ref]);
    // The home page shows the restored app with its settings, in its folder, pinned in order.
    const view = await config(dst);
    expect(view.apps.find((x) => x.id === 'my-wiki')).toMatchObject({ name: '我的维基', categoryId: 'reading', aliases: ['wk'], description: '内部文档', icon: { source: 'upload', ref: newRef } });
    expect(view.pins).toEqual(a.pins);
    // The icon file is the new account's own (served to it, not to the source account by that id).
    expect((await t.app.request(`/api/icons/${newRef}.png`, { headers: { cookie: dst } })).status).toBe(200);
    expect((await t.app.request(`/api/icons/${newRef}.png`, { headers: { cookie: src } })).status).toBe(404);
  });

  it('合并恢复：已在收藏库的地址按选择跳过 / 更新 / 两条都保留，预览与实际一致，无关条目不动', async () => {
    const me = await who('merge');
    const mine = ((await req(me, 'POST', '/api/v2/items', { opId: op('m'), item: { title: '我自己的标题', url: 'https://audit.example.org/export', tags: ['我的'] } })).body as unknown as ItemWriteResult).item;
    const other = ((await req(me, 'POST', '/api/v2/items', { opId: op('o'), item: { title: '无关的', url: 'https://unrelated.example.org/' } })).body as unknown as ItemWriteResult).item;
    const skip = await restore(me, REVIEW_FILE, { dryRun: true });
    expect(skip.body.summary as Summary).toMatchObject({ duplicateCount: 1, items: { create: 0, skip: 1 } });
    const both = await restore(me, REVIEW_FILE, { dryRun: true, duplicates: 'keep-both' });
    expect(both.body.summary as Summary).toMatchObject({ duplicateCount: 1, items: { create: 1, skip: 0 } });
    // Skip: mine stays exactly as it was.
    expect((await restore(me, REVIEW_FILE)).status).toBe(201);
    const after = ((await req(me, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items;
    expect(after.find((i) => i.id === mine.id)).toMatchObject({ title: '我自己的标题', tags: ['我的'], version: 1 });
    // Update: mine takes the backup's fields; the unrelated item is untouched.
    expect((await restore(me, REVIEW_FILE, { duplicates: 'update' })).status).toBe(201);
    const updated = ((await req(me, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items;
    expect(updated.find((i) => i.id === mine.id)).toMatchObject({ title: 'Original app', kind: 'app', catalogId: 'github', folderId: 'work-folder' });
    expect(updated.find((i) => i.id === other.id)).toMatchObject({ title: '无关的', version: 1 });
  });

  it('撤销本次恢复：只撤该次新增且未被编辑的；新建的空分组移除、加上的固定取消；已有的不动', async () => {
    const me = await who('undo');
    const kept = ((await req(me, 'POST', '/api/v2/items', { opId: op('k'), item: { title: '原有的', url: 'https://keep.example.org/' }, pinToHome: true })).body as unknown as ItemWriteResult).item;
    const file = { format: 'nexus-collection', version: 2, folders: [{ id: 'trip', label: '旅行' }, { id: 'books', label: '书单' }], pins: ['p1', 'p2'], items: [
      { id: 'p1', kind: 'page', title: '第一篇', url: 'https://trip.example.org/1', folderId: 'trip' },
      { id: 'p2', kind: 'page', title: '第二篇', url: 'https://trip.example.org/2', folderId: 'trip' },
      { id: 'b1', kind: 'page', title: '一本书', url: 'https://books.example.org/1', folderId: 'books' },
    ] };
    const r = await restore(me, file);
    expect(r.status).toBe(201);
    // Later edited by the person: theirs now.
    expect((await req(me, 'PATCH', '/api/v2/items/b1', { opId: op('e'), baseVersion: 1, patch: { note: '改过了' } })).status).toBe(200);
    const u = await req(me, 'POST', `/api/v2/import/${r.body.importId}/undo`, { opId: op('u') });
    expect(u.body).toMatchObject({ removed: 2, kept: 1, unpinned: 2, removedFolders: 1, keptFolders: 1 });
    const snap = (await req(me, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse;
    expect(snap.items.map((i) => i.id).sort()).toEqual(['b1', kept.id].sort());
    expect(snap.pins).toEqual([kept.id]);
    expect(snap.folders.map((f) => f.id)).toContain('books');
    expect(snap.folders.map((f) => f.id)).not.toContain('trip');
  });

  it('事务化：超出条数上限时整体拒绝，分组、条目、固定、图标（含文件）都没有留下', async () => {
    const me = await who('atomic');
    const before = { cats: (await config(me)).categories, icons: readdirSync(join(t.dir, 'icons')).length };
    const icon = `data:image/png;base64,${(await sharp({ create: { width: 8, height: 8, channels: 4, background: '#aa0000' } }).png().toBuffer()).toString('base64')}`;
    const items = Array.from({ length: 41 }, (_, i) => ({ id: `x${i}`, kind: 'app', title: `应用 ${i}`, url: `https://over.example.org/${i}`, folderId: 'big', app: { kind: 'site', icon: { source: 'upload', ref: 'ic-aaaaaaaaaaaa', letter: '', tone: 0 } } }));
    const r = await restore(me, { format: 'nexus-collection', version: 2, folders: [{ id: 'big', label: '很多' }], pins: ['x0'], items, icons: { 'ic-aaaaaaaaaaaa': icon } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { kind: 'items', limit: 40 } });
    expect((await config(me)).categories).toEqual(before.cats);
    expect(((await req(me, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items).toEqual([]);
    expect(readdirSync(join(t.dir, 'icons')).length).toBe(before.icons);
  });

  it('预览之后收藏库变了：带旧 basis 的恢复返回 PLAN_STALE，什么都不写', async () => {
    const me = await who('stale');
    const preview = await restore(me, REVIEW_FILE, { dryRun: true });
    await req(me, 'POST', '/api/v2/items', { opId: op('later'), item: { title: '预览之后加的', url: 'https://audit.example.org/export' } });
    const r = await restore(me, REVIEW_FILE, { basis: preview.body.basis as number });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PLAN_STALE');
    expect(((await req(me, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items.map((i) => i.title)).toEqual(['预览之后加的']);
  });

  it('格式与版本：更新版本的文件 UNSUPPORTED_VERSION，不是收藏库的文件 VALIDATION', async () => {
    const me = await who('version');
    expect((await restore(me, { ...REVIEW_FILE, version: 3 }, { dryRun: true })).body).toMatchObject({ code: 'UNSUPPORTED_VERSION', details: { version: 3, supported: 2 } });
    expect((await restore(me, { format: 'nexus-config', config: {} }, { dryRun: true })).body.code).toBe('VALIDATION');
  });

  it('固定超过上限：按备份顺序恢复前 36 个，其余如实报告；与首页、收藏库一致', async () => {
    const me = await who('many-pins');
    const items = Array.from({ length: MAX_PINS + 4 }, (_, i) => ({ id: `pin-${i}`, kind: 'page', title: `固定 ${i}`, url: `https://pins.example.org/${i}`, pinned: true }));
    const r = await restore(me, { format: 'nexus-collection', version: 2, folders: [], pins: items.map((i) => i.id), items });
    expect(r.status).toBe(201);
    expect((r.body.summary as Summary).pins).toMatchObject({ restore: MAX_PINS, notPinned: 4 });
    const snap = (await req(me, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse;
    expect(snap.pins).toEqual(items.slice(0, MAX_PINS).map((i) => i.id));
    expect((await config(me)).pins).toEqual(snap.pins);
    expect(snap.items.filter((i) => i.pinned)).toHaveLength(MAX_PINS);
  });

  it('非管理员的备份里打开的健康检查恢复为关闭（服务器不替普通账号访问内网）', async () => {
    const me = await who('health');
    const file = { format: 'nexus-collection', version: 2, folders: [], pins: [], items: [{ id: 'svc', kind: 'app', title: '我的 NAS', url: 'https://nas.example.org/', folderId: 'hosted', app: { kind: 'service', health: { enabled: true, target: '/', intervalSec: 60 }, icon: { source: 'letter', ref: '', letter: 'N', tone: 1 } } }] };
    expect((await restore(me, file)).status).toBe(201);
    expect((await config(me)).apps.find((a) => a.id === 'svc')).toMatchObject({ kind: 'service', categoryId: 'hosted', health: { enabled: false }, icon: { source: 'letter', letter: 'N' } });
  });

  it('浏览器书签导入仍是「网页导入到你选的分组」，与恢复区分', async () => {
    const me = await who('bookmarks');
    const r = await req(me, 'POST', '/api/v2/import', { opId: op('imp'), folderId: 'work', items: [{ title: '书签', url: 'https://bookmark.example.org/' }] });
    expect(r.status).toBe(201);
    expect(((await req(me, 'GET', '/api/v2/snapshot')).body as unknown as SnapshotResponse).items[0]).toMatchObject({ kind: 'page', folderId: 'work', source: 'import', pinned: false });
  });
});
