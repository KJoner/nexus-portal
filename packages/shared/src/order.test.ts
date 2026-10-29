import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { desktopShortcuts, mobileShortcuts, paginate } from './layout';
import { applyOp, applyOps, invertOp, normalizeConfig, OpError, type Op } from './ops';
import type { Config } from './schema';

const base = () => defaultConfig();
const inCat = (c: Config, id: string) => c.apps.filter((a) => a.categoryId === id).map((a) => a.id);

function roundTrip(op: Op, c = base()) {
  const inv = invertOp(c, op);
  const after = applyOp(c, op);
  expect(applyOps(after, inv)).toEqual(c);
  return after;
}

describe('manual order of apps and categories', () => {
  it('moves an app inside its category with clamping, undoably', () => {
    expect(inCat(roundTrip({ type: 'app.move', appId: 'claude', toIndex: 0 }), 'work')[0]).toBe('claude');
    expect(inCat(roundTrip({ type: 'app.move', appId: 'gmail', toIndex: 99 }), 'work').at(-1)).toBe('gmail');
    const c = base();
    expect(applyOp(c, { type: 'app.move', appId: 'github', toIndex: 0 })).toBe(c);
  });

  it('moves an app to another category, also an empty one', () => {
    const after = roundTrip({ type: 'app.move', appId: 'figma', categoryId: 'dev', toIndex: 1 });
    expect(inCat(after, 'dev')).toEqual(['github', 'figma', 'vercel', 'cloudflare']);
    const cats = base().categories;
    const c = applyOp(base(), { type: 'categories.replace', categories: [...cats.slice(0, 4), { id: 'read', label: '阅读', locked: false }, cats[4]!] });
    const moved = roundTrip({ type: 'app.move', appId: 'reddit', categoryId: 'read', toIndex: 0 }, c);
    expect(inCat(moved, 'read')).toEqual(['reddit']);
    // Blocks stay contiguous: the new category sits between 影音与社区 and 未分类.
    expect(moved.apps.at(-1)!.id).toBe('reddit');
    expect(normalizeConfig(moved)).toEqual(moved);
  });

  it('keeps services under 我的服务 and sites out of it', () => {
    expect(() => applyOp(base(), { type: 'app.move', appId: 'litebox', categoryId: 'dev', toIndex: 0 })).toThrow(OpError);
    expect(() => applyOp(base(), { type: 'app.move', appId: 'github', categoryId: 'hosted', toIndex: 0 })).toThrow(OpError);
    expect(() => applyOp(base(), { type: 'app.move', appId: 'github', categoryId: 'ghost', toIndex: 0 })).toThrow(OpError);
    expect(inCat(roundTrip({ type: 'app.move', appId: 'linkwarden', toIndex: 0 }), 'hosted')).toEqual(['linkwarden', 'litebox', 'obsync']);
  });

  it('hidden apps keep their place', () => {
    const c = applyOp(base(), { type: 'app.setHidden', appId: 'notion', hidden: true });
    expect(inCat(applyOp(c, { type: 'app.move', appId: 'claude', toIndex: 0 }), 'work')).toEqual(['claude', 'gmail', 'notion', 'figma', 'gdrive', 'gcal', 'chatgpt']);
  });

  it('changing the category in the editor appends to the new category; undo restores the place', () => {
    const notion = base().apps.find((a) => a.id === 'notion')!;
    const after = roundTrip({ type: 'app.upsert', app: { ...notion, categoryId: 'dev' } });
    expect(inCat(after, 'dev').at(-1)).toBe('notion');
  });

  it('new apps join the end of their category; delete + undo restores the exact place', () => {
    const gh = base().apps.find((a) => a.id === 'github')!;
    const after = applyOp(base(), { type: 'app.upsert', app: { ...gh, id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com' } });
    expect(inCat(after, 'dev')).toEqual(['github', 'vercel', 'cloudflare', 'gitlab']);
    expect(normalizeConfig(after)).toEqual(after);
    roundTrip({ type: 'app.delete', appId: 'vercel' }, after);
  });

  it('moves categories and regroups apps, undoably', () => {
    const after = roundTrip({ type: 'category.move', categoryId: 'media', toIndex: 1 });
    expect(after.categories.map((k) => k.id)).toEqual(['hosted', 'media', 'dev', 'work', 'none']);
    expect(after.apps[3]!.id).toBe('youtube');
    expect(normalizeConfig(after)).toEqual(after);
  });

  it('removing a category and undoing it restores every app to its place', () => {
    const c = applyOp(base(), { type: 'app.move', appId: 'telegram', toIndex: 0 });
    roundTrip({ type: 'categories.replace', categories: c.categories.filter((k) => k.id !== 'media') }, c);
  });

  it('pins keep their own order, independent of the apps order', () => {
    const after = applyOp(base(), { type: 'app.move', appId: 'bilibili', toIndex: 0 });
    expect(after.pins).toEqual(base().pins);
  });
});

describe('home shortcut layout', () => {
  const withPins = (n: number, mode: Config['settings']['home']['shortcuts']['mode'] = 'expand') => {
    const sites = base().apps.filter((a) => a.kind === 'site').map((a) => a.id);
    let c = applyOps(base(), [{ type: 'pin.reorder', order: [] }, ...sites.filter((id) => !base().pins.includes(id)).map((appId): Op => ({ type: 'pin.add', appId }))]);
    c = { ...c, pins: c.pins.slice(0, n) };
    return applyOp(c, { type: 'settings.patch', section: 'home', patch: { shortcuts: { ...c.settings.home.shortcuts, mode } } });
  };

  it('keeps the first row stable and sends the rest to the extension', () => {
    const c = withPins(16);
    const d = desktopShortcuts(c);
    expect(d.first.map((a) => a.id)).toEqual(c.pins.slice(0, 5));
    expect(d.extra.map((a) => a.id)).toEqual(c.pins.slice(5));
    // Mobile: 2 rows × 4 minus the 3 services.
    const m = mobileShortcuts(c);
    expect(m.first).toHaveLength(5);
    expect(m.extra).toHaveLength(11);
  });

  it('single-row mode has no extension', () => {
    expect(desktopShortcuts(withPins(16, 'single')).extra).toEqual([]);
    expect(mobileShortcuts(withPins(16, 'single')).extra).toEqual([]);
  });

  it('paginates', () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(paginate([], 4)).toEqual([[]]);
  });
});
