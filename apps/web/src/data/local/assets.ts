import { useEffect, useState } from 'react';
import type { LocalStore } from './store';

/**
 * Pictures of 本地收藏 on screen (v0.5 · U1): uploaded icons (`li-…`) and wallpapers (`lw-…`) live
 * in IndexedDB; the pages refer to them by the same addresses as on the server
 * (`/api/icons/<ref>.png`, a wallpaper's id), and these hooks — the host's useImage /
 * useWallpaperFile — turn a local one into an object URL. One URL per file per page, kept while the
 * page lives (a handful of small images).
 */
const urls = new Map<string, string | null>();
const loading = new Map<string, Promise<string | null>>();

const ICON = /^\/api\/icons\/(li-[a-z0-9]{6,32})\.png$/;
export const isLocalAsset = (id: string) => /^l[iw]-[a-z0-9]{6,32}$/.test(id);

function load(store: LocalStore, id: string): Promise<string | null> {
  let p = loading.get(id);
  if (!p) {
    p = store.asset(id).then((rec) => {
      const url = rec ? URL.createObjectURL(rec.blob) : null;
      urls.set(id, url);
      return url;
    });
    loading.set(id, p);
  }
  return p;
}

function useAsset(store: LocalStore, id: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (id ? (urls.get(id) ?? null) : null));
  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    if (urls.has(id)) {
      setUrl(urls.get(id) ?? null);
      return;
    }
    let live = true;
    void load(store, id).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [store, id]);
  return url;
}

/** host.useImage: a local icon → its object URL; any other address unchanged. */
export function localImageHook(store: LocalStore) {
  return function useImage(src: string | null): string | null {
    const m = src ? ICON.exec(src) : null;
    const local = useAsset(store, m ? m[1]! : null);
    return m ? local : src;
  };
}

/** host.useWallpaperFile: a local wallpaper → its one file (null while it loads). */
export function localWallpaperHook(store: LocalStore) {
  return function useWallpaperFile(u: { id: string } | undefined): string | null | undefined {
    const local = u && isLocalAsset(u.id) ? u.id : null;
    const url = useAsset(store, local);
    return local ? url : undefined;
  };
}

/** A local file was replaced or deleted: the next view loads it again. */
export function forgetAsset(id: string) {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  loading.delete(id);
}
