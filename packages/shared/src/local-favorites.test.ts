import { describe, expect, it } from 'vitest';
import { exportCollection, emptyLocalState, homeView, LocalApiError, localItems, localPostOps, localSnapshot, pinnedIds, readLocalState, type LocalState } from './local-engine';
import { defaultConfig } from './defaults';
import { groupPath, UNFILED } from './groups';
import { STARTER_SITES, STARTER_VERSION } from './favorites';
import type { Item } from './items';
import type { Op } from './ops';

/**
 * UI v2 (v12.0.3 N1/N2/N3) in the browser's local collection (the web's and the extension's): the
 * same rules as the server (spec 06 B03–B15, C06–C10, data side).
 */
let t = Date.UTC(2026, 10, 22);
const now = () => (t += 1000);
let n = 0;
const op = (p = 'op') => `${p}-test-${++n}`;
const live = (s: LocalState) => localItems.snapshot(s).items;
const byTitle = (s: LocalState, title: string) => live(s).find((i) => i.title === title)!;
const post = (s: LocalState, ...ops: Op[]) => localPostOps(s, { clientId: 'c', batchId: op('b'), ops }, now());
const save = (s: LocalState, title: string, url: string, folderId?: string) => localItems.create(s, { opId: op('c'), item: { title, url, ...(folderId ? { folderId } : {}) } }, now()).item;
const roundTrip = (s: LocalState) => readLocalState(JSON.parse(JSON.stringify(s)))!;

describe('C06 / C08 新本地空间：8 个常用网站只放一次，删掉不回来', () => {
  it('a new collection has the eight starter sites as real favorites, all pinned in order, starterVersion 1', () => {
    const s = emptyLocalState('local:new', now());
    expect(s.starterVersion).toBe(STARTER_VERSION);
    expect(localItems.snapshot(s).starterVersion).toBe(STARTER_VERSION);
    expect(live(s).map((i) => i.catalogId)).toEqual(STARTER_SITES.map((x) => x.catalogId));
    expect(pinnedIds(s)).toEqual(STARTER_SITES.map((x) => x.catalogId));
    expect(live(s).every((i) => i.kind === 'app' && i.source === 'catalog' && i.app?.icon?.source === 'library')).toBe(true);
    expect(localSnapshot(s).config.settings.home).toMatchObject({ dockSize: 4, mobileRows: 2, shortcuts: { mode: 'double', pageRows: 1 } });
    expect(s.migrations?.tree).toMatchObject({ fresh: true });
  });

  it('deleting or unpinning them sticks — reading the collection again never puts them back', () => {
    let s = emptyLocalState('local:new', now());
    localItems.unpin(s, 'google', op('u'), now());
    for (const id of ['youtube', 'github']) localItems.remove(s, id, op('d'), undefined, now());
    s = roundTrip(s);
    expect(pinnedIds(s)).not.toContain('google');
    expect(live(s).map((i) => i.id)).not.toContain('youtube');
    for (const i of live(s)) localItems.remove(s, i.id, op('d'), undefined, now());
    s = roundTrip(roundTrip(s));
    expect(live(s)).toEqual([]);
    expect(s.starterVersion).toBe(STARTER_VERSION);
  });

  it('an empty collection (starter: false) stays empty: emptiness is never a reason to seed', () => {
    const s = roundTrip(emptyLocalState('local:tools', now(), { starter: false }));
    expect(live(s)).toEqual([]);
    expect(s.starterVersion).toBeUndefined();
  });
});

describe('B12 一次性迁移（本地）：旧集合的我的服务与首页服务', () => {
  it('unlocks 我的服务 and pins the services the strip showed after the sites; once', () => {
    // A collection from before UI v2: the self-hosted seed (我的服务 locked, services in the strip).
    const legacy = emptyLocalState('local:old', now(), { starter: false });
    const seed = defaultConfig();
    legacy.doc = { ...legacy.doc, categories: seed.categories, settings: { ...legacy.doc.settings, home: { ...legacy.doc.settings.home, showServices: true } } };
    delete legacy.migrations;
    localPostOps(legacy, { clientId: 'x', batchId: 'seed', ops: [{ type: 'config.replace', config: { ...seed, settings: { ...seed.settings } } }] }, now());
    delete legacy.migrations;
    const before = pinnedIds(legacy);
    const s = roundTrip(legacy);
    expect(s.doc.categories.find((k) => k.id === 'hosted')).toMatchObject({ locked: false });
    expect(pinnedIds(s)).toEqual([...before, 'litebox', 'obsync', 'linkwarden']);
    expect(s.migrations?.tree).toMatchObject({ servicesPinned: ['litebox', 'obsync', 'linkwarden'], hostedGroup: { id: 'hosted' } });
    expect(pinnedIds(roundTrip(s))).toEqual(pinnedIds(s));
  });
});

describe('B01 / B03 / B04 / B05 统一保存（本地）', () => {
  it('saves title, group, tags, note, icon, aliases, opening and the pin at once; long text kept', () => {
    const s = emptyLocalState('local:a', now(), { starter: false });
    const page = save(s, '标'.repeat(200), 'https://example.org/long', 'work');
    localItems.patch(s, page.id, { opId: op('p'), baseVersion: page.version, patch: { note: '注'.repeat(2000) } }, now());
    const cur = byTitle(s, '标'.repeat(200));
    const r = localItems.saveFavorite(s, page.id, { opId: op('s'), baseVersion: cur.version, patch: { folderId: 'life', tags: ['长文'], app: { icon: { source: 'letter', ref: '', letter: '标', tone: 1 }, aliases: ['long'], openIn: 'new' }, pin: true } }, now());
    expect(r.item).toMatchObject({ title: '标'.repeat(200), note: '注'.repeat(2000), folderId: 'life', tags: ['长文'], pinned: true, app: { aliases: ['long'], openIn: 'new', icon: { letter: '标' } } });
    expect(pinnedIds(s)).toEqual([page.id]);
  });

  it('a field changed elsewhere after the base is FIELD_CONFLICT with the favorite as it is now', () => {
    const s = emptyLocalState('local:b', now(), { starter: false });
    const page = save(s, '原标题', 'https://example.org/c');
    localItems.patch(s, page.id, { opId: op('p'), baseVersion: page.version, patch: { title: '别处改的' } }, now());
    try {
      localItems.saveFavorite(s, page.id, { opId: op('s'), baseVersion: page.version, patch: { title: '我改的', note: '备注' } }, now());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LocalApiError);
      expect((e as LocalApiError).code).toBe('FIELD_CONFLICT');
      expect((e as LocalApiError).details).toMatchObject({ conflictFields: ['title'], item: { title: '别处改的' } });
    }
    // A field nobody else touched merges.
    expect(localItems.saveFavorite(s, page.id, { opId: op('s2'), baseVersion: page.version, patch: { note: '备注' } }, now()).item.note).toBe('备注');
  });
});

describe('B10 / B11 移动与排序（本地）：三种次序互不改写', () => {
  it('moves within a group and across groups after an anchor; pins and the groups’ order stay', () => {
    const s = emptyLocalState('local:m', now(), { starter: false });
    const [a, b, c] = ['A', 'B', 'C'].map((x) => save(s, x, `https://m.example.org/${x}`, 'work'));
    localItems.pin(s, c!.id, op('pin'), undefined, now());
    localItems.pin(s, a!.id, op('pin'), undefined, now());
    const groupsBefore = s.doc.categories.map((k) => k.id);
    const order = (folder: string) => live(s).filter((i) => i.folderId === folder).sort((x, y) => x.position - y.position).map((i) => i.title);
    expect(order('work')).toEqual(['A', 'B', 'C']);
    localItems.moveItems(s, { opId: op('mv'), ids: [c!.id], folderId: 'work', afterId: null }, now());
    expect(order('work')).toEqual(['C', 'A', 'B']);
    // 上移 / 下移 are the same call with the neighbour as anchor (no drag needed).
    localItems.moveItems(s, { opId: op('mv'), ids: [a!.id], folderId: 'work', afterId: b!.id }, now());
    expect(order('work')).toEqual(['C', 'B', 'A']);
    localItems.moveItems(s, { opId: op('mv'), ids: [b!.id, a!.id], folderId: 'life' }, now());
    expect(order('life')).toEqual(['B', 'A']);
    expect(order('work')).toEqual(['C']);
    expect(pinnedIds(s)).toEqual([c!.id, a!.id]);
    expect(s.doc.categories.map((k) => k.id)).toEqual(groupsBefore);
  });

  it('an anchor gone from the group, or a favorite moved elsewhere since it was shown: refused, nothing moved', () => {
    const s = emptyLocalState('local:n', now(), { starter: false });
    const [a, b] = ['A', 'B'].map((x) => save(s, x, `https://n.example.org/${x}`, 'work'));
    expect(() => localItems.moveItems(s, { opId: op('mv'), ids: [a!.id], folderId: 'life', afterId: b!.id }, now())).toThrow(/不在这个分组/);
    localItems.moveItems(s, { opId: op('mv'), ids: [a!.id], folderId: 'life' }, now());
    try {
      localItems.moveItems(s, { opId: op('mv2'), ids: [a!.id], folderId: 'work', baseVersions: { [a!.id]: a!.version } }, now());
      expect.unreachable();
    } catch (e) {
      expect((e as LocalApiError).code).toBe('FIELD_CONFLICT');
    }
  });
});

describe('B09 删除分组（本地）：收藏移到上级，首页之外的也一样', () => {
  it('pages that the home view does not show follow their group too', () => {
    const s = emptyLocalState('local:d', now(), { starter: false });
    post(s, { type: 'group.create', group: { id: 'proj', label: '项目', parentId: 'work' } });
    const page = save(s, '一篇', 'https://d.example.org/1', 'proj');
    expect(homeView(s).apps.some((a) => a.id === page.id)).toBe(false);
    post(s, { type: 'group.delete', groupId: 'proj' });
    expect(byTitle(s, '一篇').folderId).toBe('work');
    post(s, { type: 'group.delete', groupId: 'work' });
    expect(byTitle(s, '一篇').folderId).toBe(UNFILED);
  });
});

describe('B15 书签导入（本地）：保留层级，同名叶子不合并，可预览可撤销', () => {
  const file = [
    { title: 'MDN', url: 'https://developer.mozilla.org/', path: ['工作', '资料'] },
    { title: '菜谱', url: 'https://recipes.example.org/', path: ['生活', '资料'] },
    { title: '深层', url: 'https://deep.example.org/', path: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
    { title: '根上的', url: 'https://root.example.org/' },
  ];
  it('the preview writes nothing; the import makes nested groups, reusing the ones that exist at the same place', () => {
    const s = emptyLocalState('local:i', now(), { starter: false });
    const revision = s.revision;
    const preview = localItems.previewImportItems(s, { opId: op('pv'), folderMode: 'tree', items: file });
    expect(preview).toMatchObject({ dryRun: true, imported: 4, skipped: 0 });
    expect(preview.folders!.matched.map((m) => m.path.join('/'))).toEqual(['工作', '生活']);
    expect(preview.folders!.create.map((g) => g.path.join('/'))).toEqual(['工作/资料', '生活/资料', 'a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/f', 'a/b/c/d/e/f/g', 'a/b/c/d/e/f/g/h']);
    expect(preview.folders!.overDepth).toEqual(['a / b / c / d / e / f / g / h / i']);
    expect(s.revision).toBe(revision);
    const r = localItems.importItems(s, { opId: op('im'), folderMode: 'tree', items: file }, now());
    expect(r.imported).toBe(4);
    const mdn = byTitle(s, 'MDN');
    const recipes = byTitle(s, '菜谱');
    expect(mdn.folderId).not.toBe(recipes.folderId);
    expect(groupPath(s.doc.categories, mdn.folderId)).toEqual(['工作', '资料']);
    expect(groupPath(s.doc.categories, recipes.folderId)).toEqual(['生活', '资料']);
    expect(groupPath(s.doc.categories, byTitle(s, '深层').folderId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(byTitle(s, '根上的').folderId).toBe(UNFILED);
    // 撤销本次导入: its pages, and the groups it created (now empty).
    const undo = localItems.undoImport(s, r.importId, op('undo'), now());
    expect(undo).toMatchObject({ removed: 4, removedFolders: 10 });
    expect(s.doc.categories.map((k) => k.id).sort()).toEqual(['common', 'life', 'none', 'work']);
  });
});

describe('B13 / B14 备份 v3 往返；v1 / v2 读成根分组', () => {
  it('a v3 export restores the tree, the order in each group, the pins and the advanced fields', () => {
    const src = emptyLocalState('local:src', now());
    post(src, { type: 'group.create', group: { id: 'dev', label: '开发', parentId: 'work' } }, { type: 'group.create', group: { id: 'fe', label: '前端', parentId: 'dev' } });
    const [x, y] = ['X', 'Y'].map((t) => save(src, t, `https://bk.example.org/${t}`, 'fe'));
    localItems.moveItems(src, { opId: op('mv'), ids: [y!.id], folderId: 'fe', afterId: null }, now());
    localItems.saveFavorite(src, x!.id, { opId: op('s'), baseVersion: byTitle(src, 'X').version, patch: { app: { kind: 'service', lanUrl: 'http://10.0.0.2/', prefer: 'lan', aliases: ['xx'] } } }, now());
    const file = exportCollection(src, {}, '2026-11-22T00:00:00.000Z');
    expect(file.version).toBe(3);
    expect(file.folders.find((f) => f.id === 'fe')).toMatchObject({ parentId: 'dev' });
    const dst = emptyLocalState('local:dst', now(), { starter: false });
    localItems.restoreCollection(dst, { opId: op('r'), file, duplicates: 'skip', dryRun: false }, now(), () => 'li-x');
    expect(groupPath(dst.doc.categories, 'fe')).toEqual(['工作', '开发', '前端']);
    const fe = live(dst).filter((i) => i.folderId === 'fe').sort((a, b) => a.position - b.position);
    expect(fe.map((i) => i.title)).toEqual(['Y', 'X']);
    expect(fe[1]!.app).toMatchObject({ kind: 'service', lanUrl: 'http://10.0.0.2/', prefer: 'lan', aliases: ['xx'] });
    expect(pinnedIds(dst)).toEqual(file.pins);
  });

  it('a version 2 file restores as before: its folders become root groups (same name at the root is the same group)', () => {
    const dst = emptyLocalState('local:v2', now(), { starter: false });
    const v2 = { format: 'nexus-collection', version: 2, folders: [{ id: 'old-work', label: '工作' }, { id: 'old-misc', label: '杂项' }], pins: [], items: [{ id: 'a1', kind: 'page', title: 'A', url: 'https://v2.example.org/a', folderId: 'old-misc' }, { id: 'a2', kind: 'page', title: 'B', url: 'https://v2.example.org/b', folderId: 'old-work' }] };
    localItems.restoreCollection(dst, { opId: op('r'), file: v2, duplicates: 'skip', dryRun: false }, now(), () => 'li-x');
    const misc = dst.doc.categories.find((k) => k.label === '杂项')!;
    expect(misc.parentId).toBe(null);
    expect(byTitle(dst, 'A').folderId).toBe(misc.id);
    expect(byTitle(dst, 'B').folderId).toBe('work');
  });
});

describe('C10 本地合并到账号：常用网站按 catalogId / 规范网址去重', () => {
  it('the starter sites of a local collection are duplicates of the account’s, even with an edited address', () => {
    const local = emptyLocalState('local:merge', now());
    const account = emptyLocalState('local:acct', now());
    // The account's copy of 必应 points elsewhere now (the person edited it): still the same catalog entry.
    localItems.saveFavorite(account, 'bing', { opId: op('s'), baseVersion: 1, patch: { url: 'https://cn.bing.com/' } }, now());
    const preview = localItems.restoreCollection(account, { opId: op('pv'), file: exportCollection(local, {}, '2026-11-22T00:00:00.000Z', { onlyUsedFolders: true }), duplicates: 'skip', dryRun: true }, now(), () => 'li-x');
    expect(preview.summary.items).toMatchObject({ create: 0, skip: STARTER_SITES.length });
    expect(preview.summary.duplicateCount).toBe(STARTER_SITES.length);
  });
});

/** (keeps the type import used) */
export type _Item = Item;
