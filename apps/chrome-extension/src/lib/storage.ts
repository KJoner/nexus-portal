import { ConfigSchema, normalizeConfig, type ConfigResponse, type ServiceStatus, type WallpaperSourcesResponse } from '@nexus/shared';

/**
 * What the extension keeps in chrome.storage.local (only the extension's own pages can read it).
 *   server  the paired portal and this device's read-only token
 *   cache   the last configuration the server confirmed — changes only when the configuration does
 *   sync    when it was last checked, the latest service status, the last error (small, written often)
 * Images live in IndexedDB (assets.ts); small per-browser UI preferences in localStorage, as in the portal.
 */
export interface ServerRecord {
  origin: string;
  token: string;
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  /** The server rejected the token (revoked, password changed, idle too long): pair again. */
  revoked?: boolean;
}

export interface CacheRecord {
  origin: string;
  deviceId: string;
  etag: string | null;
  data: ConfigResponse;
  /** When this configuration arrived. */
  syncedAt: number;
}

export type SyncErrorKind = 'offline' | 'server';

export interface SyncRecord {
  origin: string;
  /** Last successful check with the server (200 or 304). */
  checkedAt: number;
  status: ServiceStatus[] | null;
  statusAt: number;
  error: { kind: SyncErrorKind; message: string; at: number } | null;
  /** 精选图库 catalog for gallery rotation, valid for one configuration revision. */
  sources?: { revision: number; data: WallpaperSourcesResponse };
}

/** The subset of chrome.storage.StorageArea used here (a fake in tests). */
export interface Area {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export const KEYS = { server: 'server', cache: 'cache', sync: 'sync' } as const;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function readServer(raw: unknown): ServerRecord | null {
  const r = raw as Partial<ServerRecord> | undefined;
  if (!r || !isStr(r.origin) || !isStr(r.token) || !isStr(r.deviceId)) return null;
  return { origin: r.origin, token: r.token, deviceId: r.deviceId, deviceName: r.deviceName ?? '', pairedAt: r.pairedAt ?? '', revoked: r.revoked === true };
}

/**
 * The cached configuration if it belongs to this server and device and still validates; anything
 * else (another server, a damaged entry, an older format) reads as "no cache" — never as data.
 */
export function readCache(raw: unknown, server: ServerRecord | null): CacheRecord | null {
  const r = raw as Partial<CacheRecord> | undefined;
  if (!server || !r || r.origin !== server.origin || r.deviceId !== server.deviceId || !r.data || typeof r.data !== 'object') return null;
  const parsed = ConfigSchema.safeParse(r.data.config);
  if (!parsed.success || typeof r.data.revision !== 'number' || !Array.isArray(r.data.wallpapers)) return null;
  return { origin: r.origin, deviceId: r.deviceId, etag: typeof r.etag === 'string' ? r.etag : null, syncedAt: Number(r.syncedAt) || 0, data: { ...r.data, config: normalizeConfig(parsed.data) } };
}

export function readSync(raw: unknown, server: ServerRecord | null): SyncRecord {
  const r = raw as Partial<SyncRecord> | undefined;
  const empty: SyncRecord = { origin: server?.origin ?? '', checkedAt: 0, status: null, statusAt: 0, error: null };
  if (!server || !r || r.origin !== server.origin) return empty;
  return { ...empty, checkedAt: Number(r.checkedAt) || 0, status: Array.isArray(r.status) ? r.status : null, statusAt: Number(r.statusAt) || 0, error: r.error ?? null, sources: r.sources };
}
