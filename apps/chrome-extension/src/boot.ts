import { startLocal, setTransport, useConfigStore } from '@web/data/config-store';
import { localImageHook, localWallpaperHook } from '@web/data/local/assets';
import { setLocalTransport } from '@web/data/local/web';
import { configureHost } from '@web/lib/host';
import type { Fetch } from './lib/api';
import { clearAssets, loadAssets, prefetchWallpaper, useImage, useWallpaperFile } from './lib/assets';
import { extLocal, readSpace, type ExtSpace } from './lib/local';
import { forgetQueue } from './lib/queue-client';
import { KEYS } from './lib/storage';
import { initEngine, load, onStorageChange, useExt, webLock, type ExtState } from './lib/sync';
import { extensionTransport } from './lib/transport';
import { ext } from './lib/ext';

/**
 * Wires the portal's pages to the extension before anything renders.
 *
 *  - local    (v0.5, a fresh install, or chosen in the options): this extension's own collection —
 *             the home page, 收藏, 应用目录 and 设置 all work here, editable, with nothing on any server.
 *  - account  the paired portal's collection, read-only, images from the local cache, configuration
 *             from chrome.storage (as before v0.5).
 *
 * Both reads take a few milliseconds — no network request stands before the first paint.
 */
export async function boot(): Promise<{ space: ExtSpace; state: ExtState }> {
  const fetchImpl: Fetch = (...args) => fetch(...args);
  const area = ext.storage.local;
  initEngine({
    area,
    fetch: fetchImpl,
    now: Date.now,
    lock: webLock,
    forgetQueue,
    async wipe() {
      await clearAssets();
      try {
        // Only the portal's UI preferences live here (recent searches, wallpaper offsets, …). The
        // local collection is in IndexedDB `nexus-local`, which signing out or clearing never touches.
        localStorage.clear();
      } catch {
        /* storage disabled */
      }
    },
  });
  const space = await readSpace(area);
  if (space === 'local') {
    const t = extLocal();
    setLocalTransport(t);
    configureHost({ readOnly: false, useImage: localImageHook(t.store), useWallpaperFile: localWallpaperHook(t.store), localWhere: '此扩展', connectAccount: () => void ext.runtime.openOptionsPage() });
    useConfigStore.setState({ space: 'local', account: null, verified: false });
    // The pairing (if any) is read for the options and the popup; nothing of the account is shown.
    const [state] = await Promise.all([load({ show: false }), startLocal(t)]);
    ext.storage.onChanged.addListener((changes, name) => {
      // Another page switched to the account's collection: this one follows.
      if (name === 'local' && KEYS.space in changes) location.reload();
    });
    return { space, state };
  }
  configureHost({ readOnly: true, useImage, useWallpaperFile, prefetchWallpaper, localWhere: '此扩展' });
  useConfigStore.setState({ space: 'account' });
  setTransport(extensionTransport(area, fetchImpl));
  const [state] = await Promise.all([load({ show: true }), loadAssets({ server: () => useExt.getState().server, fetch: fetchImpl, now: Date.now })]);
  ext.storage.onChanged.addListener((changes, name) => {
    if (name !== 'local') return;
    if (KEYS.space in changes) return location.reload();
    onStorageChange(changes, () => location.reload());
  });
  return { space, state };
}

/** Host access is requested per server and given back when the extension no longer uses it. */
export async function releaseOrigin(origin: string) {
  await ext.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
}
