import { isDailyId, type DailyResponse, type GalleryItem, type UnsplashPhoto, type UploadedWallpaper, type WallpaperCredit } from '@nexus/shared';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { getBytes, UpstreamError } from '../net/http';
import type { NetPolicy } from '../net/ip';
import { GALLERY, type GalleryEntry } from './gallery';
import { encodeVariants, VARIANT, WallpaperError, type WallpaperStore } from './store';

export class SourceError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'blocked' | 'license' | 'not_configured' | 'unavailable' | 'too_large',
    message: string,
  ) {
    super(message);
  }
}

/** Wikimedia asks every client for a descriptive User-Agent with a way to reach the operator. */
const UA = 'NexusPortal/0.3.2 (https://github.com/KJoner/nexus-portal; self-hosted start page)';
const COMMONS_HOSTS = new Set(['commons.wikimedia.org', 'upload.wikimedia.org', 'thumb.wikimedia.org']);
/** Commons serves these thumbnail widths from cache; other widths are rate limited. */
const FULL_WIDTH = 3840;
const PREVIEW_WIDTH = 500;
const MAX_ORIGINAL = 30 * 1024 * 1024;
const MAX_IMPORT = 15 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Commons metadata is HTML; only plain text is kept. */
export function plainText(html: unknown, max = 120): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Free licenses that allow showing (and caching) the picture; NC / ND / GFDL-only are refused. */
export function acceptLicense(name: string): boolean {
  if (/\b(nc|nd)\b/i.test(name)) return false;
  return /^(cc0|public domain|pd\b|pd-|cc[ -]by(-sa)? [1-4]\.\d)/i.test(name.trim());
}

interface Fetched {
  body: Buffer;
  type: string;
}

interface CommonsImage {
  url: string;
  width: number;
  height: number;
  credit: WallpaperCredit;
}

/** Commons Action API and file downloads, limited to Wikimedia's own hosts. */
export class Commons {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private fetchFn: typeof fetch = fetch,
    /** Wikimedia asks clients to keep at most a few requests in flight. */
    private maxConcurrent = 3,
  ) {}

  private async slot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await run();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private get(url: string, accept: string, maxBytes: number): Promise<Fetched> {
    return this.slot(() => this.fetchOnce(url, accept, maxBytes));
  }

  /** Redirects are followed by hand and only between Wikimedia hosts. */
  private async fetchOnce(url: string, accept: string, maxBytes: number, hops = 0): Promise<Fetched> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !COMMONS_HOSTS.has(u.host) || hops > 3) throw new SourceError('blocked', '图片来源不在允许的范围内');
    let res: Response;
    try {
      res = await this.fetchFn(u, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': UA, accept } });
    } catch {
      throw new SourceError('unavailable', '暂时无法连接 Wikimedia Commons');
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new SourceError('unavailable', 'Wikimedia 返回了无效的重定向');
      return this.fetchOnce(new URL(next, u).toString(), accept, maxBytes, hops + 1);
    }
    if (res.status === 429) throw new SourceError('unavailable', 'Wikimedia 暂时限制了请求，请稍后再试');
    if (!res.ok) throw new SourceError('unavailable', `Wikimedia 返回 HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new SourceError('too_large', '图片过大');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) throw new SourceError('too_large', '图片过大');
    return { body, type: (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() };
  }

  private async api(params: Record<string, string>): Promise<Record<string, unknown>> {
    const u = new URL('https://commons.wikimedia.org/w/api.php');
    for (const [k, v] of Object.entries({ ...params, format: 'json', formatversion: '2' })) u.searchParams.set(k, v);
    const { body } = await this.get(u.toString(), 'application/json', 2 * 1024 * 1024);
    try {
      return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new SourceError('unavailable', 'Wikimedia 返回的数据无法识别');
    }
  }

  /** Thumbnail address at `width`, original size and attribution of a file; refuses non-free files. */
  async info(file: string, width: number): Promise<CommonsImage> {
    const r = (await this.api({ action: 'query', titles: file, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(width), iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist' })) as {
      query?: { pages?: { imageinfo?: { thumburl?: string; url: string; width: number; height: number; mime: string; descriptionurl: string; extmetadata?: Record<string, { value?: unknown }> }[] }[] };
    };
    const ii = r.query?.pages?.[0]?.imageinfo?.[0];
    if (!ii) throw new SourceError('not_found', 'Wikimedia Commons 上找不到这张图片');
    if (!/^image\/(jpeg|png|webp)$/.test(ii.mime)) throw new SourceError('invalid', '这张图片的格式不适合作为壁纸');
    const meta = ii.extmetadata ?? {};
    const license = plainText(meta.LicenseShortName?.value, 40);
    if (!acceptLicense(license)) throw new SourceError('license', `许可「${license || '未知'}」不适合作为壁纸使用`);
    const licenseUrl = String(meta.LicenseUrl?.value ?? '');
    return {
      url: ii.thumburl ?? ii.url,
      width: ii.width,
      height: ii.height,
      credit: {
        author: plainText(meta.Artist?.value) || undefined,
        license,
        licenseUrl: /^https?:\/\//.test(licenseUrl) ? licenseUrl : undefined,
        sourceUrl: ii.descriptionurl,
        provider: 'Wikimedia Commons',
        required: !/^(cc0|public domain|pd\b|pd-)/i.test(license),
      },
    };
  }

  /** File of Commons' Picture of the Day, or null when that day has none. */
  async potd(date: string): Promise<string | null> {
    const r = (await this.api({ action: 'expandtemplates', text: `{{Potd/${date}}}`, prop: 'wikitext' })) as { expandtemplates?: { wikitext?: string } };
    const name = String(r.expandtemplates?.wikitext ?? '').trim();
    return name && !/[[\]{}|<>]/.test(name) ? `File:${name}` : null;
  }

  async download(url: string, maxBytes: number): Promise<Buffer> {
    const r = await this.get(url, 'image/*', maxBytes);
    if (!r.type.startsWith('image/')) throw new SourceError('invalid', 'Wikimedia 返回的不是图片');
    return r.body;
  }
}

/** One download per item at a time; concurrent requests share it. */
function once<T>(map: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const p = run().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

export interface Ensured {
  wallpaper: UploadedWallpaper;
  /** A new library entry was made (other devices need to refresh). */
  created: boolean;
}

/** 精选图库: a fixed list of Commons photos, downloaded into the library on first use. */
export class Gallery {
  private inflight = new Map<string, Promise<Ensured>>();
  private previews = new Map<string, Promise<Buffer>>();

  constructor(
    private store: WallpaperStore,
    private commons: Commons,
    private previewDir: string,
    private entries: readonly GalleryEntry[] = GALLERY,
  ) {}

  list(): GalleryItem[] {
    return this.entries.map((e) => ({ id: e.id, title: e.title, category: e.category, wallpaperId: this.store.findByRef('gallery', e.id)?.id ?? null }));
  }

  private entry(id: string): GalleryEntry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new SourceError('not_found', '图库中没有这张图片');
    return e;
  }

  async ensure(id: string): Promise<Ensured> {
    const e = this.entry(id);
    const existing = this.store.findByRef('gallery', id);
    if (existing) return Promise.resolve({ wallpaper: existing, created: false });
    return once(this.inflight, id, async () => {
      const info = await this.commons.info(e.file, FULL_WIDTH);
      const body = await this.commons.download(info.url, MAX_ORIGINAL);
      const wallpaper = await this.store.add(body, e.title, { source: 'gallery', ref: id, credit: info.credit, focal: e.focal ?? null, maxBytes: MAX_ORIGINAL });
      return { wallpaper, created: true };
    });
  }

  /** Small WebP for the picker, cached on disk so browsers never contact Wikimedia directly. */
  async preview(id: string): Promise<Buffer> {
    const e = this.entry(id);
    const file = join(this.previewDir, `${e.id}.webp`);
    return once(this.previews, id, async () => {
      try {
        return await readFile(file);
      } catch {
        const info = await this.commons.info(e.file, PREVIEW_WIDTH);
        const body = await this.commons.download(info.url, 5 * 1024 * 1024);
        const out = await sharp(body).resize({ width: 480, height: 300, fit: 'cover' }).webp({ quality: 72 }).toBuffer();
        await mkdir(this.previewDir, { recursive: true });
        await writeFile(file, out);
        return out;
      }
    });
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dailyId = (file: string) => `dl-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`;
const dailyName = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return `每日一图 · ${m}月${d}日`;
};

/** Today's picture and the one before it, which keeps showing while the source is down. */
const DAILY_KEEP = 2;
/** After a failure the source is left alone for a while, however many devices ask. */
const DAILY_RETRY_MS = 10 * 60_000;
const DAILY_META = 'meta.json';

/**
 * 每日一图: Wikimedia Commons' Picture of the Day, falling back to the latest landscape one. The
 * day is the UTC day (Commons' own), so every device agrees whatever its time zone.
 *
 * The pictures are a cache under `<data>/daily-cache/<id>/`, outside the library and the database,
 * and nothing about them touches the configuration: a new day costs no revision and no sync. An id
 * belongs to a Commons file, so a picture that serves several days is downloaded once. 收藏 and 锁定
 * copy a picture into the library (`keep`); only then is it permanent.
 */
export class Daily {
  private cached = new Map<string, DailyResponse>();
  private inflight = new Map<string, Promise<DailyResponse>>();
  private keeping = new Map<string, Promise<Ensured>>();
  private retryAt = 0;

  constructor(
    private store: WallpaperStore,
    private commons: Commons,
    private dir: string,
    private now: () => Date = () => new Date(),
  ) {
    this.load();
  }

  /** What an earlier run left; anything unreadable is a download that was cut short. */
  private load() {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const id of names) {
      try {
        const entry = JSON.parse(readFileSync(join(this.dir, id, DAILY_META), 'utf8')) as DailyResponse;
        if (!isDailyId(id) || entry.wallpaper.id !== id) throw new Error('not a cached picture');
        this.cached.set(id, entry);
      } catch {
        rmSync(join(this.dir, id), { recursive: true, force: true });
      }
    }
  }

  private newestFirst(): DailyResponse[] {
    return [...this.cached.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  /** Today's picture, or the last one there is while today's cannot be fetched. */
  current(): Promise<DailyResponse> {
    const date = isoDay(this.now());
    const last = this.newestFirst()[0];
    if (last?.date === date) return Promise.resolve(last);
    if (this.now().getTime() < this.retryAt) return last ? Promise.resolve(last) : Promise.reject(new SourceError('unavailable', '暂时无法获取每日一图，请稍后再试'));
    return once(this.inflight, date, async () => {
      try {
        const entry = await this.fetch(date);
        this.retryAt = 0;
        return entry;
      } catch (e) {
        this.retryAt = this.now().getTime() + DAILY_RETRY_MS;
        if (last) return last;
        throw e instanceof SourceError || e instanceof WallpaperError ? e : new SourceError('unavailable', '暂时无法获取每日一图，请稍后再试');
      }
    });
  }

  private async fetch(date: string): Promise<DailyResponse> {
    // About a third of the pictures are portrait or square; look back up to a week for a wide one.
    for (let back = 0; back < 7; back++) {
      const day = isoDay(new Date(Date.parse(date) - back * 86_400_000));
      const file = await this.commons.potd(day);
      if (!file) continue;
      const id = dailyId(file);
      const had = this.cached.get(id);
      if (had) return this.write({ date, wallpaper: { ...had.wallpaper, name: dailyName(date) } });
      let info: CommonsImage;
      try {
        info = await this.commons.info(file, FULL_WIDTH);
      } catch (e) {
        if (e instanceof SourceError && (e.code === 'license' || e.code === 'invalid')) continue;
        throw e;
      }
      if (info.width / info.height < 1.3) continue;
      const body = await this.commons.download(info.url, MAX_ORIGINAL);
      // Encoded to one side and renamed, so a cut-off run never leaves half a picture under its id.
      const tmp = join(this.dir, `tmp-${randomBytes(6).toString('hex')}`);
      try {
        const encoded = await encodeVariants(body, tmp, MAX_ORIGINAL);
        const wallpaper: UploadedWallpaper = { id, name: dailyName(date), ...encoded, createdAt: this.now().toISOString(), source: 'daily', ref: day, credit: info.credit, focal: null };
        await writeFile(join(tmp, DAILY_META), JSON.stringify({ date, wallpaper } satisfies DailyResponse));
        await rename(tmp, join(this.dir, id));
        return await this.write({ date, wallpaper });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    throw new SourceError('not_found', '最近一周没有适合做壁纸的横幅图片');
  }

  private async write(entry: DailyResponse): Promise<DailyResponse> {
    const { id } = entry.wallpaper;
    await writeFile(join(this.dir, id, DAILY_META), JSON.stringify(entry));
    this.cached.set(id, entry);
    for (const old of this.newestFirst().slice(DAILY_KEEP)) {
      this.cached.delete(old.wallpaper.id);
      await rm(join(this.dir, old.wallpaper.id), { recursive: true, force: true });
    }
    return entry;
  }

  /** Absolute path of a cached variant, or null. Both parts are pattern-checked: no path traversal. */
  filePath(id: string, file: string): string | null {
    const m = VARIANT.exec(file);
    const entry = isDailyId(id) && m ? this.cached.get(id) : undefined;
    return entry?.wallpaper.widths.includes(Number(m![1])) ? join(this.dir, id, file) : null;
  }

  /** The user wants this picture for good: one library copy per picture, whatever the cache does next. */
  async keep(id: string): Promise<Ensured> {
    const existing = this.store.findByRef('saved', id);
    if (existing) return { wallpaper: existing, created: false };
    const entry = this.cached.get(id);
    if (!entry) throw new SourceError('not_found', '这张每日一图已经过期，无法收藏');
    return once(this.keeping, id, async () => ({ wallpaper: await this.store.addEncoded(join(this.dir, id), entry.wallpaper, { source: 'saved', ref: id, credit: entry.wallpaper.credit }), created: true }));
  }
}

const UTM = 'utm_source=nexus_portal&utm_medium=referral';
const utm = (url: string) => `${url}${url.includes('?') ? '&' : '?'}${UTM}`;

interface UnsplashApiPhoto {
  id: string;
  width: number;
  height: number;
  color: string | null;
  alt_description: string | null;
  description: string | null;
  urls: { raw: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

/**
 * Optional Unsplash source with the deployer's own access key (never sent to browsers). The API
 * guidelines require hotlinking, so photos are library entries without files, and a download is
 * reported to Unsplash when a photo is added.
 */
export class Unsplash {
  constructor(
    private key: string | null,
    private store: WallpaperStore,
    private fetchFn: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return !!this.key;
  }

  private async api<T>(url: string): Promise<T> {
    if (!this.key) throw new SourceError('not_configured', '未配置 Unsplash Access Key');
    const u = new URL(url, 'https://api.unsplash.com');
    if (u.protocol !== 'https:' || u.host !== 'api.unsplash.com') throw new SourceError('blocked', 'Unsplash 地址无效');
    let res: Response;
    try {
      res = await this.fetchFn(u, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: `Client-ID ${this.key}`, 'accept-version': 'v1', 'user-agent': UA } });
    } catch {
      throw new SourceError('unavailable', '暂时无法连接 Unsplash');
    }
    if (res.status === 401) throw new SourceError('not_configured', 'Unsplash Access Key 无效');
    if (res.status === 403 || res.status === 429) throw new SourceError('unavailable', 'Unsplash 请求次数已达上限，请稍后再试');
    if (res.status === 404) throw new SourceError('not_found', 'Unsplash 上找不到这张照片');
    if (!res.ok) throw new SourceError('unavailable', `Unsplash 返回 HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Landscape photos for a keyword, or from the Wallpapers topic when `q` is empty. */
  async search(q: string, page = 1): Promise<UnsplashPhoto[]> {
    const p = String(Math.max(1, Math.min(20, Math.floor(page) || 1)));
    const query = q.trim().slice(0, 60);
    const list = query
      ? (await this.api<{ results: UnsplashApiPhoto[] }>(`/search/photos?${new URLSearchParams({ query, orientation: 'landscape', content_filter: 'high', per_page: '24', page: p })}`)).results
      : await this.api<UnsplashApiPhoto[]>(`/topics/wallpapers/photos?${new URLSearchParams({ orientation: 'landscape', per_page: '24', page: p })}`);
    return list.map((x) => ({ id: x.id, thumb: x.urls.small, color: x.color ?? '#2a2724', author: x.user.name, description: (x.alt_description ?? x.description ?? '').slice(0, 80) }));
  }

  async use(id: string): Promise<Ensured> {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new SourceError('invalid', '照片编号不正确');
    const existing = this.store.findByRef('unsplash', id);
    if (existing) return { wallpaper: existing, created: false };
    const x = await this.api<UnsplashApiPhoto>(`/photos/${id}`);
    const raw = new URL(x.urls.raw);
    if (raw.protocol !== 'https:' || raw.host !== 'images.unsplash.com') throw new SourceError('invalid', 'Unsplash 返回的图片地址无效');
    // Setting a photo as a background counts as a download (API guidelines); fire and forget.
    void this.api(x.links.download_location).catch(() => undefined);
    const credit: WallpaperCredit = { author: x.user.name, authorUrl: utm(x.user.links.html), sourceUrl: utm(x.links.html), provider: 'Unsplash', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license', required: true };
    const name = (x.alt_description ?? '').trim() || `Unsplash · ${x.user.name}`;
    const wallpaper = this.store.addRemote(raw.toString(), name, { width: x.width, height: x.height }, x.color ?? '', { source: 'unsplash', ref: id, credit, focal: [50, 50] });
    return { wallpaper, created: true };
  }
}

/**
 * 网址导入: the picture is downloaded once by the server (public addresses only, size and type
 * checked, re-encoded by the library), so browsers never load arbitrary third-party addresses.
 */
export async function importFromUrl(store: WallpaperStore, raw: string, policy: NetPolicy, fetchBytes: typeof getBytes = getBytes): Promise<UploadedWallpaper> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SourceError('invalid', '请输入以 https:// 或 http:// 开头的完整图片地址');
  }
  let r: Awaited<ReturnType<typeof getBytes>>;
  try {
    r = await fetchBytes(url, policy, { maxBytes: MAX_IMPORT, timeoutMs: 15_000 });
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    throw new SourceError(e.kind === 'blocked' ? 'blocked' : e.kind === 'too_large' ? 'too_large' : e.kind === 'invalid' ? 'invalid' : 'unavailable', e.kind === 'status' ? `图片地址返回 ${e.message}` : e.message);
  }
  if (!r.type.startsWith('image/')) throw new SourceError('invalid', '这个地址返回的不是图片');
  const last = r.url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  let name = r.url.host;
  try {
    name = decodeURIComponent(last) || r.url.host;
  } catch {
    /* keep the host */
  }
  // Only origin + path are kept: query strings often carry access tokens.
  return store.add(r.body, name, { source: 'url', credit: { sourceUrl: `${r.url.origin}${r.url.pathname}`, provider: r.url.host }, maxBytes: MAX_IMPORT });
}
