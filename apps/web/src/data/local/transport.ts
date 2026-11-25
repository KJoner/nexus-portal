import {
  addLocalWallpaper,
  CONFLICT_CODES,
  CONFLICT_HTTP_CODE,
  exportCollection,
  LocalApiError,
  localConfigResponse,
  localItems,
  localPostOps,
  OpError,
  removeLocalWallpaper,
  uploadedIconRefs,
  type CatalogResponse,
  type LocalState,
  type UploadedWallpaper,
} from '@nexus/shared';
import { HttpError, type ItemsTransport, type RestoreAnswer, type Transport } from '../transport';
import { blobToDataUrl, prepareIcon, prepareWallpaper } from './images';
import { LocalStorageError, type AssetTx, type LocalStore } from './store';

/**
 * The portal's Transport over 本地收藏 (v0.5 · U1): the home page, 收藏, 应用目录 and 设置 run
 * unchanged, with the answers the server would give — computed here by the shared engine over this
 * browser's IndexedDB. No request leaves the device for any of it; the public 应用目录 is the one
 * exception, and only where the caller passes an online source for it (the portal's own public
 * catalog), with the bundled copy as the answer whenever that fails.
 *
 * What only a server can do (每日一图, 精选图库, health checks, Linkwarden, devices, accounts) is
 * refused with LOCAL_UNAVAILABLE — the pages hide those parts in a local collection anyway.
 */
export const LOCAL_UNAVAILABLE = 'LOCAL_UNAVAILABLE';
const unavailable = async (): Promise<never> => {
  throw new HttpError(501, LOCAL_UNAVAILABLE, '登录并开启同步后可用');
};

/** Local refusals → the errors the portal's components already handle (same codes as the server). */
export function asHttpError(e: unknown): never {
  if (e instanceof LocalApiError) throw new HttpError(e.status, e.code, e.message, false, null, e.details);
  if (e instanceof OpError) {
    if (e.quota) throw new HttpError(409, 'QUOTA_EXCEEDED', e.message, false, null, e.quota as unknown as Record<string, unknown>);
    if (CONFLICT_CODES.includes(e.code)) throw new HttpError(409, CONFLICT_HTTP_CODE[e.code as keyof typeof CONFLICT_HTTP_CODE], e.message, false, null, e.details ?? null);
    throw new HttpError(422, e.code, e.message);
  }
  if (e instanceof LocalStorageError) throw new HttpError(507, LOCAL_STORAGE_FAILED, e.message, false);
  throw e;
}
/** The browser did not store the change (quota, private window): nothing was saved, nothing is dropped. */
export const LOCAL_STORAGE_FAILED = 'LOCAL_STORAGE_FAILED';

const assetId = (prefix: 'li' | 'lw') => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(14))) s += alphabet[b % alphabet.length];
  return `${prefix}-${s}`;
};

/** A data URL → Blob, synchronously (inside an IndexedDB transaction nothing may be awaited). */
function dataUrlBlob(dataUrl: string): Blob {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new LocalApiError(422, 'VALIDATION', '图标数据不正确');
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

export interface LocalTransportOptions {
  store: LocalStore;
  now?: () => number;
  /** The public 应用目录 online (the portal's own `/api/v2/catalog`); the bundled copy otherwise. */
  onlineCatalog?: () => Promise<CatalogResponse>;
  bundledCatalog: () => Promise<CatalogResponse>;
}

export interface LocalTransport extends Transport {
  readonly local: true;
  store: LocalStore;
  /** The whole collection as a `nexus-collection` file (icons included); `exportedAt` fixed for a merge. */
  exportFile(exportedAt?: string, opts?: { onlyUsedFolders?: boolean }): Promise<ReturnType<typeof exportCollection>>;
  state(): Promise<LocalState>;
}

export function localTransport(opts: LocalTransportOptions): LocalTransport {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const run = async <T>(fn: (s: LocalState, a: AssetTx) => T): Promise<T> => {
    try {
      return await store.transact(fn);
    } catch (e) {
      return asHttpError(e);
    }
  };
  const read = async () => {
    try {
      return await store.read();
    } catch (e) {
      return asHttpError(e);
    }
  };

  const items: ItemsTransport = {
    snapshot: async () => localItems.snapshot(await read()),
    changes: async (cursor) => {
      const s = await read();
      try {
        return localItems.changes(s, cursor);
      } catch (e) {
        return asHttpError(e);
      }
    },
    create: (body) => run((s) => localItems.create(s, body, now())),
    patch: (id, body) => run((s) => localItems.patch(s, id, body, now())),
    remove: (id, opId, baseVersion) => run((s) => localItems.remove(s, id, opId, baseVersion, now())),
    restore: (id, opId, baseVersion) => run((s) => localItems.restore(s, id, opId, baseVersion, now())),
    trash: async () => localItems.trash(await read()),
    pin: (id, opId, position) => run((s) => localItems.pin(s, id, opId, position, now())),
    unpin: (id, opId) => run((s) => localItems.unpin(s, id, opId, now())),
    importItems: (body) => run((s) => localItems.importItems(s, body, now())),
    previewImport: async (body) => {
      const s = await read();
      try {
        return localItems.previewImportItems(s, body);
      } catch (e) {
        return asHttpError(e);
      }
    },
    createFavorites: (body) => run((s) => localItems.createFavorites(s, body, now())),
    saveFavorite: (id, body) => run((s) => localItems.saveFavorite(s, id, body, now())),
    moveItems: (body) => run((s) => localItems.moveItems(s, body, now())),
    undoImport: (importId, opId) => run((s) => localItems.undoImport(s, importId, opId, now())),
    restoreCollection: (body) =>
      run((s, a) =>
        localItems.restoreCollection(s, body, now(), (dataUrl) => {
          const blob = dataUrlBlob(dataUrl);
          const id = assetId('li');
          a.put({ id, kind: 'icon', type: blob.type || 'image/png', blob, bytes: blob.size, createdAt: now() });
          return id;
        }),
      ) as Promise<RestoreAnswer>,
    exportAll: () => exportFile(),
  };

  async function exportFile(exportedAt?: string, opts: { onlyUsedFolders?: boolean } = {}) {
    const s = await read();
    const icons: Record<string, string> = {};
    for (const ref of uploadedIconRefs(s)) {
      const rec = await store.asset(ref);
      if (rec) icons[ref] = await blobToDataUrl(rec.blob);
    }
    return exportCollection(s, icons, exportedAt ?? new Date(now()).toISOString(), opts);
  }

  return {
    local: true,
    store,
    state: read,
    exportFile,
    getConfig: async () => localConfigResponse(await read()),
    postOps: (batch) => run((s) => localPostOps(s, batch, now())),
    session: async () => false,
    login: unavailable,
    logout: unavailable,
    async uploadWallpaper(file) {
      let prepared: Awaited<ReturnType<typeof prepareWallpaper>>;
      try {
        prepared = await prepareWallpaper(file);
      } catch (e) {
        throw new HttpError(422, 'VALIDATION', e instanceof Error ? e.message : '无法读取这张图片');
      }
      const id = assetId('lw');
      const w: UploadedWallpaper = { id, name: file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || '我的壁纸', width: prepared.width, height: prepared.height, widths: [prepared.width], placeholder: prepared.placeholder, createdAt: new Date(now()).toISOString(), source: 'upload', ref: '', credit: null, luma: prepared.luma, focal: null };
      return run((s, a) => {
        a.put({ id, kind: 'wallpaper', type: prepared.blob.type || 'image/jpeg', blob: prepared.blob, bytes: prepared.blob.size, createdAt: now() });
        return addLocalWallpaper(s, w, now());
      });
    },
    async uploadIcon(file) {
      let png: Blob;
      try {
        png = await prepareIcon(file);
      } catch (e) {
        throw new HttpError(422, 'VALIDATION', e instanceof Error ? e.message : '无法读取这个图标');
      }
      const id = assetId('li');
      await run((_s, a) => a.put({ id, kind: 'icon', type: 'image/png', blob: png, bytes: png.size, createdAt: now() }));
      return id;
    },
    deleteWallpaper: (id) =>
      run((s, a) => {
        if (!removeLocalWallpaper(s, id, now())) throw new LocalApiError(404, 'not_found', '壁纸不存在');
        a.remove(id);
        return localConfigResponse(s);
      }),
    getStatus: async () => [],
    linkwarden: async () => ({ configured: false, baseUrl: '', tokenLast4: '', lastOkAt: null, lastError: null }),
    connectLinkwarden: unavailable,
    disconnectLinkwarden: unavailable,
    searchBookmarks: async () => [],
    suggest: async () => [],
    checkNow: unavailable,
    testHealth: unavailable,
    wallpaperSources: async () => ({ gallery: [], unsplash: false }),
    galleryWallpaper: unavailable,
    dailyWallpaper: unavailable,
    keepDaily: unavailable,
    importWallpaper: unavailable,
    unsplashPhotos: async () => [],
    unsplashWallpaper: unavailable,
    devices: unavailable,
    revokeDevice: unavailable,
    pairingRequest: unavailable,
    decidePairing: unavailable,
    authOptions: unavailable,
    me: unavailable,
    logoutAll: unavailable,
    revokeEverywhere: unavailable,
    revocationStatus: unavailable,
    retryRevocation: unavailable,
    adminRevocationStatus: unavailable,
    adminUsers: unavailable,
    setUserDisabled: unavailable,
    createInvite: unavailable,
    items,
    async catalog() {
      if (opts.onlineCatalog) {
        try {
          return await opts.onlineCatalog();
        } catch {
          /* offline, or the portal is down: the copy that came with the app */
        }
      }
      return opts.bundledCatalog();
    },
    subscribe({ onRevision }) {
      return store.onChange((r) => onRevision(r));
    },
  };
}
