import { randomBytes } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { DB } from '../db';

export const MAX_ICON_BYTES = 1024 * 1024;
const ID = /^ic-[a-z0-9]{12}$/;

export class IconError extends Error {
  constructor(
    readonly code: 'unsupported' | 'too_large' | 'unsafe',
    message: string,
  ) {
    super(message);
  }
}

/**
 * SVGs are rasterised, so scripts never reach a browser; references that could make the renderer
 * read local files or the network (`file:`, `http:`, entities) are refused before rendering.
 */
function assertSafeSvg(text: string) {
  if (/<!ENTITY|<!DOCTYPE/i.test(text)) throw new IconError('unsafe', 'SVG 中不能包含 DOCTYPE 或实体声明');
  const refs = text.match(/(?:xlink:)?href\s*=\s*["'][^"']*["']/gi) ?? [];
  if (refs.some((r) => !/=\s*["'](#|data:image\/)/i.test(r))) throw new IconError('unsafe', 'SVG 中不能引用外部文件或网址');
}

/**
 * App icons uploaded in the editor: stored as 256 px PNG under `<data>/icons/`. Each belongs to the
 * account that uploaded it (v0.4) and is served to that account only — an id is not a permission.
 */
export class IconStore {
  constructor(
    private db: DB,
    private dir: string,
    private now: () => number = Date.now,
  ) {}

  async add(ownerId: string, input: Buffer, mime: string): Promise<string> {
    if (input.length > MAX_ICON_BYTES) throw new IconError('too_large', `文件为 ${(input.length / 1048576).toFixed(1)} MB，超过 1 MB 上限`);
    const isSvg = mime === 'image/svg+xml' || input.subarray(0, 512).toString('utf8').includes('<svg');
    if (isSvg) assertSafeSvg(input.toString('utf8'));
    let png: Buffer;
    try {
      const meta = await sharp(input, { density: isSvg ? 300 : undefined }).metadata();
      if (!meta.format || !['png', 'webp', 'svg', 'jpeg'].includes(meta.format)) throw new Error('format');
      png = await sharp(input, { density: isSvg ? 300 : undefined })
        .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    } catch {
      throw new IconError('unsupported', '请使用 SVG、PNG 或 WebP 图片');
    }
    const id = `ic-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12)}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${id}.png`), png);
    await this.db.run('insert into icons (id, owner_id, created_at) values (?, ?, ?)', [id, ownerId, this.now()]);
    return id;
  }

  /** The file of one of the account's own icons, or null (unknown, malformed or someone else's). */
  async filePath(ownerId: string, id: string): Promise<string | null> {
    if (!ID.test(id)) return null;
    const row = await this.db.get('select 1 as x from icons where id = ? and owner_id = ?', [id, ownerId]);
    return row ? join(this.dir, `${id}.png`) : null;
  }

  /**
   * Icons uploaded before v0.4 have files but no rows: they were the single user's, so they become
   * `ownerId`'s. Idempotent (rows that exist are left alone); returns how many were adopted.
   */
  async adoptUnowned(ownerId: string): Promise<number> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    let n = 0;
    for (const name of names) {
      const id = name.replace(/\.png$/, '');
      if (!ID.test(id) || name !== `${id}.png`) continue;
      n += (await this.db.run('insert into icons (id, owner_id, created_at) values (?, ?, ?) on conflict (id) do nothing', [id, ownerId, this.now()])).changes;
    }
    return n;
  }
}
