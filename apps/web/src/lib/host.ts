import type { UploadedWallpaper } from '@nexus/shared';

/**
 * Where the home page runs. The portal itself (the default) edits its configuration and loads /api
 * images directly. The Chrome extension's new tab (apps/chrome-extension) renders the same home
 * components read-only and serves those images from its own cache; it configures this before the
 * first render and never changes it afterwards, so the hooks below keep a stable call order.
 */
export interface Host {
  /** No edit mode, pinning, hiding, moving, health re-checks or wallpaper favourites. */
  readOnly: boolean;
  /** Hook: an image address (often /api/…) → what <img> loads; null while it is not available. */
  useImage(src: string | null): string | null;
  /** Hook: one file for a library wallpaper (null while loading), or undefined for <picture>/srcset. */
  useWallpaperFile(u: UploadedWallpaper | undefined): string | null | undefined;
  /** Fetches a library wallpaper ahead of time; the portal warms the browser cache instead. */
  prefetchWallpaper?(u: UploadedWallpaper): void;
}

export const host: Host = {
  readOnly: false,
  useImage: (src) => src,
  useWallpaperFile: () => undefined,
};

export function configureHost(next: Partial<Host>) {
  Object.assign(host, next);
}
