import type { Snapshot } from './schema';

/** Header every API write must carry; a cross-site form or image request cannot add it (CSRF guard). */
export const CLIENT_HEADER = 'X-Nexus-Client';

export interface UploadedWallpaper {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Generated variant widths, ascending; each exists as AVIF, WebP and JPEG. */
  widths: number[];
  /** Tiny blurred WebP as a data URL, painted before the real image decodes. */
  placeholder: string;
  createdAt: string;
}

/** Widths generated for every uploaded wallpaper (R1.5 · 壁纸分级加载). */
export const WALLPAPER_WIDTHS = [1280, 1920, 2560] as const;

export interface ConfigResponse extends Snapshot {
  wallpapers: UploadedWallpaper[];
}

export const wallpaperFile = (id: string, width: number, ext: 'avif' | 'webp' | 'jpg') => `/api/wallpapers/${id}/${width}.${ext}`;

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface SessionResponse {
  authenticated: boolean;
}
