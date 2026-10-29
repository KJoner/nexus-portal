import { defaultConfig, type GalleryItem, type Settings } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import { candidates, period, pick } from './rotation';
import { wallpaperList } from './Wallpaper';

const look = (over: Partial<Settings['look']> = {}, rotation: Partial<Settings['look']['rotation']> = {}): Settings['look'] => {
  const l = defaultConfig().settings.look;
  return { ...l, ...over, rotation: { ...l.rotation, ...rotation } };
};
const list = wallpaperList([]);
const ids = (c: ReturnType<typeof candidates>) => c.map((x) => (x.kind === 'wallpaper' ? x.entry.id : `gallery:${x.item.id}`));

describe('rotation periods', () => {
  const at = new Date(2026, 9, 29, 15, 40, 0);
  it('is stable within a period and tells when the next one starts', () => {
    expect(period(look({}, { mode: 'off' }).rotation, at)).toBeNull();
    const hourly = period(look({}, { mode: 'hourly' }).rotation, at)!;
    expect(hourly.next).toBe(20 * 60_000);
    expect(period(look({}, { mode: 'hourly' }).rotation, new Date(2026, 9, 29, 15, 59))!.key).toBe(hourly.key);
    expect(period(look({}, { mode: 'daily' }).rotation, at)!.key).toBe('d:2026-10-29');
    expect(period(look({}, { mode: 'interval', minutes: 30 }).rotation, at)!.next).toBe(20 * 60_000);
    expect(period(look({}, { mode: 'open' }).rotation, at)!.next).toBe(Infinity);
  });

  it('picks the same picture for the same period on every device, and shifts with the offset', () => {
    const pool = candidates(look(), list, null);
    const a = pick(pool, 'd:2026-10-29', 0);
    expect(pick(pool, 'd:2026-10-29', 0)).toEqual(a);
    expect(pick(pool, 'd:2026-10-29', 1)).not.toEqual(a);
    expect(pick(pool, 'd:2026-10-29', pool.length)).toEqual(a);
    expect(pick(pool, 'd:2026-10-29', -1)).toEqual(pick(pool, 'd:2026-10-29', pool.length - 1));
    expect(pick([], 'x', 0)).toBeNull();
  });
});

describe('rotation pools', () => {
  const gallery: GalleryItem[] = [
    { id: 'fuji', title: '富士山', category: 'nature', wallpaperId: null },
    { id: 'pudong', title: '浦东', category: 'city', wallpaperId: 'ember' },
    { id: 'aurora', title: '极光', category: 'dark', wallpaperId: null },
  ];

  it('never offers disliked pictures', () => {
    expect(ids(candidates(look({ blocked: ['ember', 'moss'] }), list, null))).toEqual(['fallingwater', 'slate']);
  });

  it('favorites, falling back to the library while there are none', () => {
    expect(ids(candidates(look({ favorites: ['slate'] }, { pool: 'favorites' }), list, null))).toEqual(['slate']);
    expect(ids(candidates(look({}, { pool: 'favorites' }), list, null))).toHaveLength(list.length);
  });

  it('gallery categories; downloaded items are used directly, the rest are fetched first', () => {
    const r = candidates(look({}, { pool: 'gallery', categories: ['nature', 'city'] }), list, gallery);
    expect(ids(r)).toEqual(['gallery:fuji', 'ember']);
    // Catalog not loaded yet (offline, first visit): the library keeps the home page usable.
    expect(ids(candidates(look({}, { pool: 'gallery' }), list, null))).toHaveLength(list.length);
  });
});
