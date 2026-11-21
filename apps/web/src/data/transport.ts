import {
  applyOps,
  CLIENT_HEADER,
  defaultConfig,
  OpError,
  type ApiErrorBody,
  type AdminUser,
  type AppEntry,
  type AuthOptions,
  type Bookmark,
  type CatalogResponse,
  type ConfigResponse,
  type DeviceInfo,
  type HealthTestResult,
  type InviteResponse,
  type LinkwardenStatus,
  type LogoutAllResponse,
  type MeResponse,
  type RevokeEverywhereResponse,
  type OpBatch,
  type PairingRequest,
  type ServiceStatus,
  type UnsplashPhoto,
  type DailyResponse,
  type UploadedWallpaper,
  type WallpaperSourcesResponse,
  type ChangesResponse,
  type ItemInput,
  type ItemPatch,
  type ItemWriteResult,
  type SnapshotResponse,
} from '@nexus/shared';

/** Server answered with an error status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** v2 / TN-07: whether trying again later can succeed (RATE_LIMITED yes, QUOTA_EXCEEDED never). */
    readonly retryable = status === 429 || status >= 500,
    /** Seconds to wait (Retry-After), when the server said so. */
    readonly retryAfter: number | null = null,
    /** v2 details, e.g. {kind, limit, used} of QUOTA_EXCEEDED. */
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The request never got an answer (offline, server down, timeout). */
export class NetworkError extends Error {
  constructor(message = '无法连接 Nexus 服务端') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface Transport {
  getConfig(): Promise<ConfigResponse>;
  postOps(batch: OpBatch): Promise<ConfigResponse>;
  session(): Promise<boolean>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  uploadWallpaper(file: File): Promise<UploadedWallpaper>;
  uploadIcon(file: File): Promise<string>;
  deleteWallpaper(id: string): Promise<ConfigResponse>;
  getStatus(): Promise<ServiceStatus[]>;
  linkwarden(): Promise<LinkwardenStatus>;
  connectLinkwarden(baseUrl: string, token?: string): Promise<LinkwardenStatus>;
  disconnectLinkwarden(): Promise<LinkwardenStatus>;
  searchBookmarks(q: string, signal: AbortSignal): Promise<Bookmark[]>;
  suggest(engineId: string, q: string, signal: AbortSignal): Promise<string[]>;
  checkNow(appId: string): Promise<ServiceStatus>;
  testHealth(app: AppEntry): Promise<HealthTestResult>;
  /** v0.2 wallpaper sources: the POST calls return the library entry they made or already had. */
  wallpaperSources(): Promise<WallpaperSourcesResponse>;
  galleryWallpaper(id: string): Promise<UploadedWallpaper>;
  dailyWallpaper(): Promise<DailyResponse>;
  keepDaily(id: string): Promise<UploadedWallpaper>;
  importWallpaper(url: string): Promise<UploadedWallpaper>;
  unsplashPhotos(q: string, page: number): Promise<UnsplashPhoto[]>;
  unsplashWallpaper(id: string): Promise<UploadedWallpaper>;
  /** v0.3 paired devices (the Chrome extension): list, revoke, answer a pairing request. */
  devices(): Promise<DeviceInfo[]>;
  revokeDevice(id: string): Promise<DeviceInfo[]>;
  pairingRequest(code: string): Promise<PairingRequest>;
  decidePairing(code: string, approve: boolean, scopes?: string[]): Promise<void>;
  /** v0.4 accounts: sign-in options (public), who this session is. */
  authOptions(): Promise<AuthOptions>;
  me(): Promise<MeResponse>;
  /** ADR-019 动作 B · 退出 Nexus 的全部设备. */
  logoutAll(): Promise<LogoutAllResponse>;
  /** ADR-019 动作 C · 退出所有产品与设备: what happened to each part. */
  revokeEverywhere(): Promise<RevokeEverywhereResponse>;
  /** v0.4 administration (administrators only; the server answers 403 otherwise). */
  adminUsers(): Promise<AdminUser[]>;
  setUserDisabled(id: string, disabled: boolean): Promise<void>;
  createInvite(ttlDays: number): Promise<InviteResponse>;
  /** v0.4 我的收藏 (契约 §6): row-level items, pins, snapshot and changes. */
  items: ItemsTransport;
  /** v0.4 应用目录: public templates, all pages merged (the catalog is small). */
  catalog(): Promise<CatalogResponse>;
  /** Server pushes: config revisions and health results. Returns an unsubscribe function. */
  subscribe(h: { onOpen(): void; onRevision(revision: number): void; onStatus(s: ServiceStatus | { appId: string; removed: true }): void; onClosed(): void }): () => void;
}

export interface ItemsTransport {
  snapshot(page?: string): Promise<SnapshotResponse>;
  changes(cursor: string): Promise<ChangesResponse & { pins?: string[]; folders?: SnapshotResponse['folders'] }>;
  create(body: { opId: string; source?: 'manual' | 'catalog' | 'import'; item: ItemInput; pinToHome?: boolean; duplicatePolicy?: 'prompt' | 'update' | 'create' }): Promise<ItemWriteResult>;
  patch(id: string, body: { opId: string; baseVersion: number; patch: ItemPatch }): Promise<ItemWriteResult>;
  remove(id: string, opId: string): Promise<ItemWriteResult>;
  restore(id: string, opId: string): Promise<ItemWriteResult>;
  pin(id: string, opId: string, position?: number): Promise<{ pins: string[] }>;
  unpin(id: string, opId: string): Promise<{ pins: string[] }>;
  importItems(body: { opId: string; folderId?: string; items: ItemInput[]; skipDuplicates?: boolean }): Promise<{ importId: string; imported: number; skipped: number }>;
  undoImport(importId: string, opId: string): Promise<{ removed: number; kept: number }>;
  exportAll(): Promise<unknown>;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set(CLIENT_HEADER, '1');
    if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
    res = await fetch(path, { ...init, headers, credentials: 'same-origin', signal });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  // A reverse proxy answering for a dead upstream is still "offline" from the portal's point of view.
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new NetworkError();
  const body = (await res.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!res.ok) {
    // v1 answers {error:{code,message}}; the /api/v2 interfaces answer {code,message,retryable,…};
    // quota and rate-limit answers carry both (the v2 code wins: QUOTA_EXCEEDED / RATE_LIMITED).
    const v1 = (body as ApiErrorBody | null)?.error;
    const v2 = body as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown } | null;
    const isV2 = typeof v2?.code === 'string' && typeof v2?.retryable === 'boolean';
    const err = isV2 ? { code: v2!.code as string, message: typeof v2!.message === 'string' ? v2!.message : '' } : (v1 ?? (typeof v2?.code === 'string' ? { code: v2.code, message: typeof v2.message === 'string' ? v2.message : '' } : null));
    const after = Number(res.headers.get('retry-after'));
    const details = isV2 && v2!.details && typeof v2!.details === 'object' ? (v2!.details as Record<string, unknown>) : null;
    throw new HttpError(res.status, err?.code ?? 'http_error', err?.message || `请求失败（${res.status}）`, isV2 ? (v2!.retryable as boolean) : undefined, Number.isFinite(after) && after > 0 ? after : null, details);
  }
  return body as T;
}

export const httpTransport: Transport = {
  getConfig: () => request('/api/config'),
  postOps: (batch) => request('/api/config/ops', { method: 'POST', body: JSON.stringify(batch) }),
  session: async () => (await request<{ authenticated: boolean }>('/api/auth/session')).authenticated,
  login: async (password) => {
    await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
  },
  logout: async () => {
    await request('/api/auth/logout', { method: 'POST' });
  },
  uploadWallpaper: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/api/wallpapers', { method: 'POST', body: form }, 60_000);
  },
  deleteWallpaper: (id) => request(`/api/wallpapers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploadIcon: async (file) => {
    const form = new FormData();
    form.append('file', file);
    return (await request<{ id: string }>('/api/icons', { method: 'POST', body: form }, 30_000)).id;
  },
  getStatus: () => request('/api/status'),
  linkwarden: () => request('/api/integrations/linkwarden'),
  connectLinkwarden: (baseUrl, token) => request('/api/integrations/linkwarden', { method: 'PUT', body: JSON.stringify({ baseUrl, token: token || undefined }) }, 15_000),
  disconnectLinkwarden: () => request('/api/integrations/linkwarden', { method: 'DELETE' }),
  suggest: async (engineId, q, signal) => (await request<{ suggestions: string[] }>(`/api/suggest?engine=${encodeURIComponent(engineId)}&q=${encodeURIComponent(q)}`, { signal }, 4000)).suggestions,
  searchBookmarks: async (q, signal) => (await request<{ bookmarks: Bookmark[] }>(`/api/bookmarks?q=${encodeURIComponent(q)}`, { signal }, 6000)).bookmarks,
  checkNow: (appId) => request(`/api/status/${encodeURIComponent(appId)}/check`, { method: 'POST' }, 15_000),
  testHealth: (app) => request('/api/health/test', { method: 'POST', body: JSON.stringify({ app }) }, 15_000),
  wallpaperSources: () => request('/api/wallpaper-sources'),
  // Downloads and re-encodes a large original on the server: allow time.
  galleryWallpaper: (id) => request(`/api/gallery/${encodeURIComponent(id)}`, { method: 'POST' }, 60_000),
  dailyWallpaper: () => request('/api/daily', {}, 60_000),
  keepDaily: (id) => request(`/api/daily/${encodeURIComponent(id)}/keep`, { method: 'POST' }, 15_000),
  importWallpaper: (url) => request('/api/wallpapers/import', { method: 'POST', body: JSON.stringify({ url }) }, 60_000),
  unsplashPhotos: async (q, page) => (await request<{ photos: UnsplashPhoto[] }>(`/api/unsplash/photos?q=${encodeURIComponent(q)}&page=${page}`, {}, 10_000)).photos,
  unsplashWallpaper: (id) => request(`/api/unsplash/${encodeURIComponent(id)}`, { method: 'POST' }, 15_000),
  devices: () => request('/api/devices'),
  revokeDevice: (id) => request(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  pairingRequest: (code) => request(`/api/devices/pairing/${encodeURIComponent(code)}`),
  decidePairing: async (code, approve, scopes) => {
    await request(`/api/devices/pairing/${encodeURIComponent(code)}`, { method: 'POST', body: JSON.stringify(scopes ? { approve, scopes } : { approve }) });
  },
  authOptions: () => request('/api/v2/auth/options'),
  me: () => request('/api/v2/me'),
  logoutAll: () => request('/api/v2/account/logout-all', { method: 'POST' }),
  // The identity service and the other product are asked too: allow time for both.
  revokeEverywhere: () => request('/api/v2/account/revoke-everywhere', { method: 'POST' }, 30_000),
  items: {
    snapshot: (page) => request(`/api/v2/snapshot${page ? `?page=${encodeURIComponent(page)}` : ''}`, {}, 20_000),
    changes: (cursor) => request(`/api/v2/changes?cursor=${encodeURIComponent(cursor)}`),
    create: (body) => request('/api/v2/items', { method: 'POST', body: JSON.stringify(body) }),
    patch: (id, body) => request(`/api/v2/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id, opId) => request(`/api/v2/items/${encodeURIComponent(id)}?opId=${encodeURIComponent(opId)}`, { method: 'DELETE' }),
    restore: (id, opId) => request(`/api/v2/items/${encodeURIComponent(id)}/restore`, { method: 'POST', body: JSON.stringify({ opId }) }),
    pin: (id, opId, position) => request(`/api/v2/pins/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(position === undefined ? { opId } : { opId, position }) }),
    unpin: (id, opId) => request(`/api/v2/pins/${encodeURIComponent(id)}?opId=${encodeURIComponent(opId)}`, { method: 'DELETE' }),
    importItems: (body) => request('/api/v2/import', { method: 'POST', body: JSON.stringify(body) }, 60_000),
    undoImport: (importId, opId) => request(`/api/v2/import/${encodeURIComponent(importId)}/undo`, { method: 'POST', body: JSON.stringify({ opId }) }),
    exportAll: () => request('/api/v2/export', {}, 60_000),
  },
  adminUsers: async () => (await request<{ users: AdminUser[] }>('/api/v2/admin/users')).users,
  setUserDisabled: async (id, disabled) => {
    await request(`/api/v2/admin/users/${encodeURIComponent(id)}/${disabled ? 'disable' : 'enable'}`, { method: 'POST' });
  },
  createInvite: (ttlDays) => request('/api/v2/admin/invites', { method: 'POST', body: JSON.stringify({ ttlDays }) }),
  async catalog() {
    const first = await request<CatalogResponse>('/api/v2/catalog?limit=200');
    const items = [...first.items];
    for (let cursor = first.nextCursor; cursor; ) {
      const page: CatalogResponse = await request(`/api/v2/catalog?limit=200&cursor=${encodeURIComponent(cursor)}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    return { ...first, items, nextCursor: null };
  },
  subscribe({ onOpen, onRevision, onStatus, onClosed }) {
    if (typeof EventSource === 'undefined') return () => {};
    const es = new EventSource('/api/events');
    // Every (re)connect may have missed events, e.g. across a server restart: re-sync then.
    es.onopen = () => onOpen();
    es.addEventListener('revision', (e) => {
      const r = Number((JSON.parse((e as MessageEvent<string>).data) as { revision: number }).revision);
      if (Number.isFinite(r)) onRevision(r);
    });
    es.addEventListener('status', (e) => onStatus(JSON.parse((e as MessageEvent<string>).data)));
    // EventSource retries on its own; CLOSED means it gave up (e.g. 401), so the caller re-checks.
    es.onerror = () => es.readyState === EventSource.CLOSED && onClosed();
    return () => es.close();
  },
};

/** In-memory server for tests: same reducer, same idempotency rule as the real one. */
export class MemoryTransport implements Transport {
  revision = 1;
  config = defaultConfig();
  online = true;
  authenticated = true;
  seen = new Set<string>();
  calls: OpBatch[] = [];
  /** 应用目录 served by this fake server (tests fill it in; the real file is not bundled here). */
  catalogData: CatalogResponse = { catalogVersion: 'test', categories: [], items: [], nextCursor: null };
  /** v0.4: whose session this fake server answers for. */
  account: { id: string; role: 'admin' | 'user'; session: 'password' | 'oidc'; canLinkIdentity: boolean } = { id: 'legacy-admin', role: 'admin', session: 'password', canLinkIdentity: false };
  options: AuthOptions = { oidc: false, legacyPassword: true, registration: 'closed', accountUrl: null };
  loggedOutAll = 0;
  revokedEverywhere = 0;
  /** What 动作 C answers in tests. */
  everywhere: RevokeEverywhereResponse = { ok: true, local: { state: 'done', revokedSessions: 1, revokedDevices: 0, revokedGrants: 0 }, identityCenter: { state: 'done' }, peers: [{ product: 'litesync', state: 'delivered', eventId: '0'.repeat(32), attempts: 1, nextAttemptAt: null, error: null, result: 'applied' }] };
  catalogCalls = 0;
  private listeners = new Set<(r: number) => void>();

  private guard() {
    if (!this.online) throw new NetworkError();
    if (!this.authenticated) throw new HttpError(401, 'unauthenticated', '需要登录');
  }
  private response(): ConfigResponse {
    return { revision: this.revision, updatedAt: new Date().toISOString(), config: this.config, wallpapers: [] };
  }
  async getConfig() {
    this.guard();
    return this.response();
  }
  async postOps(batch: OpBatch) {
    this.guard();
    this.calls.push(batch);
    if (this.seen.has(batch.batchId)) return this.response();
    try {
      const next = applyOps(this.config, batch.ops);
      this.seen.add(batch.batchId);
      if (next !== this.config) {
        this.config = next;
        this.revision++;
        this.listeners.forEach((fn) => fn(this.revision));
      }
    } catch (e) {
      if (e instanceof OpError) throw new HttpError(422, e.code, e.message);
      throw e;
    }
    return this.response();
  }
  async session() {
    this.guard();
    return this.authenticated;
  }
  async login() {
    this.authenticated = true;
  }
  async logout() {
    this.authenticated = false;
  }
  async uploadWallpaper(): Promise<UploadedWallpaper> {
    throw new HttpError(415, 'unsupported', 'not in tests');
  }
  async deleteWallpaper() {
    return this.response();
  }
  async uploadIcon(): Promise<string> {
    throw new HttpError(415, 'unsupported', 'not in tests');
  }
  async getStatus(): Promise<ServiceStatus[]> {
    this.guard();
    return [];
  }
  async linkwarden(): Promise<LinkwardenStatus> {
    return { configured: false, baseUrl: '', tokenLast4: '', lastOkAt: null, lastError: null };
  }
  async connectLinkwarden(): Promise<LinkwardenStatus> {
    throw new HttpError(422, 'unreachable', 'not in tests');
  }
  async disconnectLinkwarden() {
    return this.linkwarden();
  }
  async searchBookmarks(): Promise<Bookmark[]> {
    return [];
  }
  async suggest(): Promise<string[]> {
    return [];
  }
  async checkNow(appId: string): Promise<ServiceStatus> {
    return { appId, level: 'ok', message: 'HTTP 200 · 1 ms', checkedAt: new Date().toISOString(), latencyMs: 1 };
  }
  async testHealth(): Promise<HealthTestResult> {
    return { ok: true, level: 'ok', message: 'HTTP 200 · 1 ms' };
  }
  async wallpaperSources(): Promise<WallpaperSourcesResponse> {
    return { gallery: [], unsplash: false };
  }
  async galleryWallpaper(): Promise<UploadedWallpaper> {
    throw new HttpError(502, 'unavailable', '暂时无法连接 Wikimedia Commons');
  }
  async dailyWallpaper(): Promise<DailyResponse> {
    throw new HttpError(502, 'unavailable', '暂时无法连接 Wikimedia Commons');
  }
  async keepDaily(): Promise<UploadedWallpaper> {
    throw new HttpError(404, 'not_found', '这张每日一图已经过期，无法收藏');
  }
  async importWallpaper(): Promise<UploadedWallpaper> {
    throw new HttpError(422, 'blocked', 'not in tests');
  }
  async unsplashPhotos(): Promise<UnsplashPhoto[]> {
    return [];
  }
  async unsplashWallpaper(): Promise<UploadedWallpaper> {
    throw new HttpError(404, 'not_configured', '未配置 Unsplash Access Key');
  }
  async devices(): Promise<DeviceInfo[]> {
    return [];
  }
  async revokeDevice(): Promise<DeviceInfo[]> {
    return [];
  }
  async pairingRequest(): Promise<PairingRequest> {
    throw new HttpError(404, 'not_found', '连接请求不存在或已过期');
  }
  async decidePairing(): Promise<void> {
    throw new HttpError(404, 'not_found', '连接请求不存在或已过期');
  }
  async authOptions(): Promise<AuthOptions> {
    if (!this.online) throw new NetworkError();
    return this.options;
  }
  async me(): Promise<MeResponse> {
    this.guard();
    const a = this.account;
    return { account: { id: a.id, displayName: a.id === 'legacy-admin' ? '管理员' : a.id, email: '', emailVerified: false }, product: 'nexus', role: a.role, permissions: [], onboarding: { state: this.config.apps.length ? 'ready' : 'empty_collection' }, session: a.session, identityLinked: a.session === 'oidc', canLinkIdentity: a.canLinkIdentity };
  }
  async logoutAll(): Promise<LogoutAllResponse> {
    this.guard();
    this.loggedOutAll++;
    this.authenticated = false;
    return { sessions: 1, devices: 0, grants: 0, endSessionUrl: null };
  }
  async revokeEverywhere(): Promise<RevokeEverywhereResponse> {
    this.guard();
    this.revokedEverywhere++;
    this.authenticated = false;
    return this.everywhere;
  }
  items: ItemsTransport = new Proxy({} as ItemsTransport, { get: () => async () => { throw new HttpError(501, 'not_in_tests', '收藏库接口在单元测试中不可用'); } });
  users: AdminUser[] = [];
  invites: InviteResponse[] = [];
  async adminUsers(): Promise<AdminUser[]> {
    this.guard();
    return this.users;
  }
  async setUserDisabled(id: string, disabled: boolean): Promise<void> {
    this.guard();
    this.users = this.users.map((u) => (u.id === id ? { ...u, disabled } : u));
  }
  async createInvite(ttlDays: number): Promise<InviteResponse> {
    this.guard();
    const invite = { code: `nxi_test${this.invites.length}`, expiresAt: Date.now() + ttlDays * 86_400_000 };
    this.invites.push(invite);
    return invite;
  }
  async catalog(): Promise<CatalogResponse> {
    if (!this.online) throw new NetworkError();
    this.catalogCalls++;
    return this.catalogData;
  }
  subscribe({ onRevision }: { onRevision(r: number): void }) {
    this.listeners.add(onRevision);
    return () => this.listeners.delete(onRevision);
  }
  /** Simulates another device changing the configuration. */
  remoteChange(ops: Parameters<typeof applyOps>[1]) {
    this.config = applyOps(this.config, ops);
    this.revision++;
    this.listeners.forEach((fn) => fn(this.revision));
  }
}
