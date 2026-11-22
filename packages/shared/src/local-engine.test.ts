import { describe, expect, it } from 'vitest';
import { AppSchema, type AppEntry } from './schema';
import { emptyLocalState, exportCollection, homeView, LocalApiError, localCounts, localItems, localPostOps, localSnapshot, pinnedIds, readLocalState, removeLocalWallpaper, addLocalWallpaper, type LocalState } from './local-engine';
import { LOCKED_CATEGORY, MAX_PINS } from './schema';
import { OpError } from './ops';

/** A complete home-page entry (defaults filled in by the schema, as the editor produces it). */
const appEntry = (a: Partial<AppEntry> & Pick<AppEntry, 'id' | 'name' | 'url' | 'categoryId'>): AppEntry => AppSchema.parse({ kind: 'site', icon: { source: 'auto', ref: '', letter: '', tone: 0 }, ...a });

/**
 * 本地收藏 (U1): the browser runs the server's rules. Each test is a behaviour a person relies on —
 * pages they saved stay findable even when not pinned, pins obey the one rule, deletions are
 * explicit, retries never duplicate, and an export restores to the same collection.
 */
const T0 = Date.UTC(2026, 10, 22, 12);
let clock = T0;
const now = () => (clock += 1000);
const fresh = () => emptyLocalState('local:test', T0, { starter: false });
let n = 0;
const op = (k = 'op') => `${k}-${(++n).toString().padStart(8, '0')}`;
const batch = (ops: Parameters<typeof localPostOps>[1]['ops']) => ({ clientId: 'c1', batchId: op('b'), ops });

const savePage = (s: LocalState, title: string, url: string, extra: Partial<Parameters<typeof localItems.create>[1]> = {}) => localItems.create(s, { opId: op(), item: { title, url }, ...extra }, now());

describe('local collection: a fresh browser', () => {
  it('starts from the public template: no private services, nothing pinned', () => {
    const snap = localSnapshot(fresh());
    expect(snap.config.apps).toEqual([]);
    expect(snap.config.pins).toEqual([]);
    expect(snap.config.categories.map((c) => c.id)).toContain(LOCKED_CATEGORY.none);
    expect(snap.config.engines.map((e) => e.id).sort()).toEqual(['bing', 'duckduckgo', 'google']);
    expect(snap.config.settings.search.linkwarden).toBe(false);
  });

  it('reads back what it wrote; anything else reads as nothing', () => {
    const s = fresh();
    savePage(s, '例子', 'https://example.com/a');
    const back = readLocalState(structuredClone(s));
    expect(back && localCounts(back).items).toBe(1);
    expect(readLocalState({ format: 'other' })).toBeNull();
    expect(readLocalState(null)).toBeNull();
  });
});

describe('local collection: saving and finding', () => {
  it('a saved page that is not pinned stays in the collection (and out of the home view)', () => {
    const s = fresh();
    const r = savePage(s, '长文：如何整理收藏', 'https://example.com/long-read?id=7#part-2');
    expect(r.result).toBe('created');
    expect(localItems.snapshot(s).items.map((i) => i.title)).toEqual(['长文：如何整理收藏']);
    expect(homeView(s).apps).toEqual([]);
  });

  it('pinning shows a page on the home page; unpinning keeps it in the collection', () => {
    const s = fresh();
    const r = savePage(s, 'Docs', 'https://docs.example.com', { pinToHome: true });
    expect(r.pin).toEqual({ pinned: true });
    expect(localSnapshot(s).config.pins).toEqual([r.item.id]);
    localItems.unpin(s, r.item.id, op(), now());
    expect(localSnapshot(s).config.pins).toEqual([]);
    expect(localItems.snapshot(s).items).toHaveLength(1);
  });

  it('the same address is reported, updated or kept twice — as asked', () => {
    const s = fresh();
    savePage(s, 'A', 'https://example.com/x');
    expect(() => savePage(s, 'A again', 'https://example.com/x')).toThrow(LocalApiError);
    try {
      savePage(s, 'A again', 'https://example.com/x');
    } catch (e) {
      expect((e as LocalApiError).code).toBe('DUPLICATE');
    }
    expect(savePage(s, 'A renamed', 'https://example.com/x', { duplicatePolicy: 'update' }).result).toBe('updated');
    expect(localItems.snapshot(s).items.map((i) => i.title)).toEqual(['A renamed']);
    savePage(s, 'A copy', 'https://example.com/x', { duplicatePolicy: 'create' });
    expect(localItems.snapshot(s).items).toHaveLength(2);
  });

  it('a retried save (same opId) is answered, never saved twice; another request with it is refused', () => {
    const s = fresh();
    const req = { opId: 'ext-retry-000001', item: { title: 'Once', url: 'https://once.example.com' } };
    const a = localItems.create(s, req, now());
    const b = localItems.create(s, req, now());
    expect(b.item.id).toBe(a.item.id);
    expect(localItems.snapshot(s).items).toHaveLength(1);
    expect(() => localItems.create(s, { ...req, item: { title: 'Other', url: 'https://other.example.com' } }, now())).toThrow(/opId/);
  });

  it('pins obey the one rule: at most MAX_PINS; the save itself is kept', () => {
    const s = fresh();
    for (let i = 0; i < MAX_PINS; i++) savePage(s, `站点 ${i}`, `https://s${i}.example.com`, { pinToHome: true });
    const over = savePage(s, '第 37 个', 'https://s37.example.com', { pinToHome: true });
    expect(over.pin).toMatchObject({ pinned: false, code: 'PINS_FULL', limit: MAX_PINS });
    expect(pinnedIds(s)).toHaveLength(MAX_PINS);
    expect(localItems.snapshot(s).items).toHaveLength(MAX_PINS + 1);
    try {
      localItems.pin(s, over.item.id, op(), undefined, now());
      throw new Error('should refuse');
    } catch (e) {
      expect((e as LocalApiError).code).toBe('QUOTA_EXCEEDED');
    }
  });
});

describe('local collection: the home page edits items (config ops)', () => {
  it('a site added on the home page is an item of the collection, and can be pinned', () => {
    const s = fresh();
    const app = appEntry({ id: 'github', name: 'GitHub', url: 'https://github.com', categoryId: 'common' });
    localPostOps(s, batch([{ type: 'app.upsert', app, base: null }, { type: 'pin.add', appId: 'github' }]), now());
    expect(localSnapshot(s).config.pins).toEqual(['github']);
    const items = localItems.snapshot(s).items;
    expect(items).toMatchObject([{ id: 'github', kind: 'app', title: 'GitHub', pinned: true }]);
  });

  it('a batch applied twice changes once', () => {
    const s = fresh();
    const b = batch([{ type: 'settings.patch', section: 'look', patch: { theme: 'light' } }]);
    localPostOps(s, b, now());
    const rev = s.revision;
    localPostOps(s, b, now());
    expect(s.revision).toBe(rev);
    expect(localSnapshot(s).config.settings.look.theme).toBe('light');
  });

  it('removing from the home page by deleting moves the item to 回收站; an old edit does not bring it back', () => {
    const s = fresh();
    const app = appEntry({ id: 'notes', name: 'Notes', url: 'https://notes.example.com', categoryId: 'common' });
    localPostOps(s, batch([{ type: 'app.upsert', app, base: null }]), now());
    const seen = localSnapshot(s).config.apps[0]!;
    localPostOps(s, batch([{ type: 'app.delete', appId: 'notes' }]), now());
    expect(localItems.trash(s).map((i) => i.id)).toEqual(['notes']);
    expect(() => localPostOps(s, batch([{ type: 'app.upsert', app: { ...seen, name: 'Notes 2' }, base: seen }]), now())).toThrow(OpError);
    // An explicit restore does.
    localPostOps(s, batch([{ type: 'app.restore', app: seen }]), now());
    expect(localSnapshot(s).config.apps.map((a) => a.id)).toEqual(['notes']);
  });

  it('a new app whose id is taken gets its own', () => {
    const s = fresh();
    const app = appEntry({ id: 'mail', name: 'Mail', url: 'https://mail.example.com', categoryId: 'common' });
    localPostOps(s, batch([{ type: 'app.upsert', app, base: null }]), now());
    localPostOps(s, batch([{ type: 'app.upsert', app: { ...app, url: 'https://mail2.example.com' }, base: null }]), now());
    expect(localSnapshot(s).config.apps.map((a) => a.id)).toEqual(['mail', 'mail-2']);
  });
});

describe('local collection: delete and restore are explicit', () => {
  it('a delete of what was edited since is asked again; a stale restore is refused', () => {
    const s = fresh();
    const { item } = savePage(s, 'Draft', 'https://draft.example.com');
    localItems.patch(s, item.id, { opId: op(), baseVersion: item.version, patch: { title: 'Draft v2' } }, now());
    expect(() => localItems.remove(s, item.id, op(), item.version, now())).toThrow(/修改过/);
    const current = localItems.snapshot(s).items[0]!;
    const del = localItems.remove(s, item.id, op(), current.version, now());
    expect(del.result).toBe('deleted');
    const restored = localItems.restore(s, item.id, op(), del.item.version, now());
    expect(restored.result).toBe('restored');
    const again = localItems.remove(s, item.id, op(), restored.item.version, now());
    // A restore made from the first deletion's view must not overturn the newer deletion.
    expect(() => localItems.restore(s, item.id, op(), del.item.version, now())).toThrow(/再次删除/);
    expect(again.item.deletedAt).not.toBeNull();
  });
});

describe('local collection: changes feed', () => {
  it('a reader catches up from its cursor; an unknown cursor asks for a snapshot', () => {
    const s = fresh();
    const snap = localItems.snapshot(s);
    const { item } = savePage(s, 'New', 'https://new.example.com', { pinToHome: true });
    const ch = localItems.changes(s, snap.cursor);
    expect(ch.changes.some((c) => c.entity === 'item' && c.item?.id === item.id)).toBe(true);
    expect(ch.pins).toEqual([item.id]);
    expect(() => localItems.changes(s, 'garbage')).toThrow(LocalApiError);
    expect(() => localItems.changes(s, 'l999999')).toThrow(/游标/);
  });
});

describe('local collection: import, export, restore', () => {
  it('a bookmark import skips addresses already saved and can be undone', () => {
    const s = fresh();
    savePage(s, 'Kept', 'https://kept.example.com');
    const r = localItems.importItems(s, { opId: op('imp'), items: [{ title: 'Kept', url: 'https://kept.example.com' }, { title: 'One', url: 'https://one.example.com' }, { title: 'Two', url: 'https://two.example.com' }] }, now());
    expect(r).toMatchObject({ imported: 2, skipped: 1 });
    expect(localCounts(s).items).toBe(3);
    const undo = localItems.undoImport(s, r.importId, op('undo'), now());
    expect(undo).toMatchObject({ removed: 2, kept: 0 });
    expect(localCounts(s).items).toBe(1);
  });

  it('an export restores into another collection with folders, kinds, pin order and icons', () => {
    const a = fresh();
    localPostOps(a, batch([{ type: 'categories.replace', categories: [...a.doc.categories.filter((k) => k.id !== 'none'), { id: 'reading', label: '稍后读', locked: false }, { id: 'none', label: '未分类', locked: true }] }]), now());
    const app = appEntry({ id: 'design', name: 'Design', url: 'https://design.example.com', categoryId: 'reading', icon: { source: 'upload', ref: 'li-icon000000001', letter: '', tone: 0 } });
    localPostOps(a, batch([{ type: 'app.upsert', app, base: null }, { type: 'pin.add', appId: 'design' }]), now());
    const page = savePage(a, '稍后读的文章', 'https://read.example.com/post', { pinToHome: true });
    const icons = { 'li-icon000000001': 'data:image/png;base64,iVBORw0KGgo=' };
    const file = exportCollection(a, icons, '2026-11-22T12:00:00.000Z');
    expect(exportCollection(a, icons, '2026-11-22T12:00:00.000Z')).toEqual(file);

    const b = fresh();
    const stored: string[] = [];
    const preview = localItems.restoreCollection(b, { opId: op('prev'), file, duplicates: 'skip', dryRun: true }, now(), () => 'unused');
    expect(preview).toMatchObject({ dryRun: true, summary: { items: { create: 2 }, pins: { restore: 2 } } });
    localItems.restoreCollection(b, { opId: op('rest'), file, duplicates: 'skip', dryRun: false, basis: (preview as { basis: number }).basis }, now(), (dataUrl) => {
      stored.push(dataUrl);
      return 'li-restored00001';
    });
    const snap = localSnapshot(b);
    expect(snap.config.categories.some((k) => k.label === '稍后读')).toBe(true);
    expect(snap.config.pins).toEqual(['design', page.item.id]);
    expect(snap.config.apps.find((x) => x.id === 'design')?.icon).toMatchObject({ source: 'upload', ref: 'li-restored00001' });
    expect(stored).toEqual([icons['li-icon000000001']]);
    // Restoring the same file again: everything is already there.
    const again = localItems.restoreCollection(b, { opId: op('rest2'), file, duplicates: 'skip', dryRun: false }, now(), () => 'x');
    expect(again).toMatchObject({ summary: { items: { create: 0, skip: 2 } } });
  });

  it('a merge carries only the folders that hold something; a backup keeps them all', () => {
    const s = fresh();
    savePage(s, '只在收件箱', 'https://inbox.example.com');
    expect(exportCollection(s, {}, '2026-11-22T12:00:00.000Z', { onlyUsedFolders: true }).folders.map((f) => f.id)).toEqual([LOCKED_CATEGORY.none]);
    expect(exportCollection(s, {}, '2026-11-22T12:00:00.000Z').folders.length).toBe(s.doc.categories.length);
  });

  it('a preview is bound to the collection it was made for', () => {
    const s = fresh();
    const file = exportCollection(s, {}, '2026-11-22T12:00:00.000Z');
    const preview = localItems.restoreCollection(s, { opId: op('p'), file, duplicates: 'skip', dryRun: true }, now(), () => 'x') as { basis: number };
    savePage(s, 'Changed meanwhile', 'https://changed.example.com');
    expect(() => localItems.restoreCollection(s, { opId: op('r'), file, duplicates: 'skip', dryRun: false, basis: preview.basis }, now(), () => 'x')).toThrow(/重新预览/);
  });
});

describe('local collection: wallpapers', () => {
  it('removing the wallpaper on screen falls back to the built-in one', () => {
    const s = fresh();
    const w = { id: 'lw-000000000001', name: '我的照片', width: 1920, height: 1080, widths: [1920], placeholder: '', createdAt: new Date(T0).toISOString(), source: 'upload' as const, ref: '', credit: null, luma: null, focal: null };
    addLocalWallpaper(s, w, now());
    localPostOps(s, batch([{ type: 'settings.patch', section: 'look', patch: { wallpaper: w.id } }]), now());
    expect(removeLocalWallpaper(s, w.id, now())).toBe(true);
    expect(localSnapshot(s).config.settings.look.wallpaper).toBe('fallingwater');
  });
});
