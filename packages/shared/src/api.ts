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

/** GET /api/v2/auth/options (v0.4, public): how this deployment signs people in. */
export interface AuthOptions {
  /** Unified sign-in through the identity service. */
  oidc: boolean;
  /** The old access password (the legacy administrator's way in). */
  legacyPassword: boolean;
  registration: 'closed' | 'invite' | 'open';
  /** The identity service's account console (profile, password, sessions), when OIDC is on. */
  accountUrl: string | null;
}

/** GET /api/v2/me (v0.4): who this session belongs to. Never a source of permissions on the client. */
export interface MeResponse {
  account: { id: string; displayName: string; email: string; emailVerified: boolean };
  product: 'nexus';
  role: 'admin' | 'user';
  permissions: string[];
  onboarding: { state: 'empty_collection' | 'ready' };
  /** How this session was opened. */
  session: 'password' | 'oidc';
  identityLinked: boolean;
  /** The legacy administrator, signed in with the old password, can bind a unified account. */
  canLinkIdentity: boolean;
}

/** GET /api/v2/admin/users (v0.4, administrators). */
export interface AdminUser {
  id: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  disabled: boolean;
  createdVia: 'legacy' | 'oidc';
  createdAt: number;
  lastLoginAt: number | null;
  /** Bound to an identity of the identity service. */
  linked: boolean;
}

/** POST /api/v2/admin/invites (v0.4): the code is shown once and stored only as a hash. */
export interface InviteResponse {
  code: string;
  expiresAt: number;
}

/**
 * POST /api/v2/account/logout-all — ADR-019 动作 B「退出 Nexus 的全部设备」: every browser session,
 * paired device and approved-but-unclaimed pairing of the account in Nexus. The identity service and
 * LiteSync are not affected.
 */
export interface LogoutAllResponse {
  sessions: number;
  devices: number;
  /** v0.4.1: approved pairings the extension had not picked up yet (they can no longer be). */
  grants?: number;
  /** Always null since v0.4.1 (B leaves the identity service alone); v0.4.0 sent the end-session address. */
  endSessionUrl: string | null;
}

/** Why the identity-service part of 动作 C did not happen. */
export type IdentityCenterError = 'not_configured' | 'no_identity' | 'no_identity_session' | 'session_expired' | 'forbidden' | 'not_supported' | 'unavailable';

/** One part of 动作 C sent to another product (ADR-019 §2.4). */
export type PeerRevocationState =
  | { product: string; state: 'not_configured' }
  | { product: string; state: 'pending' | 'delivered' | 'failed'; eventId: string; attempts: number; nextAttemptAt: string | null; error: string | null; result: string | null };

/**
 * POST /api/v2/account/revoke-everywhere — ADR-019 动作 C「退出所有产品与设备」. `ok` only when every
 * part is done / delivered; otherwise each part says what really happened.
 */
export interface RevokeEverywhereResponse {
  ok: boolean;
  local: { state: 'done'; revokedSessions: number; revokedDevices: number; revokedGrants: number };
  identityCenter: { state: 'done' } | { state: 'failed'; error: IdentityCenterError; accountUrl: string | null };
  peers: PeerRevocationState[];
}

/** One cross-product revocation event of the account (only times, products, states, error categories). */
export interface RevocationEventInfo {
  eventId: string;
  /** outgoing: this account ran 退出所有产品与设备 here; incoming: it was run in the other product. */
  direction: 'outgoing' | 'incoming';
  product: string;
  reason: string;
  state: 'pending' | 'delivered' | 'failed' | 'applied' | 'unknown-identity';
  attempts: number | null;
  nextAttemptAt: string | null;
  error: string | null;
  result: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/** GET /api/v2/account/revocations (ADR-019 §2.3). */
export interface RevocationStatusResponse {
  /** Whether 退出所有产品与设备 can reach the other product at all on this deployment. */
  peer: { product: string; configured: boolean };
  identityCenter: { configured: boolean; accountUrl: string | null };
  /** 中心停用检查 (an account stopped in the identity service loses its devices within 60 s). */
  centralCheck: { configured: boolean };
  events: RevocationEventInfo[];
}

/** GET /api/v2/admin/revocation-status (administrators). */
export interface AdminRevocationStatus {
  oidc: boolean;
  peer: { configured: boolean; product: string | null; pending: number; failed: number; lastError: string | null; lastDeliveredAt: string | null };
  centralCheck: { configured: boolean; lastError: string | null; lastErrorAt: string | null; lastSuccessAt: string | null };
}

export interface LinkwardenStatus {
  configured: boolean;
  baseUrl: string;
  /** Last four characters only — the token itself never leaves the server. */
  tokenLast4: string;
  lastOkAt: string | null;
  lastError: string | null;
}
