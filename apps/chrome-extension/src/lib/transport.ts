import type { Bookmark, ServiceStatus, WallpaperSourcesResponse } from '@nexus/shared';
import { HttpError, NetworkError, type Transport } from '@web/data/transport';
import { ApiError, deviceApi, type Fetch } from './api';
import { KEYS, type Area, type ServerRecord, type SyncRecord } from './storage';
import { useExt } from './sync';

const readOnly = async (): Promise<never> => {
  throw new HttpError(403, 'read_only', '扩展只能读取导航，请在 Nexus Portal 中修改');
};

/** ApiError → the errors the portal's components already handle. */
function asPortalError(e: unknown): never {
  if (e instanceof ApiError) throw e.kind === 'offline' ? new NetworkError(e.message) : new HttpError(e.status || 500, e.kind, e.message);
  throw e;
}

/**
 * The portal's Transport for the new tab: the read-only calls the home makes on its own (search
 * suggestions, Linkwarden bookmarks, the 精选图库 catalog) go through /api/sync with the device
 * token; every write is refused. Configuration and status arrive through sync.ts instead.
 */
export function extensionTransport(area: Area, fetchImpl: Fetch): Transport {
  const server = (): ServerRecord => {
    const s = useExt.getState().server;
    if (!s || s.revoked) throw new HttpError(401, 'device_unauthorized', '扩展尚未连接 Nexus Portal');
    return s;
  };
  const get = <T>(path: string, signal?: AbortSignal, timeoutMs?: number) => {
    const s = server();
    return deviceApi(s.origin, fetchImpl).get<T>(s.token, path, signal, timeoutMs).catch(asPortalError);
  };
  return {
    getConfig: readOnly,
    postOps: readOnly,
    session: async () => !!useExt.getState().server,
    login: readOnly,
    logout: readOnly,
    uploadWallpaper: readOnly,
    uploadIcon: readOnly,
    deleteWallpaper: readOnly,
    getStatus: () => get<ServiceStatus[]>('status'),
    linkwarden: readOnly,
    connectLinkwarden: readOnly,
    disconnectLinkwarden: readOnly,
    searchBookmarks: async (q, signal) => (await get<{ bookmarks: Bookmark[] }>(`bookmarks?q=${encodeURIComponent(q)}`, signal, 6000)).bookmarks,
    suggest: async (engineId, q, signal) => (await get<{ suggestions: string[] }>(`suggest?engine=${encodeURIComponent(engineId)}&q=${encodeURIComponent(q)}`, signal, 4000)).suggestions,
    checkNow: readOnly,
    testHealth: readOnly,
    /** Changes only with the configuration revision, so it is kept per revision. */
    async wallpaperSources() {
      const { cache, sync } = useExt.getState();
      const revision = cache?.data.revision ?? -1;
      if (sync.sources?.revision === revision) return sync.sources.data;
      const data = await get<WallpaperSourcesResponse>('wallpaper-sources');
      const raw = (await area.get([KEYS.sync]))[KEYS.sync] as SyncRecord | undefined;
      if (raw?.origin === server().origin) await area.set({ [KEYS.sync]: { ...raw, sources: { revision, data } } });
      return data;
    },
    galleryWallpaper: readOnly,
    dailyWallpaper: readOnly,
    importWallpaper: readOnly,
    unsplashPhotos: readOnly,
    unsplashWallpaper: readOnly,
    devices: readOnly,
    revokeDevice: readOnly,
    pairingRequest: readOnly,
    decidePairing: readOnly,
    subscribe: () => () => {},
  };
}
