import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db';
import { acceptLicense, Commons, Daily, Gallery, importFromUrl, plainText, SourceError, Unsplash } from './sources';
import { WallpaperStore } from './store';

let dir: string;
let db: DB;
let store: WallpaperStore;
let jpeg: Buffer;
let portrait: Buffer;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#d8d0c0' } }).jpeg().toBuffer();
  portrait = await sharp({ create: { width: 900, height: 1600, channels: 3, background: '#203040' } }).jpeg().toBuffer();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-src-'));
  db = openDb(':memory:');
  store = new WallpaperStore(db, join(dir, 'wallpapers'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Stand-in for Commons: files with a size, license and author; POTD per date. */
function fakeCommons(files: Record<string, { w: number; h: number; license: string; body?: Buffer }>, potd: Record<string, string> = {}) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    expect((init?.headers as Record<string, string>)['user-agent']).toMatch(/^NexusPortal\//);
    if (url.host === 'commons.wikimedia.org') {
      const p = url.searchParams;
      if (p.get('action') === 'expandtemplates') return Response.json({ expandtemplates: { wikitext: potd[p.get('text')!.slice(7, -2)] ?? '[[:Template:Potd/x]]' } });
      const title = p.get('titles')!;
      const f = files[title];
      if (!f) return Response.json({ query: { pages: [{ title, missing: true }] } });
      const slug = encodeURIComponent(title.slice(5));
      return Response.json({
        query: {
          pages: [
            {
              imageinfo: [
                {
                  url: `https://upload.wikimedia.org/o/${slug}`,
                  thumburl: `https://upload.wikimedia.org/t/${p.get('iiurlwidth')}/${slug}`,
                  width: f.w,
                  height: f.h,
                  mime: 'image/jpeg',
                  descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
                  extmetadata: { LicenseShortName: { value: f.license }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' }, Artist: { value: '<a href="//x">Ana &amp; Bo</a>' } },
                },
              ],
            },
          ],
        },
      });
    }
    if (url.host === 'upload.wikimedia.org') {
      if (url.pathname.includes('evil')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      const name = decodeURIComponent(url.pathname.split('/').at(-1)!);
      return new Response(new Uint8Array(files[`File:${name}`]?.body ?? jpeg), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

describe('Commons metadata', () => {
  it('keeps plain text only and accepts free licenses', () => {
    expect(plainText('<a href="x">Ana</a> &amp; <b>Bo</b> &#x4E2D;')).toBe('Ana & Bo 中');
    for (const ok of ['CC0', 'Public domain', 'CC BY-SA 4.0', 'CC BY 2.0', 'CC BY-SA 3.0 de']) expect(acceptLicense(ok)).toBe(true);
    for (const no of ['CC BY-NC 4.0', 'CC BY-ND 2.0', 'GFDL', '', 'All rights reserved']) expect(acceptLicense(no)).toBe(false);
  });
});

describe('精选图库', () => {
  const entries = [{ id: 'dunes', category: 'minimal' as const, title: '沙丘', file: 'File:Dunes.jpg', focal: [40, 60] as [number, number] }];

  it('downloads once into the library with credit, brightness and focal', async () => {
    const { fn, calls } = fakeCommons({ 'File:Dunes.jpg': { w: 6000, h: 3400, license: 'CC BY-SA 4.0' } });
    const g = new Gallery(store, new Commons(fn), join(dir, 'previews'), entries);
    expect(g.list()).toEqual([{ id: 'dunes', title: '沙丘', category: 'minimal', wallpaperId: null }]);
    const [a, b] = await Promise.all([g.ensure('dunes'), g.ensure('dunes')]);
    expect(a.created).toBe(true);
    expect(b.wallpaper.id).toBe(a.wallpaper.id);
    expect(a.wallpaper).toMatchObject({ source: 'gallery', ref: 'dunes', name: '沙丘', focal: [40, 60], credit: { author: 'Ana & Bo', license: 'CC BY-SA 4.0', provider: 'Wikimedia Commons', required: true } });
    expect(a.wallpaper.luma).toBeGreaterThan(0.7);
    expect(calls.filter((u) => u.includes('/t/3840/'))).toHaveLength(1);
    expect((await g.ensure('dunes')).created).toBe(false);
    expect(g.list()[0]!.wallpaperId).toBe(a.wallpaper.id);
  });

  it('keeps at most three requests to Wikimedia in flight', async () => {
    let live = 0;
    let peak = 0;
    const { fn } = fakeCommons({ 'File:Dunes.jpg': { w: 6000, h: 3400, license: 'CC0' } });
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return fn(input, init);
    }) as typeof fetch;
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, category: 'minimal' as const, title: 'x', file: 'File:Dunes.jpg' }));
    const g = new Gallery(store, new Commons(slow), join(dir, 'previews'), many);
    await Promise.all(many.map((e) => g.preview(e.id)));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('serves previews from its disk cache after the first download', async () => {
    const { fn, calls } = fakeCommons({ 'File:Dunes.jpg': { w: 6000, h: 3400, license: 'CC0' } });
    const g = new Gallery(store, new Commons(fn), join(dir, 'previews'), entries);
    const first = await g.preview('dunes');
    expect((await sharp(first).metadata()).format).toBe('webp');
    const n = calls.length;
    await g.preview('dunes');
    expect(calls).toHaveLength(n);
  });

  it('refuses non-free files, unknown ids and redirects off Wikimedia', async () => {
    const { fn } = fakeCommons({ 'File:Dunes.jpg': { w: 6000, h: 3400, license: 'CC BY-NC-SA 4.0' }, 'File:evil.jpg': { w: 6000, h: 3400, license: 'CC0' } });
    const g = new Gallery(store, new Commons(fn), join(dir, 'previews'), [...entries, { id: 'evil', category: 'dark', title: 'x', file: 'File:evil.jpg' }]);
    await expect(g.ensure('dunes')).rejects.toMatchObject({ code: 'license' });
    await expect(g.ensure('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(g.ensure('evil')).rejects.toMatchObject({ code: 'blocked' });
    expect(store.list()).toEqual([]);
  });
});

describe('每日一图', () => {
  let clock: Date;
  const now = () => clock;
  const cache = () => join(dir, 'daily-cache');
  const rows = () => (db.prepare('select count(*) as n from wallpapers').get() as { n: number }).n;
  const folders = () => (existsSync(cache()) ? readdirSync(cache()).sort() : []);
  const wide = { w: 5000, h: 3000, license: 'Public domain' };
  /** Commons that can be taken offline; `downloads` counts the files fetched. */
  function source(files: Parameters<typeof fakeCommons>[0], potd: Record<string, string>) {
    const fake = fakeCommons(files, potd);
    const state = { down: false };
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (state.down) throw new TypeError('fetch failed');
      return fake.fn(input, init);
    }) as typeof fetch;
    return { fn, state, calls: fake.calls, downloads: () => fake.calls.filter((u) => u.includes('upload.wikimedia.org')).length };
  }
  const daily = (fn: typeof fetch) => new Daily(store, new Commons(fn), cache(), now);

  beforeEach(() => {
    clock = new Date('2026-10-29T12:00:00Z');
  });

  it('skips portrait pictures and takes the latest landscape one, outside the library', async () => {
    const { fn } = source({ 'File:Tall.jpg': { w: 3000, h: 4000, license: 'CC BY 4.0', body: portrait }, 'File:Wide.jpg': wide }, { '2026-10-29': 'Tall.jpg', '2026-10-28': 'Wide.jpg' });
    const r = await daily(fn).current();
    expect(r).toMatchObject({ date: '2026-10-29', wallpaper: { source: 'daily', ref: '2026-10-28', name: '每日一图 · 10月29日', credit: { required: false }, widths: [1280] } });
    expect(r.wallpaper.id).toMatch(/^dl-[0-9a-f]{12}$/);
    expect(rows()).toBe(0);
    expect(existsSync(join(dir, 'wallpapers'))).toBe(false);
  });

  it('asks the source once a day, however many devices ask', async () => {
    const { fn, calls, downloads } = source({ 'File:Wide.jpg': wide }, { '2026-10-29': 'Wide.jpg' });
    const d = daily(fn);
    const [a, b] = await Promise.all([d.current(), d.current()]);
    expect(b.wallpaper.id).toBe(a.wallpaper.id);
    const n = calls.length;
    for (let i = 0; i < 5; i++) await d.current();
    expect(calls).toHaveLength(n);
    expect(downloads()).toBe(1);
  });

  it('a picture that serves several days is one picture: one download, one folder, no rows', async () => {
    // Commons in the bug report: two portrait days in a row kept falling back to the same file.
    const files = { 'File:Wide.jpg': wide, 'File:T1.jpg': { w: 8100, h: 11708, license: 'CC0', body: portrait }, 'File:T2.jpg': { w: 7000, h: 7824, license: 'CC0', body: portrait } };
    const { fn, downloads } = source(files, { '2026-10-30': 'Wide.jpg', '2026-10-31': 'T1.jpg', '2026-11-01': 'T2.jpg' });
    const d = daily(fn);
    const seen = [];
    for (const day of ['2026-10-30', '2026-10-31', '2026-11-01']) {
      clock = new Date(`${day}T00:00:05Z`);
      seen.push(await d.current());
    }
    expect(new Set(seen.map((r) => r.wallpaper.id)).size).toBe(1);
    expect(seen.map((r) => r.wallpaper.name)).toEqual(['每日一图 · 10月30日', '每日一图 · 10月31日', '每日一图 · 11月1日']);
    expect(downloads()).toBe(1);
    expect(folders()).toHaveLength(1);
    expect(rows()).toBe(0);
  });

  it('the UTC day decides, wherever the viewer is', async () => {
    const { fn } = source({ 'File:A.jpg': wide, 'File:B.jpg': wide }, { '2026-10-29': 'A.jpg', '2026-10-30': 'B.jpg' });
    const d = daily(fn);
    clock = new Date('2026-10-29T23:59:59Z'); // already the 30th in Singapore
    expect((await d.current()).date).toBe('2026-10-29');
    clock = new Date('2026-10-30T00:00:00Z'); // still the 29th in San Francisco
    expect((await d.current()).date).toBe('2026-10-30');
  });

  it('keeps the last two pictures and removes older ones from disk', async () => {
    const { fn } = source({ 'File:A.jpg': wide, 'File:B.jpg': wide, 'File:C.jpg': wide }, { '2026-10-29': 'A.jpg', '2026-10-30': 'B.jpg', '2026-10-31': 'C.jpg' });
    const d = daily(fn);
    const a = (await d.current()).wallpaper.id;
    clock = new Date('2026-10-30T12:00:00Z');
    const b = (await d.current()).wallpaper.id;
    clock = new Date('2026-10-31T12:00:00Z');
    const c = (await d.current()).wallpaper.id;
    expect(folders()).toEqual([b, c].sort());
    expect(d.filePath(a, '1280.jpg')).toBeNull();
    expect(d.filePath(c, '1280.jpg')).not.toBeNull();
  });

  it('with the source down the last picture stays, and the source is left alone for a while', async () => {
    const { fn, state, calls } = source({ 'File:A.jpg': wide, 'File:B.jpg': wide }, { '2026-10-29': 'A.jpg', '2026-10-30': 'B.jpg' });
    const d = daily(fn);
    const first = await d.current();
    clock = new Date('2026-10-30T00:01:00Z');
    state.down = true;
    const n = calls.length;
    expect(await d.current()).toEqual(first);
    state.down = false;
    expect(await d.current()).toEqual(first);
    expect(calls).toHaveLength(n);
    clock = new Date('2026-10-30T00:11:01Z');
    expect((await d.current()).date).toBe('2026-10-30');
  });

  it('with nothing cached yet the failure reaches the caller, without hammering the source', async () => {
    const { fn, state, calls } = source({ 'File:A.jpg': wide }, { '2026-10-29': 'A.jpg' });
    state.down = true;
    const d = daily(fn);
    await expect(d.current()).rejects.toMatchObject({ code: 'unavailable' });
    state.down = false;
    await expect(d.current()).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('a restart finds the cache, without the source, and drops what a cut-off run left', async () => {
    const { fn, calls } = source({ 'File:A.jpg': wide }, { '2026-10-29': 'A.jpg' });
    const first = await daily(fn).current();
    mkdirSync(join(cache(), 'tmp-half'));
    const n = calls.length;
    const again = daily(fn);
    expect(await again.current()).toEqual(first);
    expect(again.filePath(first.wallpaper.id, '1280.webp')).not.toBeNull();
    expect(calls).toHaveLength(n);
    expect(folders()).toEqual([first.wallpaper.id]);
  });

  it('serves only its own variants', async () => {
    const { fn } = source({ 'File:A.jpg': wide }, { '2026-10-29': 'A.jpg' });
    const d = daily(fn);
    const { id } = (await d.current()).wallpaper;
    expect(d.filePath(id, '1920.jpg')).toBeNull(); // the fake picture is 1600 wide
    expect(d.filePath(id, 'meta.json')).toBeNull();
    expect(d.filePath(id, '..%2F..%2Fnexus.db')).toBeNull();
    expect(d.filePath('../wallpapers', '1280.jpg')).toBeNull();
    expect(d.filePath('dl-000000000000', '1280.jpg')).toBeNull();
  });

  it('keeping a picture copies it into the library for good, once', async () => {
    const { fn } = source({ 'File:A.jpg': wide, 'File:B.jpg': wide, 'File:C.jpg': wide }, { '2026-10-29': 'A.jpg', '2026-10-30': 'B.jpg', '2026-10-31': 'C.jpg' });
    const d = daily(fn);
    const { wallpaper } = await d.current();
    const [a, b] = await Promise.all([d.keep(wallpaper.id), d.keep(wallpaper.id)]);
    expect(b.wallpaper.id).toBe(a.wallpaper.id);
    expect(a).toMatchObject({ created: true, wallpaper: { source: 'saved', ref: wallpaper.id, name: '每日一图 · 10月29日', credit: { provider: 'Wikimedia Commons' }, placeholder: wallpaper.placeholder } });
    expect(a.wallpaper.id).toMatch(/^up-/);
    expect(await d.keep(wallpaper.id)).toMatchObject({ created: false, wallpaper: { id: a.wallpaper.id } });
    expect(rows()).toBe(1);
    expect(readdirSync(join(dir, 'wallpapers', a.wallpaper.id)).sort()).toEqual(['1280.avif', '1280.jpg', '1280.webp']);

    // The cache moves on; the kept copy does not depend on it.
    for (const day of ['2026-10-30', '2026-10-31']) {
      clock = new Date(`${day}T12:00:00Z`);
      await d.current();
    }
    expect(d.filePath(wallpaper.id, '1280.jpg')).toBeNull();
    expect(existsSync(store.filePath(a.wallpaper.id, '1280.jpg')!)).toBe(true);
    await expect(d.keep('dl-000000000000')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Unsplash (optional)', () => {
  const photo = { id: 'abc_123', width: 6000, height: 4000, color: '#c0d0e0', alt_description: 'misty lake', description: null, urls: { raw: 'https://images.unsplash.com/photo-1?ixid=x', small: 'https://images.unsplash.com/photo-1?w=400&ixid=x' }, links: { html: 'https://unsplash.com/photos/abc_123', download_location: 'https://api.unsplash.com/photos/abc_123/download?ixid=x' }, user: { name: 'Lee', links: { html: 'https://unsplash.com/@lee' } } };

  it('is off without a key', async () => {
    const u = new Unsplash(null, store);
    expect(u.configured).toBe(false);
    await expect(u.search('lake')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('keeps the key on the server, hotlinks, credits with UTM and reports the download', async () => {
    const calls: { url: string; auth: string }[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: (init?.headers as Record<string, string>).authorization ?? '' });
      if (url.includes('/search/photos')) return Response.json({ results: [photo] });
      if (url.endsWith('/photos/abc_123')) return Response.json(photo);
      if (url.includes('/download')) return Response.json({ url: photo.urls.raw });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const u = new Unsplash('key-123', store, fn);
    expect(await u.search('lake')).toEqual([{ id: 'abc_123', thumb: photo.urls.small, color: '#c0d0e0', author: 'Lee', description: 'misty lake' }]);
    const r = await u.use('abc_123');
    expect(r.wallpaper).toMatchObject({ source: 'unsplash', ref: 'abc_123', widths: [], remote: photo.urls.raw, credit: { author: 'Lee', authorUrl: 'https://unsplash.com/@lee?utm_source=nexus_portal&utm_medium=referral', provider: 'Unsplash', required: true } });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.url)).toContain(photo.links.download_location);
    expect(calls.every((c) => c.auth === 'Client-ID key-123')).toBe(true);
    expect((await u.use('abc_123')).created).toBe(false);
    await expect(u.use('../x')).rejects.toBeInstanceOf(SourceError);
  });
});

describe('网址导入', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/pic.jpg')) return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg);
      if (req.url === '/hop') return res.writeHead(302, { location: '/pic.jpg?token=secret' }).end();
      if (req.url === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const lan = { allowPrivate: true, allowLoopback: true };
  const publicOnly = { allowPrivate: false, allowLoopback: false };

  it('downloads through redirects and keeps no query string in the credit', async () => {
    const w = await importFromUrl(store, `${base}/hop`, lan);
    expect(w).toMatchObject({ source: 'url', name: 'pic', credit: { sourceUrl: `${base}/pic.jpg` } });
  });

  it('refuses private and loopback targets, non-images and junk', async () => {
    await expect(importFromUrl(store, `${base}/pic.jpg`, publicOnly)).rejects.toMatchObject({ code: 'blocked' });
    await expect(importFromUrl(store, 'http://169.254.169.254/latest/meta-data', publicOnly)).rejects.toMatchObject({ code: 'blocked' });
    await expect(importFromUrl(store, `${base}/page`, lan)).rejects.toMatchObject({ code: 'invalid' });
    await expect(importFromUrl(store, 'file:///etc/passwd', lan)).rejects.toMatchObject({ code: 'invalid' });
    await expect(importFromUrl(store, 'not a url', lan)).rejects.toMatchObject({ code: 'invalid' });
    expect(store.list()).toEqual([]);
  });
});
