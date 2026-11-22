import { describe, expect, it } from 'vitest';
import raw from './catalog/catalog.json';
import { loadCatalog } from './catalog/catalog';
import { defaultConfig } from './defaults';
import { FavoriteRefused, favoriteConflicts, placeInGroup, planFavoriteUpdate, planTreeMigration, reorderedPositions, STARTER_SITES, starterApp, type FavoriteRow } from './favorites';
import { normalizeConfig } from './ops';
import { MAX_PINS } from './schema';

/** UI v2 (v12.0.3) 统一保存 / 次序 / 常用网站 / 迁移 — the shared rules (spec 06 B03–B05, B10, B12, C06). */
const row = (over: Partial<FavoriteRow> = {}): FavoriteRow => ({
  id: 'it-1',
  kind: 'page',
  title: '长'.repeat(200),
  url: 'https://example.org/a',
  folderId: 'work',
  tags: ['读'],
  note: '记'.repeat(2000),
  iconRef: '',
  catalogId: null,
  extra: '',
  version: 3,
  fieldVersions: {},
  deletedAt: null,
  ...over,
});
const groups = [{ id: 'work' }, { id: 'life' }, { id: 'none' }];

describe('B03 长文本：只改图标 / 别名时，200 字标题和 2000 字备注原样保留', () => {
  it('touches only the extra fields; the home projection never writes a clipped name back', () => {
    const plan = planFavoriteUpdate(row(), { app: { icon: { source: 'letter', ref: '', letter: '长', tone: 2 }, aliases: ['long'] } }, { admin: false, groups });
    expect(plan.set.title).toBeUndefined();
    expect(plan.set.note).toBeUndefined();
    expect(plan.fields.sort()).toEqual(['app.aliases', 'app.icon', 'extra']);
    const extra = JSON.parse(plan.set.extra!);
    expect(extra).toMatchObject({ icon: { source: 'letter', letter: '长' }, aliases: ['long'] });
    expect(extra.name).toBeUndefined();
  });

  it('a value set to what it already is is no change', () => {
    expect(planFavoriteUpdate(row(), { title: '长'.repeat(200), folderId: 'work' }, { admin: false, groups }).fields).toEqual([]);
  });
});

describe('统一保存的规则', () => {
  it('refuses a group that does not exist, a pin of something hidden, and an invalid service address', () => {
    expect(() => planFavoriteUpdate(row(), { folderId: 'ghost' }, { admin: false, groups })).toThrow(FavoriteRefused);
    try {
      planFavoriteUpdate(row(), { app: { hidden: true }, pin: true }, { admin: false, groups });
      expect.unreachable();
    } catch (e) {
      expect((e as FavoriteRefused).code).toBe('NOT_PINNABLE');
    }
    expect(() => planFavoriteUpdate(row(), { app: { kind: 'service', lanUrl: 'javascript:alert(1)' } }, { admin: false, groups })).toThrow(/lanUrl/);
  });

  it('服务状态 stays off for everyone but the administrator (the server never probes for them)', () => {
    const health = { enabled: true, target: '/health', intervalSec: 60 as const };
    const user = planFavoriteUpdate(row(), { app: { kind: 'service', health } }, { admin: false, groups });
    expect(user.healthForcedOff).toBe(true);
    expect(JSON.parse(user.set.extra!).health.enabled).toBe(false);
    const admin = planFavoriteUpdate(row(), { app: { kind: 'service', health } }, { admin: true, groups });
    expect(admin.healthForcedOff).toBe(false);
    expect(JSON.parse(admin.set.extra!).health.enabled).toBe(true);
  });
});

describe('B05 并发版本：字段级冲突', () => {
  it('a field changed elsewhere after the base conflicts; others merge', () => {
    expect(favoriteConflicts({ title: 5, 'app.icon': 4 }, ['title', 'note'], 4)).toEqual(['title']);
    expect(favoriteConflicts({ 'app.aliases': 6, extra: 6 }, ['app.icon', 'extra'], 5)).toEqual([]);
    expect(favoriteConflicts({ 'app.aliases': 6, extra: 6 }, ['app.aliases'], 5)).toEqual(['app.aliases']);
  });

  it('an extra change by an older writer (the home page, which records extra as a whole) conflicts with every app field', () => {
    expect(favoriteConflicts({ extra: 7 }, ['app.icon', 'title'], 6)).toEqual(['app.icon']);
  });
});

describe('B10 分组内次序', () => {
  const g = [
    { id: 'a', position: 1 },
    { id: 'b', position: 2 },
    { id: 'c', position: 3 },
  ];
  it('first, last, after an anchor — between its neighbours, nothing else moves', () => {
    const first = placeInGroup(g, 1, null);
    expect(first.renumber).toBeNull();
    expect(first.positions[0]).toBeLessThan(1);
    expect(placeInGroup(g, 2, undefined).positions).toEqual([4, 5]);
    const mid = placeInGroup(g, 1, 'a');
    expect(mid.positions[0]).toBeGreaterThan(1);
    expect(mid.positions[0]).toBeLessThan(2);
    expect(mid.renumber).toBeNull();
  });

  it('an anchor no longer in the group is ORDER_CONFLICT (never a success that puts it elsewhere)', () => {
    try {
      placeInGroup(g, 1, 'gone');
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 409, code: 'ORDER_CONFLICT', details: { order: ['a', 'b', 'c'] } });
    }
  });

  it('when the gap is used up the group is renumbered in the new order', () => {
    const tight = [
      { id: 'a', position: 1 },
      { id: 'b', position: 1 + 1e-9 },
    ];
    const r = placeInGroup(tight, 1, 'a');
    expect(r.renumber).toEqual([
      { id: 'a', position: 1 },
      { id: 'b', position: 3 },
    ]);
    expect(r.positions).toEqual([2]);
  });

  it('after a reorder of the home page only the favorites out of order get a new position', () => {
    // a b c d e → a d b c e: only d moves.
    const changed = reorderedPositions([
      { id: 'a', position: 1 },
      { id: 'd', position: 4 },
      { id: 'b', position: 2 },
      { id: 'c', position: 3 },
      { id: 'e', position: 5 },
    ]);
    expect([...changed.keys()]).toEqual(['d']);
    expect(changed.get('d')!).toBeGreaterThan(1);
    expect(changed.get('d')!).toBeLessThan(2);
    // A new one (no position yet) at the end goes after the last.
    expect(reorderedPositions([{ id: 'a', position: 1 }, { id: 'n', position: Number.NaN }]).get('n')).toBe(2);
  });
});

describe('C06 新空间的 8 个常用网站：来自公共目录', () => {
  it('each starter site is the public catalog entry, unchanged (no drift between the seed and the catalog)', () => {
    const catalog = loadCatalog(raw);
    expect(STARTER_SITES.map((s) => s.catalogId)).toEqual(['google', 'youtube', 'github', 'gmail', 'bing', 'bilibili', 'chatgpt', 'wikipedia']);
    for (const s of STARTER_SITES) {
      const e = catalog.entries.find((x) => x.stable_id === s.catalogId)!;
      expect(e, s.catalogId).toBeTruthy();
      expect({ name: s.name, url: s.url, iconRef: s.iconRef, aliases: s.aliases, version: s.catalogVersion }).toEqual({ name: e.name, url: e.url, iconRef: e.icon_ref, aliases: e.aliases, version: e.version });
      expect(e.visibility).toBe('public');
      expect(e.status).toBe('active');
      expect(starterApp(s)).toMatchObject({ kind: 'site', catalogId: s.catalogId, health: { enabled: false }, hidden: false });
    }
  });
});

describe('B12 服务迁移：我的服务成为普通分组，首页显示的服务固定在网站之后', () => {
  it('pins the services the strip showed, in its order; hidden or unshown ones are not pinned; nothing is lost', () => {
    const c = normalizeConfig(defaultConfig());
    const plan = planTreeMigration(c, '2026-11-22T00:00:00.000Z');
    expect(plan.categories.find((k) => k.id === 'hosted')).toMatchObject({ locked: false, label: '我的服务', parentId: null });
    expect(plan.record).toMatchObject({ hostedGroup: { id: 'hosted', label: '我的服务' }, showServices: true, servicesPinned: ['litebox', 'obsync', 'linkwarden'], servicesNotPinned: [] });
    expect(plan.pins).toEqual([...c.pins, 'litebox', 'obsync', 'linkwarden']);
    const hidden = { ...c, apps: c.apps.map((a) => (a.id === 'obsync' ? { ...a, hidden: true } : a.id === 'linkwarden' ? { ...a, showInServices: false } : a)) };
    expect(planTreeMigration(hidden, null).record.servicesPinned).toEqual(['litebox']);
    const off = { ...c, settings: { ...c.settings, home: { ...c.settings.home, showServices: false } } };
    expect(planTreeMigration(off, null).pins).toEqual(c.pins);
  });

  it('over the pin limit: the services that do not fit are listed, still favorites, not pinned', () => {
    const c = normalizeConfig(defaultConfig());
    const full = { ...c, pins: Array.from({ length: MAX_PINS - 1 }, (_, i) => `p${i}`) };
    const plan = planTreeMigration(full, null);
    expect(plan.record.servicesPinned).toEqual(['litebox']);
    expect(plan.record.servicesNotPinned).toEqual(['obsync', 'linkwarden']);
    expect(plan.pins).toHaveLength(MAX_PINS);
  });
});
