import { setTransport } from '@web/data/config-store';
import { configureHost } from '@web/lib/host';
import type { Fetch } from './lib/api';
import { clearAssets, loadAssets, prefetchWallpaper, useImage, useWallpaperFile } from './lib/assets';
import { forgetQueue } from './lib/queue-client';
import { initEngine, load, onStorageChange, useExt, webLock, type ExtState } from './lib/sync';
import { extensionTransport } from './lib/transport';
import { ext } from './lib/ext';

/**
 * Wires the portal's home components to the extension before anything renders: read-only, images
 * from the local cache, configuration from chrome.storage. Both reads (settings and images) run
 * in parallel and take a few milliseconds — no network request stands before the first paint.
 */
export async function boot(): Promise<ExtState> {
  const fetchImpl: Fetch = (...args) => fetch(...args);
  const area = ext.storage.local;
  configureHost({ readOnly: true, useImage, useWallpaperFile, prefetchWallpaper });
  initEngine({
    area,
    fetch: fetchImpl,
    now: Date.now,
    lock: webLock,
    forgetQueue,
    async wipe() {
      await clearAssets();
      try {
        // Only the portal's UI preferences live here (recent searches, wallpaper offsets, …).
        localStorage.clear();
      } catch {
        /* storage disabled */
      }
    },
  });
  setTransport(extensionTransport(area, fetchImpl));
  const [state] = await Promise.all([load(), loadAssets({ server: () => useExt.getState().server, fetch: fetchImpl, now: Date.now })]);
  ext.storage.onChanged.addListener((changes, name) => {
    if (name === 'local') onStorageChange(changes, () => location.reload());
  });
  return state;
}

/** Host access is requested per server and given back when the extension no longer uses it. */
export async function releaseOrigin(origin: string) {
  await ext.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
}
