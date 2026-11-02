import { defaultConfig, type DailyResponse, type GalleryItem, type OpBatch, type Settings, type UploadedWallpaper } from '@nexus/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../components/toast-store';
import { flush, refresh, resetSync, useConfigStore } from '../../data/config-store';
import { HttpError, MemoryTransport, NetworkError } from '../../data/transport';
import { homeActions } from './actions';
import { candidates, period, pick, useDailyEntry, useDailyStore, utcDay } from './rotation';
import { entryOf, wallpaperList } from './Wallpaper';

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

describe('每日一图', () => {
  const DAILY_KEY = 'nexus.wallpaper.daily.v2';
  const picture = (id: string, over: Partial<UploadedWallpaper> = {}): UploadedWallpaper => ({ id, name: `每日一图 ${id}`, width: 3000, height: 2000, widths: [1280], placeholder: '', createdAt: '', source: 'daily', ref: '', credit: null, luma: 0.4, focal: null, ...over });
  const answer = (date: string, id: string): DailyResponse => ({ date, wallpaper: picture(id) });

  class Server extends MemoryTransport {
    asked = 0;
    next: () => Promise<DailyResponse> = () => Promise.reject(new NetworkError());
    kept: UploadedWallpaper[] = [];
    // Like the real server, every answer carries the library.
    override async getConfig() {
      return { ...(await super.getConfig()), wallpapers: this.kept };
    }
    override async postOps(batch: OpBatch) {
      return { ...(await super.postOps(batch)), wallpapers: this.kept };
    }
    override async dailyWallpaper() {
      this.asked++;
      return this.next();
    }
    override async keepDaily(id = '') {
      const copy = picture('up-kept0000000', { source: 'saved', ref: id });
      this.kept.push(copy);
      return copy;
    }
  }

  let server: Server;
  const daily = () => useDailyStore.getState();
  const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const check = async () => {
    daily().check();
    await settle();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    at('2026-11-02T12:00:00Z');
    localStorage.clear();
    server = new Server();
    resetSync(server);
    useDailyStore.setState({ current: null, loading: false, fails: 0, retryAt: 0 });
    useToastStore.setState({ current: null });
  });
  afterEach(() => vi.useRealTimers());

  it('the day is the UTC day, on either side of the date line', () => {
    expect(utcDay(new Date('2026-11-02T23:59:59Z'))).toBe('2026-11-02');
    expect(utcDay(new Date('2026-11-03T07:59:00+08:00'))).toBe('2026-11-02');
    expect(utcDay(new Date('2026-11-02T16:00:00-08:00'))).toBe('2026-11-03');
  });

  it('asks once a day and survives a reload', async () => {
    server.next = async () => answer('2026-11-02', 'dl-aaaaaaaaaaaa');
    await check();
    await check();
    expect(server.asked).toBe(1);
    expect(daily().current?.wallpaper.id).toBe('dl-aaaaaaaaaaaa');
    expect(JSON.parse(localStorage.getItem(DAILY_KEY)!)).toMatchObject({ date: '2026-11-02' });

    // A new day asks again, with no reload and no help from settings.
    at('2026-11-03T00:00:01Z');
    server.next = async () => answer('2026-11-03', 'dl-bbbbbbbbbbbb');
    await check();
    expect(server.asked).toBe(2);
    expect(daily().current?.wallpaper.id).toBe('dl-bbbbbbbbbbbb');
  });

  it('with browser storage disabled it still asks only once a day', async () => {
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    server.next = async () => answer('2026-11-02', 'dl-aaaaaaaaaaaa');
    await check();
    await check();
    blocked.mockRestore();
    expect(server.asked).toBe(1);
    expect(daily().current?.wallpaper.id).toBe('dl-aaaaaaaaaaaa');
  });

  it('a new picture writes nothing to the configuration', async () => {
    server.next = async () => answer('2026-11-02', 'dl-aaaaaaaaaaaa');
    await refresh();
    const { revision } = useConfigStore.getState().snapshot;
    const look = useConfigStore.getState().snapshot.config.settings.look;
    await check();
    await flush();
    expect(server.calls).toEqual([]);
    expect(useConfigStore.getState().snapshot.revision).toBe(revision);
    expect(useConfigStore.getState().snapshot.config.settings.look).toEqual(look);
    expect(useConfigStore.getState().wallpapers).toEqual([]);
  });

  it('a failure keeps the last picture and retries with growing pauses', async () => {
    useDailyStore.setState({ current: answer('2026-11-02', 'dl-aaaaaaaaaaaa') });
    at('2026-11-03T00:00:01Z');
    await check();
    expect(server.asked).toBe(1);
    expect(daily().current?.wallpaper.id).toBe('dl-aaaaaaaaaaaa');

    await check();
    expect(server.asked).toBe(1); // still within the pause
    vi.advanceTimersByTime(60_000);
    await check();
    expect(server.asked).toBe(2);
    vi.advanceTimersByTime(60_000);
    await check();
    expect(server.asked).toBe(2); // the second pause is twice as long
    vi.advanceTimersByTime(60_000);
    await check();
    expect(server.asked).toBe(3);
    expect(daily().current?.wallpaper.id).toBe('dl-aaaaaaaaaaaa');

    server.next = async () => answer('2026-11-03', 'dl-bbbbbbbbbbbb');
    vi.advanceTimersByTime(4 * 60_000);
    await check();
    expect(daily()).toMatchObject({ fails: 0, retryAt: 0, current: { date: '2026-11-03' } });
  });

  it('never waits more than half an hour', async () => {
    useDailyStore.setState({ fails: 20 });
    const t = Date.now();
    await check();
    expect(daily().retryAt).toBe(t + 30 * 60_000);
  });

  it('an older picture from a server that cannot reach the source counts as not yet', async () => {
    useDailyStore.setState({ current: answer('2026-11-01', 'dl-aaaaaaaaaaaa') });
    server.next = async () => answer('2026-11-02', 'dl-bbbbbbbbbbbb');
    at('2026-11-03T08:00:00Z');
    await check();
    expect(daily().current?.date).toBe('2026-11-02');
    expect(daily().retryAt).toBeGreaterThan(Date.now());
    await check();
    expect(server.asked).toBe(1);
  });

  it('does not ask when another tab already has it, or when this clock runs late', async () => {
    localStorage.setItem(DAILY_KEY, JSON.stringify(answer('2026-11-02', 'dl-aaaaaaaaaaaa')));
    await check();
    expect(server.asked).toBe(0);
    expect(daily().current?.wallpaper.id).toBe('dl-aaaaaaaaaaaa');
    useDailyStore.setState({ current: answer('2026-11-03', 'dl-bbbbbbbbbbbb') });
    await check();
    expect(server.asked).toBe(0);
  });

  it('checks when shown, once a minute, when the page returns and when the network does', async () => {
    server.next = async () => answer(utcDay(new Date()), 'dl-aaaaaaaaaaaa');
    const { result, rerender } = renderHook(({ on }) => useDailyEntry(on), { initialProps: { on: false } });
    await settle();
    expect(server.asked).toBe(0);
    rerender({ on: true });
    await settle();
    expect(server.asked).toBe(1);
    expect(result.current?.id).toBe('dl-aaaaaaaaaaaa');

    // Past midnight on an open page: the minute check notices.
    at('2026-11-03T00:00:00Z');
    server.next = async () => answer('2026-11-03', 'dl-bbbbbbbbbbbb');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(server.asked).toBe(2);
    expect(result.current?.id).toBe('dl-bbbbbbbbbbbb');

    // A hidden page waits until it is looked at.
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    at('2026-11-04T00:00:00Z');
    server.next = async () => answer('2026-11-04', 'dl-cccccccccccc');
    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(server.asked).toBe(2);
    hidden.mockRestore();
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(server.asked).toBe(3);

    // Back online: no need to sit out the pause.
    at('2026-11-05T00:00:00Z');
    server.next = () => Promise.reject(new NetworkError());
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(daily().retryAt).toBeGreaterThan(Date.now());
    server.next = async () => answer('2026-11-05', 'dl-dddddddddddd');
    act(() => void window.dispatchEvent(new Event('online')));
    await settle();
    expect(result.current?.id).toBe('dl-dddddddddddd');
  });

  it('a kept picture is shown through its library copy', async () => {
    useDailyStore.setState({ current: answer('2026-11-02', 'dl-aaaaaaaaaaaa') });
    const { result } = renderHook(() => useDailyEntry(true));
    expect(result.current?.id).toBe('dl-aaaaaaaaaaaa');
    act(() => useConfigStore.setState({ wallpapers: [picture('up-kept0000000', { source: 'saved', ref: 'dl-aaaaaaaaaaaa' })] }));
    expect(result.current?.id).toBe('up-kept0000000');
  });

  it('收藏 makes the library copy first and stars that one', async () => {
    await refresh();
    await homeActions.toggleFavorite(entryOf(picture('dl-aaaaaaaaaaaa')));
    expect(server.kept).toHaveLength(1);
    const state = useConfigStore.getState();
    expect(state.wallpapers.map((w) => w.id)).toEqual(['up-kept0000000']);
    expect(state.snapshot.config.settings.look.favorites).toEqual(['up-kept0000000']);
    await flush();
    expect(server.config.settings.look.favorites).toEqual(['up-kept0000000']);
  });

  it('锁定 fixes the library copy, never the cached picture that will expire', async () => {
    await refresh();
    server.config = { ...server.config, settings: { ...server.config.settings, look: { ...server.config.settings.look, rotation: { ...server.config.settings.look.rotation, mode: 'potd' } } } };
    await refresh();
    await homeActions.lock(entryOf(picture('dl-aaaaaaaaaaaa')));
    await flush();
    expect(server.config.settings.look).toMatchObject({ wallpaper: 'up-kept0000000', rotation: { mode: 'off' } });
  });

  it('a picture that can no longer be kept says so and changes nothing', async () => {
    await refresh();
    server.keepDaily = () => Promise.reject(new HttpError(404, 'not_found', '这张每日一图已经过期，无法收藏'));
    await homeActions.toggleFavorite(entryOf(picture('dl-aaaaaaaaaaaa')));
    await flush();
    expect(useToastStore.getState().current).toMatchObject({ msg: '这张每日一图已经过期，无法收藏', tone: 'error' });
    expect(server.config.settings.look.favorites).toEqual([]);
  });

  it('other sources are unaffected: an ordinary wallpaper is starred directly', async () => {
    await refresh();
    await homeActions.toggleFavorite(wallpaperList([])[0]!);
    await flush();
    expect(server.config.settings.look.favorites).toEqual(['fallingwater']);
    expect(server.kept).toEqual([]);
  });
});
