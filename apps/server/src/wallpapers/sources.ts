import type { GalleryItem, UnsplashPhoto, UploadedWallpaper, WallpaperCredit } from '@nexus/shared';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { getBytes, UpstreamError } from '../net/http';
import type { NetPolicy } from '../net/ip';
import { GALLERY, type GalleryEntry } from './gallery';
import type { WallpaperStore } from './store';

export class SourceError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'blocked' | 'license' | 'not_configured' | 'unavailable' | 'too_large',
    message: string,
  ) {
    super(message);
  }
}

/** Wikimedia asks every client for a descriptive User-Agent with a way to reach the operator. */
const UA = 'NexusPortal/0.3.0 (https://github.com/KJoner/nexus-portal; self-hosted start page)';
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

/** 每日一图: Wikimedia Commons' Picture of the Day, falling back to the latest landscape one. */
export class Daily {
  private inflight = new Map<string, Promise<Ensured>>();

  constructor(
    private store: WallpaperStore,
    private commons: Commons,
    private now: () => Date = () => new Date(),
  ) {}

  /** `date` is the viewer's local day; it may differ from the server's UTC day by one. */
  ensure(date: string): Promise<Ensured> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return Promise.reject(new SourceError('invalid', '日期格式不正确'));
    if (Math.abs(Date.parse(date) - Date.parse(isoDay(this.now()))) > 86_400_000) return Promise.reject(new SourceError('invalid', '只能获取今天的每日一图'));
    const existing = this.store.findByRef('daily', date);
    if (existing) return Promise.resolve({ wallpaper: existing, created: false });
    return once(this.inflight, date, async () => {
      // About a third of the pictures are portrait or square; look back up to a week for a wide one.
      for (let back = 0; back < 7; back++) {
        const day = isoDay(new Date(Date.parse(date) - back * 86_400_000));
        const file = await this.commons.potd(day);
        if (!file) continue;
        let info: CommonsImage;
        try {
          info = await this.commons.info(file, FULL_WIDTH);
        } catch (e) {
          if (e instanceof SourceError && (e.code === 'license' || e.code === 'invalid')) continue;
          throw e;
        }
        if (info.width / info.height < 1.3) continue;
        const body = await this.commons.download(info.url, MAX_ORIGINAL);
        const [, m, d] = date.split('-').map(Number);
        const wallpaper = await this.store.add(body, `每日一图 · ${m}月${d}日`, { source: 'daily', ref: date, credit: info.credit, maxBytes: MAX_ORIGINAL });
        return { wallpaper, created: true };
      }
      throw new SourceError('not_found', '最近一周没有适合做壁纸的横幅图片');
    });
  }

  /** Drops daily pictures older than two weeks unless they are kept (current, favorites). */
  async prune(keep: ReadonlySet<string>): Promise<number> {
    const cutoff = isoDay(new Date(this.now().getTime() - 14 * 86_400_000));
    const old = this.store.list().filter((w) => w.source === 'daily' && w.ref < cutoff && !keep.has(w.id));
    for (const w of old) await this.store.remove(w.id);
    return old.length;
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
