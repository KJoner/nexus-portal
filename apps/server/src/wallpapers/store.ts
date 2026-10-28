import { WALLPAPER_WIDTHS, type UploadedWallpaper } from '@nexus/shared';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { DB } from '../db';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
const ID = /^up-[a-z0-9]{12}$/;
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
}

const toApi = (r: Row): UploadedWallpaper => ({ id: r.id, name: r.name, width: r.width, height: r.height, widths: JSON.parse(r.widths) as number[], placeholder: r.placeholder, createdAt: r.created_at });

/**
 * Uploaded wallpapers live under `<data>/wallpapers/<id>/`. Every upload is re-encoded, which strips
 * metadata (EXIF location) and guarantees the stored files are images regardless of what was sent.
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

  async add(input: Buffer, rawName: string): Promise<UploadedWallpaper> {
    if (input.length > MAX_UPLOAD_BYTES) throw new WallpaperError('too_large', `文件为 ${(input.length / 1048576).toFixed(1)} MB，超过 10 MB 上限`);
    let meta: Metadata;
    try {
      meta = await sharp(input, { limitInputPixels: 120_000_000 }).metadata();
    } catch {
      throw new WallpaperError('unsupported', '无法识别的图片文件，请使用 JPG、PNG、WebP 或 AVIF');
    }
    if (!meta.format || !FORMATS.has(meta.format)) throw new WallpaperError('unsupported', `不支持 ${meta.format ?? '该'} 格式，请使用 JPG、PNG、WebP 或 AVIF`);

    const base = sharp(input, { limitInputPixels: 120_000_000 }).rotate();
    // EXIF orientations 5–8 rotate by 90°, swapping the stored dimensions.
    const swap = (meta.orientation ?? 1) >= 5;
    const width = (swap ? meta.height : meta.width) ?? 0;
    const height = (swap ? meta.width : meta.height) ?? 0;
    const widths: number[] = WALLPAPER_WIDTHS.filter((w) => w <= width);
    if (!widths.length) widths.push(width);

    const id = `up-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12)}`;
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
      const name = rawName.replace(/\.[^.]+$/, '').trim().slice(0, 40) || '我的壁纸';
      const createdAt = new Date().toISOString();
      this.db.prepare('insert into wallpapers (id, name, width, height, widths, placeholder, created_at) values (?, ?, ?, ?, ?, ?, ?)').run(id, name, width, height, JSON.stringify(widths), placeholder, createdAt);
      return { id, name, width, height, widths, placeholder, createdAt };
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      throw e;
    }
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
