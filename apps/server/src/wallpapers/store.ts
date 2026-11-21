import { WALLPAPER_WIDTHS, type UploadedWallpaper, type WallpaperCredit, type WallpaperSource } from '@nexus/shared';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp, { type Metadata, type Sharp } from 'sharp';
import type { DB } from '../db';
import { folderBytes, type Quota } from '../quota';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
/** `dy` is only found on rows made before 每日一图 left the library. */
const PREFIX: Record<WallpaperSource, string> = { upload: 'up', url: 'up', gallery: 'gl', daily: 'dy', unsplash: 'us', saved: 'up' };
const ID = /^(up|gl|dy|us)-[a-z0-9]{12}$/;
/** A generated variant of a picture. */
export const VARIANT = /^(\d{3,4})\.(avif|webp|jpg)$/;

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

export interface Encoded {
  width: number;
  height: number;
  widths: number[];
  placeholder: string;
  luma: number;
}

/**
 * Writes the variants of a picture into `folder`. Every image is re-encoded, which strips metadata
 * (EXIF location) and guarantees the stored files are images regardless of what was sent.
 */
export async function encodeVariants(input: Buffer, folder: string, maxBytes = MAX_UPLOAD_BYTES): Promise<Encoded> {
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

  await mkdir(folder, { recursive: true });
  for (const w of widths) {
    const resized = base.clone().resize({ width: w, withoutEnlargement: true });
    await Promise.all([
      resized.clone().avif({ quality: 55, effort: 4 }).toFile(join(folder, `${w}.avif`)),
      resized.clone().webp({ quality: 78 }).toFile(join(folder, `${w}.webp`)),
      resized.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(join(folder, `${w}.jpg`)),
    ]);
  }
  const tiny = await base.clone().resize({ width: 32 }).webp({ quality: 40 }).toBuffer();
  return { width, height, widths, placeholder: `data:image/webp;base64,${tiny.toString('base64')}`, luma: await bandLuma(base) };
}


/**
 * Library wallpapers live under `<data>/wallpapers/<id>/`. Hotlinked photos (Unsplash, whose terms
 * forbid re-hosting) are rows without files. Every row belongs to one account (v0.4) and every
 * lookup is made for an account: an id that belongs to someone else reads as not found, so a
 * guessed or leaked id never serves another account's picture.
 */
export class WallpaperStore {
  constructor(
    private db: DB,
    private dir: string,
    /** Per-account limits (TN-07); none in self-contained tests. */
    private quota: Quota | null = null,
  ) {}

  async list(ownerId: string): Promise<UploadedWallpaper[]> {
    return (await this.db.all<Row>('select * from wallpapers where owner_id = ? order by created_at', [ownerId])).map(toApi);
  }

  async get(ownerId: string, id: string): Promise<UploadedWallpaper | null> {
    const row = await this.db.get<Row>('select * from wallpapers where id = ? and owner_id = ?', [id, ownerId]);
    return row ? toApi(row) : null;
  }

  /** The library entry already made from a source item (gallery id, POTD date, photo id). */
  async findByRef(ownerId: string, source: WallpaperSource, ref: string): Promise<UploadedWallpaper | null> {
    const row = await this.db.get<Row>('select * from wallpapers where owner_id = ? and source = ? and ref = ?', [ownerId, source, ref]);
    return row ? toApi(row) : null;
  }

  /**
   * Folder of the same public picture already in some account's library (精选图库 originals are
   * public): lets another account get its own copy without downloading it again. Only the files
   * are reused; the caller gets a row of its own.
   */
  async publicFolder(source: 'gallery', ref: string): Promise<{ folder: string; wallpaper: UploadedWallpaper } | null> {
    const row = await this.db.get<Row>('select * from wallpapers where source = ? and ref = ? order by created_at limit 1', [source, ref]);
    return row ? { folder: join(this.dir, row.id), wallpaper: toApi(row) } : null;
  }

  async add(ownerId: string, input: Buffer, rawName: string, meta: WallpaperMeta = { source: 'upload' }): Promise<UploadedWallpaper> {
    const id = newId(meta.source);
    const folder = join(this.dir, id);
    try {
      const encoded = await encodeVariants(input, folder, meta.maxBytes);
      const name = rawName.replace(/\.[^.]+$/, '').trim().slice(0, 40) || '我的壁纸';
      return await this.insert(ownerId, { id, name, ...encoded, meta });
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      throw e;
    }
  }

  /** A picture whose variants already exist (a kept 每日一图): the files are copied, not encoded again. */
  async addEncoded(ownerId: string, from: string, w: UploadedWallpaper, meta: WallpaperMeta): Promise<UploadedWallpaper> {
    const id = newId(meta.source);
    const folder = join(this.dir, id);
    try {
      await cp(from, folder, { recursive: true, filter: (src) => src === from || VARIANT.test(basename(src)) });
      return await this.insert(ownerId, { id, name: w.name, width: w.width, height: w.height, widths: w.widths, placeholder: w.placeholder, luma: w.luma, meta });
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      throw e;
    }
  }

  /** A hotlinked photo: only metadata is kept; `color` paints until the image arrives. */
  addRemote(ownerId: string, remote: string, name: string, size: { width: number; height: number }, color: string, meta: WallpaperMeta): Promise<UploadedWallpaper> {
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#2a2724';
    const placeholder = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${hex}"/></svg>`)}`;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const luma = Math.round((0.2126 * r! + 0.7152 * g! + 0.0722 * b!) * 1000) / 1000;
    return this.insert(ownerId, { id: newId(meta.source), name: name.slice(0, 40) || '在线壁纸', width: size.width, height: size.height, widths: [], placeholder, luma, meta, remote });
  }

  private async insert(ownerId: string, w: { id: string; name: string; width: number; height: number; widths: number[]; placeholder: string; luma: number | null; meta: WallpaperMeta; remote?: string }): Promise<UploadedWallpaper> {
    const createdAt = new Date().toISOString();
    // The files are already on disk (encoded or copied): their size is what the account spends.
    const bytes = w.remote ? 0 : await folderBytes(join(this.dir, w.id));
    const write = () => this.db.run('insert into wallpapers (id, owner_id, name, width, height, widths, placeholder, created_at, source, ref, credit, luma, focal, remote) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      w.id,
      ownerId,
      w.name,
      w.width,
      w.height,
      JSON.stringify(w.widths),
      w.placeholder,
      createdAt,
      w.meta.source,
      w.meta.ref ?? '',
      w.meta.credit ? JSON.stringify(w.meta.credit) : '',
      w.luma,
      w.meta.focal ? JSON.stringify(w.meta.focal) : '',
      w.remote ?? '',
    ]);
    await (this.quota ? this.quota.admit(ownerId, 'wallpapers', bytes, write) : write());
    return (await this.get(ownerId, w.id))!;
  }

  /** Absolute path of a variant of the account's own wallpaper, or null. Both parts are pattern-checked: no path traversal. */
  async filePath(ownerId: string, id: string, file: string): Promise<string | null> {
    const m = VARIANT.exec(file);
    if (!ID.test(id) || !m) return null;
    const w = await this.get(ownerId, id);
    return w && w.widths.includes(Number(m[1])) ? join(this.dir, id, file) : null;
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    if (!ID.test(id) || !(await this.get(ownerId, id))) return false;
    await this.db.run('delete from wallpapers where id = ? and owner_id = ?', [id, ownerId]);
    // Another account's copy of the same public picture has a folder of its own: nothing shared is removed.
    await rm(join(this.dir, id), { recursive: true, force: true });
    return true;
  }

  /** Takes a row out of the library and moves its files into `dest`; nothing is deleted. */
  async moveOut(ownerId: string, id: string, dest: string) {
    await rename(join(this.dir, id), join(dest, id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await this.db.run('delete from wallpapers where id = ? and owner_id = ?', [id, ownerId]);
  }

  /** From now on the row is the user's own, however it got here. */
  async markSaved(ownerId: string, id: string) {
    await this.db.run("update wallpapers set source = 'saved' where id = ? and owner_id = ?", [id, ownerId]);
  }
}
