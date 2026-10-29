import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { applyOp, applyOps, invertOp, normalizeConfig, OpError, type Op } from './ops';
import { ConfigSchema, MAX_PINS } from './schema';

const base = () => defaultConfig();

/** Applies op, then its inverse, and expects the original config back. */
function roundTrip(op: Op, c = base()) {
  const inv = invertOp(c, op);
  const after = applyOp(c, op);
  expect(applyOps(after, inv)).toEqual(c);
  return after;
}

describe('default config', () => {
  it('is valid against the schema and already normalized', () => {
    expect(ConfigSchema.safeParse(base()).success).toBe(true);
    expect(normalizeConfig(base())).toEqual(base());
  });
});

describe('documents written by v0.1', () => {
  // v0.1 had no `home.shortcuts` and at most 12 pins; both must load unchanged.
  const v01 = () => {
    const c = base() as unknown as { settings: { home: Record<string, unknown> }; pins: string[] };
    delete c.settings.home.shortcuts;
    c.pins = ['github', 'gmail', 'youtube', 'bilibili', 'notion', 'vercel', 'cloudflare', 'figma', 'gdrive', 'gcal', 'chatgpt', 'claude'];
    return c;
  };

  it('parse with the new defaults and keep the pin order', () => {
    const r = ConfigSchema.parse(v01());
    expect(r.settings.home.shortcuts).toEqual({ mode: 'expand', pageRows: 2, pager: true, remember: false });
    expect(normalizeConfig(r).pins).toEqual(v01().pins);
  });

  it('keep the order inside each category when apps are regrouped', () => {
    const c = ConfigSchema.parse(v01());
    const shuffled = { ...c, apps: [...c.apps].reverse() };
    const byCat = (x: typeof c) => Object.fromEntries(x.categories.map((k) => [k.id, x.apps.filter((a) => a.categoryId === k.id).map((a) => a.id)]));
    const out = normalizeConfig(shuffled);
    expect(byCat(out)).toEqual(byCat(shuffled));
    const rank = (id: string) => c.categories.findIndex((k) => k.id === id);
    expect(out.apps.every((a, i) => i === 0 || rank(out.apps[i - 1]!.categoryId) <= rank(a.categoryId))).toBe(true);
  });
});

describe('pins', () => {
  it('adds at the end or at an index and ignores duplicates', () => {
    const c = base();
    expect(applyOp(c, { type: 'pin.add', appId: 'vercel' }).pins.at(-1)).toBe('vercel');
    expect(applyOp(c, { type: 'pin.add', appId: 'vercel', index: 0 }).pins[0]).toBe('vercel');
    expect(applyOp(c, { type: 'pin.add', appId: 'github' })).toBe(c);
  });

  it('refuses services, hidden apps and a full list', () => {
    const c = base();
    expect(() => applyOp(c, { type: 'pin.add', appId: 'litebox' })).toThrow(OpError);
    const hidden = applyOp(c, { type: 'app.setHidden', appId: 'vercel', hidden: true });
    expect(() => applyOp(hidden, { type: 'pin.add', appId: 'vercel' })).toThrow(/不能固定/);
    const gh = c.apps.find((a) => a.id === 'github')!;
    const many = applyOps(
      c,
      Array.from({ length: MAX_PINS }, (_, i): Op => ({ type: 'app.upsert', app: { ...gh, id: `site-${i}`, name: `Site ${i}`, url: `https://s${i}.example.com` } })),
    );
    const sites = many.apps.filter((a) => a.kind === 'site' && !c.pins.includes(a.id)).map((a) => a.id);
    const room = MAX_PINS - c.pins.length;
    const full = applyOps(many, sites.slice(0, room).map((appId): Op => ({ type: 'pin.add', appId })));
    expect(full.pins).toHaveLength(MAX_PINS);
    try {
      applyOp(full, { type: 'pin.add', appId: sites[room]! });
      expect.unreachable();
    } catch (e) {
      expect((e as OpError).code).toBe('pins_full');
    }
  });

  it('moves with clamping', () => {
    const c = base();
    expect(applyOp(c, { type: 'pin.move', appId: 'github', toIndex: 99 }).pins.at(-1)).toBe('github');
    expect(applyOp(c, { type: 'pin.move', appId: 'notion', toIndex: -3 }).pins[0]).toBe('notion');
  });

  it('reorder merges with pins another device added meanwhile', () => {
    const c = applyOp(base(), { type: 'pin.add', appId: 'figma' });
    const next = applyOp(c, { type: 'pin.reorder', order: ['notion', 'github', 'gmail', 'youtube', 'bilibili', 'ghost'] });
    expect(next.pins).toEqual(['notion', 'github', 'gmail', 'youtube', 'bilibili', 'figma']);
  });

  it('every pin op is undoable', () => {
    roundTrip({ type: 'pin.add', appId: 'vercel', index: 2 });
    roundTrip({ type: 'pin.remove', appId: 'youtube' });
    roundTrip({ type: 'pin.move', appId: 'github', toIndex: 3 });
    roundTrip({ type: 'pin.reorder', order: ['notion', 'gmail', 'github', 'youtube', 'bilibili'] });
  });
});

describe('hide / delete', () => {
  it('hiding unpins, and undo restores the original position', () => {
    const after = roundTrip({ type: 'app.setHidden', appId: 'youtube', hidden: true });
    expect(after.pins).not.toContain('youtube');
  });

  it('delete is undoable including list position and pin', () => {
    const after = roundTrip({ type: 'app.delete', appId: 'gmail' });
    expect(after.apps.find((a) => a.id === 'gmail')).toBeUndefined();
  });

  it('upsert of an existing app keeps its pin unless it becomes a service', () => {
    const c = base();
    const gh = c.apps.find((a) => a.id === 'github')!;
    expect(applyOp(c, { type: 'app.upsert', app: { ...gh, name: 'GH' } }).pins).toContain('github');
    expect(applyOp(c, { type: 'app.upsert', app: { ...gh, kind: 'service' } }).pins).not.toContain('github');
    roundTrip({ type: 'app.upsert', app: { ...gh, name: 'GH' } });
  });

  it('rejects invalid apps', () => {
    const gh = base().apps.find((a) => a.id === 'github')!;
    expect(() => applyOp(base(), { type: 'app.upsert', app: { ...gh, url: 'javascript:alert(1)' } })).toThrow(OpError);
  });
});

describe('settings, categories and engines', () => {
  it('patches a section with validation and undo', () => {
    const after = roundTrip({ type: 'settings.patch', section: 'home', patch: { dockSize: 7 } });
    expect(after.settings.home.dockSize).toBe(7);
    expect(() => applyOp(base(), { type: 'settings.patch', section: 'home', patch: { dockSize: 9 } })).toThrow(OpError);
  });

  it('keeps locked categories and moves orphans to 未分类', () => {
    const c = base();
    expect(() => applyOp(c, { type: 'categories.replace', categories: c.categories.filter((k) => k.id !== 'none') })).toThrow(/不能删除/);
    const after = roundTrip({ type: 'categories.replace', categories: c.categories.filter((k) => k.id !== 'media') });
    expect(after.apps.find((a) => a.id === 'youtube')!.categoryId).toBe('none');
  });

  it('deleting the default engine falls back and undo restores it', () => {
    let c = applyOp(base(), { type: 'engine.upsert', engine: { id: 'mdn', name: 'MDN', urlTemplate: 'https://developer.mozilla.org/search?q=%s', prefix: 'mdn', builtin: false, kind: 'web', icon: '' } });
    c = applyOp(c, { type: 'settings.patch', section: 'search', patch: { defaultEngine: 'mdn' } });
    const after = roundTrip({ type: 'engine.delete', engineId: 'mdn' }, c);
    expect(after.settings.search.defaultEngine).toBe('google');
    expect(() => applyOp(c, { type: 'engine.delete', engineId: 'google' })).toThrow(OpError);
  });
});
