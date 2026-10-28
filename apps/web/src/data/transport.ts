import { applyOps, CLIENT_HEADER, defaultConfig, OpError, type ApiErrorBody, type ConfigResponse, type OpBatch, type UploadedWallpaper } from '@nexus/shared';

/** Server answered with an error status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
  /** Revision numbers pushed by the server. Returns an unsubscribe function. */
  subscribe(onRevision: (revision: number) => void, onClosed: () => void): () => void;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set(CLIENT_HEADER, '1');
    if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    res = await fetch(path, { ...init, headers, credentials: 'same-origin', signal: ctrl.signal });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  // A reverse proxy answering for a dead upstream is still "offline" from the portal's point of view.
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new NetworkError();
  const body = (await res.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!res.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new HttpError(res.status, err?.code ?? 'http_error', err?.message ?? `请求失败（${res.status}）`);
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
  subscribe(onRevision, onClosed) {
    if (typeof EventSource === 'undefined') return () => {};
    const es = new EventSource('/api/events');
    es.addEventListener('revision', (e) => {
      const r = Number((JSON.parse((e as MessageEvent<string>).data) as { revision: number }).revision);
      if (Number.isFinite(r)) onRevision(r);
    });
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
  subscribe(onRevision: (r: number) => void) {
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
