import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

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

/** App icons uploaded in the editor: stored as 256 px PNG under `<data>/icons/`. */
export class IconStore {
  constructor(private dir: string) {}

  async add(input: Buffer, mime: string): Promise<string> {
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
    return id;
  }

  filePath(id: string): string | null {
    return ID.test(id) ? join(this.dir, `${id}.png`) : null;
  }
}
