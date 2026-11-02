import type { Snapshot } from './schema';

/** Header every API write must carry; a cross-site form or image request cannot add it (CSRF guard). */
export const CLIENT_HEADER = 'X-Nexus-Client';

/** Where a wallpaper came from (v0.2). `daily` is never in the library; `saved` is one the user kept. */
export type WallpaperSource = 'upload' | 'url' | 'gallery' | 'daily' | 'unsplash' | 'saved';

/** Attribution shown with the wallpaper; `required` means the license asks for visible credit. */
export interface WallpaperCredit {
  author?: string;
  authorUrl?: string;
  license?: string;
  licenseUrl?: string;
  /** File page, photo page, or the imported address (origin + path only). */
  sourceUrl?: string;
  provider?: string;
  required?: boolean;
}

export interface UploadedWallpaper {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Generated variant widths, ascending; each exists as AVIF, WebP and JPEG. Empty for hotlinked photos. */
  widths: number[];
  /** Tiny blurred WebP as a data URL, painted before the real image decodes. */
  placeholder: string;
  createdAt: string;
  source: WallpaperSource;
  /** Source key: gallery id, POTD date, Unsplash photo id, the `dl-…` id of a kept 每日一图; '' for uploads. */
  ref: string;
  credit: WallpaperCredit | null;
  /** Mean brightness (0–1) of the band behind the clock and search; lifts the overlay on bright photos. */
  luma: number | null;
  /** Suggested focal point [x%, y%]. */
  focal: [number, number] | null;
  /** Hotlinked image base (Unsplash `urls.raw`); the browser adds size parameters. */
  remote?: string;
}

/** 精选图库 entry as listed by the server; `wallpaperId` once it has been downloaded. */
export interface GalleryItem {
  id: string;
  title: string;
  category: GalleryCategory;
  wallpaperId: string | null;
}

export type GalleryCategory = 'nature' | 'architecture' | 'minimal' | 'city' | 'dark';

export const GALLERY_CATEGORIES: Record<GalleryCategory, string> = {
  nature: '自然风景',
  architecture: '建筑与设计',
  minimal: '极简艺术',
  city: '城市与夜景',
  dark: '深色氛围',
};

export interface WallpaperSourcesResponse {
  gallery: GalleryItem[];
  /** Unsplash is available only when the deployer configured an access key. */
  unsplash: boolean;
}

/**
 * 每日一图. Not a library entry: the server keeps the last two pictures in a cache of their own and
 * nothing about them is synced; the shape only lets them render like any other wallpaper. `date` is
 * the UTC day the picture is for, older than today while the source cannot be reached.
 */
export interface DailyResponse {
  date: string;
  wallpaper: UploadedWallpaper;
}

/** Ids of cached 每日一图 pictures. They follow the Commons file: the same file keeps its id. */
export const isDailyId = (id: string) => /^dl-[0-9a-f]{12}$/.test(id);

export interface UnsplashPhoto {
  id: string;
  /** Hotlinked small preview (images.unsplash.com). */
  thumb: string;
  color: string;
  author: string;
  description: string;
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

export interface LinkwardenStatus {
  configured: boolean;
  baseUrl: string;
  /** Last four characters only — the token itself never leaves the server. */
  tokenLast4: string;
  lastOkAt: string | null;
  lastError: string | null;
}
