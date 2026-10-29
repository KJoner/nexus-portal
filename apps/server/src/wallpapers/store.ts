import { WALLPAPER_WIDTHS, type UploadedWallpaper, type WallpaperCredit, type WallpaperSource } from '@nexus/shared';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Metadata, type Sharp } from 'sharp';
import type { DB } from '../db';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
const PREFIX: Record<WallpaperSource, string> = { upload: 'up', url: 'up', gallery: 'gl', daily: 'dy', unsplash: 'us' };
const ID = /^(up|gl|dy|us)-[a-z0-9]{12}$/;
const FILE = /^(\d{3,4})\.(avif|webp|jpg)$/;

export class WallpaperError extends Error {
  constructor(
    readonly code: 'unsupported' | 'too_large' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  name: string;
  width: number;
  height: number;
  widths: string;
  placeholder: string;
  created_at: string;
  source: WallpaperSource;
  ref: string;
  credit: string;
  luma: number | null;
  focal: string;
  remote: string;
}

/** Everything about a wallpaper that does not come from decoding the image itself. */
export interface WallpaperMeta {
  source: WallpaperSource;
  ref?: string;
  credit?: WallpaperCredit | null;
  focal?: [number, number] | null;
  /** Upper bound for the input size; uploads are 10 MB, downloaded originals may be larger. */
  maxBytes?: number;
}

const parse = <T>(text: string): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const toApi = (r: Row): UploadedWallpaper => ({
  id: r.id,
  name: r.name,
  width: r.width,
  height: r.height,
  widths: JSON.parse(r.widths) as number[],
  placeholder: r.placeholder,
  createdAt: r.created_at,
  source: r.source,
  ref: r.ref,
  credit: parse<WallpaperCredit>(r.credit),
  luma: r.luma,
  focal: parse<[number, number]>(r.focal),
  ...(r.remote ? { remote: r.remote } : {}),
});

const newId = (source: WallpaperSource) => `${PREFIX[source]}-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12)}`;

/**
 * Brightness of the middle band of the picture, where the clock, search and shortcuts sit; the
 * home page darkens its overlay a little more on bright photos so text stays readable.
 */
export async function bandLuma(image: Sharp): Promise<number> {
  const { channels } = await image.clone().resize(64, 36, { fit: 'cover' }).extract({ left: 8, top: 7, width: 48, height: 22 }).greyscale().stats();
  return Math.round((channels[0]!.mean / 255) * 1000) / 1000;
}

/**
 * Library wallpapers live under `<data>/wallpapers/<id>/`. Every image is re-encoded, which strips
 * metadata (EXIF location) and guarantees the stored files are images regardless of what was sent.
 * Hotlinked photos (Unsplash, whose terms forbid re-hosting) are rows without files.
 */
export class WallpaperStore {
  constructor(
    private db: DB,
    private dir: string,
  ) {}

  list(): UploadedWallpaper[] {
    return (this.db.prepare('select * from wallpapers order by created_at').all() as Row[]).map(toApi);
  }

  get(id: string): UploadedWallpaper | null {
    const row = this.db.prepare('select * from wallpapers where id = ?').get(id) as Row | undefined;
    return row ? toApi(row) : null;
  }

  /** The library entry already made from a source item (gallery id, POTD date, photo id). */
  findByRef(source: WallpaperSource, ref: string): UploadedWallpaper | null {
    const row = this.db.prepare('select * from wallpapers where source = ? and ref = ?').get(source, ref) as Row | undefined;
    return row ? toApi(row) : null;
  }

  async add(input: Buffer, rawName: string, meta: WallpaperMeta = { source: 'upload' }): Promise<UploadedWallpaper> {
    const maxBytes = meta.maxBytes ?? MAX_UPLOAD_BYTES;
    if (input.length > maxBytes) throw new WallpaperError('too_large', `文件为 ${(input.length / 1048576).toFixed(1)} MB，超过 ${Math.round(maxBytes / 1048576)} MB 上限`);
    let meta0: Metadata;
    try {
      meta0 = await sharp(input, { limitInputPixels: 120_000_000 }).metadata();
    } catch {
      throw new WallpaperError('unsupported', '无法识别的图片文件，请使用 JPG、PNG、WebP 或 AVIF');
    }
    if (!meta0.format || !FORMATS.has(meta0.format)) throw new WallpaperError('unsupported', `不支持 ${meta0.format ?? '该'} 格式，请使用 JPG、PNG、WebP 或 AVIF`);

    const base = sharp(input, { limitInputPixels: 120_000_000 }).rotate();
    // EXIF orientations 5–8 rotate by 90°, swapping the stored dimensions.
    const swap = (meta0.orientation ?? 1) >= 5;
    const width = (swap ? meta0.height : meta0.width) ?? 0;
    const height = (swap ? meta0.width : meta0.height) ?? 0;
    const widths: number[] = WALLPAPER_WIDTHS.filter((w) => w <= width);
    if (!widths.length) widths.push(width);

    const id = newId(meta.source);
    const folder = join(this.dir, id);
    await mkdir(folder, { recursive: true });
    try {
      for (const w of widths) {
        const resized = base.clone().resize({ width: w, withoutEnlargement: true });
        await Promise.all([
          resized.clone().avif({ quality: 55, effort: 4 }).toFile(join(folder, `${w}.avif`)),
          resized.clone().webp({ quality: 78 }).toFile(join(folder, `${w}.webp`)),
          resized.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(join(folder, `${w}.jpg`)),
        ]);
      }
      const tiny = await base.clone().resize({ width: 32 }).webp({ quality: 40 }).toBuffer();
      const placeholder = `data:image/webp;base64,${tiny.toString('base64')}`;
      const luma = await bandLuma(base);
      const name = rawName.replace(/\.[^.]+$/, '').trim().slice(0, 40) || '我的壁纸';
      return this.insert({ id, name, width, height, widths, placeholder, luma, meta });
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      throw e;
    }
  }

  /** A hotlinked photo: only metadata is kept; `color` paints until the image arrives. */
  addRemote(remote: string, name: string, size: { width: number; height: number }, color: string, meta: WallpaperMeta): UploadedWallpaper {
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#2a2724';
    const placeholder = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${hex}"/></svg>`)}`;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const luma = Math.round((0.2126 * r! + 0.7152 * g! + 0.0722 * b!) * 1000) / 1000;
    return this.insert({ id: newId(meta.source), name: name.slice(0, 40) || '在线壁纸', width: size.width, height: size.height, widths: [], placeholder, luma, meta, remote });
  }

  private insert(w: { id: string; name: string; width: number; height: number; widths: number[]; placeholder: string; luma: number; meta: WallpaperMeta; remote?: string }): UploadedWallpaper {
    const createdAt = new Date().toISOString();
    this.db
      .prepare('insert into wallpapers (id, name, width, height, widths, placeholder, created_at, source, ref, credit, luma, focal, remote) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(w.id, w.name, w.width, w.height, JSON.stringify(w.widths), w.placeholder, createdAt, w.meta.source, w.meta.ref ?? '', w.meta.credit ? JSON.stringify(w.meta.credit) : '', w.luma, w.meta.focal ? JSON.stringify(w.meta.focal) : '', w.remote ?? '');
    return this.get(w.id)!;
  }

  /** Absolute path of a variant, or null. Both parts are pattern-checked: no path traversal. */
  filePath(id: string, file: string): string | null {
    const m = FILE.exec(file);
    if (!ID.test(id) || !m) return null;
    const w = this.get(id);
    return w && w.widths.includes(Number(m[1])) ? join(this.dir, id, file) : null;
  }

  async remove(id: string): Promise<boolean> {
    if (!ID.test(id) || !this.get(id)) return false;
    this.db.prepare('delete from wallpapers where id = ?').run(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
    return true;
  }
}
