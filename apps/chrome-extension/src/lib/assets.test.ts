import { describe, expect, it } from 'vitest';
import { LIMITS, planEviction, type AssetMeta } from './assets';

const DAY = 86_400_000;
const meta = (path: string, usedAt: number, size = 1000, kind: AssetMeta['kind'] = 'icon'): AssetMeta => ({ path, kind, size, fetchedAt: usedAt, usedAt, missing: false });

describe('planEviction', () => {
  it('keeps everything within the limits', () => {
    expect(planEviction([meta('/a', 10), meta('/b', 20)], 30)).toEqual([]);
  });

  it('drops the least recently used beyond the count limits, per kind', () => {
    const limits = { ...LIMITS, icons: 2, wallpapers: 1 };
    const metas = [meta('/i1', 1), meta('/i2', 3), meta('/i3', 2), meta('/w1', 5, 10, 'wallpaper'), meta('/w2', 4, 10, 'wallpaper')];
    expect(planEviction(metas, 10, limits).sort()).toEqual(['/i1', '/w2']);
  });

  it('drops by total size and by age', () => {
    const now = 100 * DAY;
    const limits = { ...LIMITS, bytes: 2500 };
    const metas = [meta('/new', now - 1, 1000), meta('/mid', now - 2, 1000), meta('/old', now - 3, 1000), meta('/idle', now - LIMITS.idle - 1, 1)];
    expect(planEviction(metas, now, limits).sort()).toEqual(['/idle', '/old']);
  });
});
