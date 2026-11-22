/**
 * Pictures for 本地收藏 (v0.5 · U1): what the server does with an upload (sharp), done in the browser
 * — a wallpaper becomes one JPEG of at most 2560 px with a tiny blurred placeholder and the mean
 * brightness behind the clock; an icon becomes a 128 × 128 PNG (so an export restores anywhere,
 * the server included, which expects PNG data). Nothing leaves this device.
 */
export const WALLPAPER_MAX_BYTES = 25 * 1024 * 1024;
export const ICON_MAX_BYTES = 2 * 1024 * 1024;
const WALLPAPER_WIDTH = 2560;

async function decode(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty');
    return img;
  } catch {
    throw new Error('无法读取这张图片（支持 JPEG、PNG、WebP、GIF、SVG）');
  } finally {
    // The decoded image keeps its pixels; the address is no longer needed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片处理失败'))), type, quality));

export async function prepareWallpaper(file: Blob): Promise<{ blob: Blob; width: number; height: number; placeholder: string; luma: number | null }> {
  if (file.size > WALLPAPER_MAX_BYTES) throw new Error('图片超过 25 MB，请换一张较小的');
  const img = await decode(file);
  const scale = Math.min(1, WALLPAPER_WIDTH / img.naturalWidth);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const big = canvas(width, height);
  big.getContext('2d')!.drawImage(img, 0, 0, width, height);
  const blob = await toBlob(big, 'image/jpeg', 0.86);
  const tw = 24;
  const th = Math.max(1, Math.round((height / width) * tw));
  const small = canvas(tw, th);
  const ctx = small.getContext('2d')!;
  ctx.drawImage(img, 0, 0, tw, th);
  const placeholder = small.toDataURL('image/jpeg', 0.5);
  // Mean brightness of the band behind the clock and search (a third to two thirds of the height).
  let luma: number | null = null;
  try {
    const y0 = Math.floor(th / 3);
    const band = ctx.getImageData(0, y0, tw, Math.max(1, Math.ceil(th / 3))).data;
    let sum = 0;
    for (let i = 0; i < band.length; i += 4) sum += (0.2126 * band[i]! + 0.7152 * band[i + 1]! + 0.0722 * band[i + 2]!) / 255;
    luma = Math.round((sum / (band.length / 4)) * 100) / 100;
  } catch {
    luma = null;
  }
  return { blob, width, height, placeholder, luma };
}

export async function prepareIcon(file: Blob): Promise<Blob> {
  if (file.size > ICON_MAX_BYTES) throw new Error('图标文件超过 2 MB');
  const img = await decode(file);
  const size = 128;
  const c = canvas(size, size);
  const ctx = c.getContext('2d')!;
  const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return toBlob(c, 'image/png');
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error('图片数据不正确');
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}
