import { CLIENT_HEADER, type ApiErrorBody, type ConfigResponse, type Item, type ItemInput, type ItemWriteResult, type PairPollResponse, type PairStartResponse, type ServiceStatus } from '@nexus/shared';

/**
 * offline       no answer (network down, DNS, timeout, a proxy saying the upstream is gone)
 * unauthorized  the server rejected this device's token
 * incompatible  not a Nexus Portal, or one older than 0.3 (no device endpoints)
 * server        any other error answer
 */
export type ApiErrorKind = 'offline' | 'unauthorized' | 'incompatible' | 'server';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status = 0,
    /** The server's code (v1 `error.code` or v2 `code`), e.g. DUPLICATE, QUOTA_EXCEEDED, SCOPE_REQUIRED. */
    readonly code = '',
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Fetch = typeof fetch;

interface CallInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Requests to the paired portal. No cookies (the token is the only credential), no HTTP cache (the
 * extension keeps its own), and no redirects: a redirect means a wrong address, and following one
 * must never carry the token to another origin.
 */
export async function call(fetchImpl: Fetch, origin: string, path: string, init: CallInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  const headers: Record<string, string> = { [CLIENT_HEADER]: '1', ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal,
    });
  } catch {
    throw new ApiError('offline', '无法连接 Nexus Portal');
  } finally {
    clearTimeout(timer);
  }
  if (res.ok || res.status === 304) return res;
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    // Temporary — kept and sent again later. Nexus' own 503 says why (IDENTITY_UNAVAILABLE: the
    // account service cannot be asked right now, ADR-019) and when to try again; a proxy's says nothing.
    const busy = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    const after = Number(res.headers.get('retry-after'));
    throw new ApiError('offline', busy?.message ?? `Nexus Portal 暂时不可用（${res.status}）`, res.status, busy?.code ?? '', Number.isFinite(after) && after > 0 ? { retryAfterSeconds: after } : null);
  }
  // v1 answers {error:{code,message}}; the /api/v2 interfaces answer {code,message,retryable,details}.
  const body = (await res.json().catch(() => null)) as (ApiErrorBody & { code?: string; message?: string; details?: Record<string, unknown> }) | null;
  const code = body?.code ?? body?.error?.code ?? '';
  const msg = body?.message ?? body?.error?.message;
  // Only Nexus' own answer counts as a revoked token: a 401 from a proxy in front must not wipe the cache.
  if (res.status === 401 && (code === 'device_unauthorized' || code === 'DEVICE_REVOKED')) throw new ApiError('unauthorized', msg ?? '此设备的授权已失效', 401, code);
  if (res.status === 404 && path.startsWith('/api/pair/')) throw new ApiError('incompatible', '这个地址不是 Nexus Portal，或服务端版本低于 0.3.0', 404);
  throw new ApiError('server', msg ?? `Nexus Portal 返回错误（${res.status}）`, res.status, code, body?.details ?? null);
}

async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('server', 'Nexus Portal 返回了无法识别的内容', res.status);
  }
}

export type ConfigResult = { changed: false; etag: string | null } | { changed: true; etag: string | null; data: ConfigResponse };

export function deviceApi(origin: string, fetchImpl: Fetch = (...a) => fetch(...a)) {
  return {
    pairStart: async (name: string, scopes?: readonly string[]) => json<PairStartResponse>(await call(fetchImpl, origin, '/api/pair/start', { method: 'POST', body: scopes ? { name, scopes } : { name } })),
    pairPoll: async (pairId: string, secret: string) => json<PairPollResponse>(await call(fetchImpl, origin, '/api/pair/poll', { method: 'POST', body: { pairId, secret } })),
    /** Conditional: with the last ETag an unchanged configuration is a bodyless 304. */
    async config(token: string, etag: string | null): Promise<ConfigResult> {
      const res = await call(fetchImpl, origin, '/api/sync/config', { token, headers: etag ? { 'if-none-match': etag } : {} });
      if (res.status === 304) return { changed: false, etag };
      return { changed: true, etag: res.headers.get('etag'), data: await json<ConfigResponse>(res) };
    },
    status: async (token: string) => json<ServiceStatus[]>(await call(fetchImpl, origin, '/api/sync/status', { token })),
    get: async <T>(token: string, path: string, signal?: AbortSignal, timeoutMs?: number) => json<T>(await call(fetchImpl, origin, `/api/sync/${path}`, { token, signal, timeoutMs })),
    /** Icons and wallpapers; null when the server has no such file. */
    async image(token: string, apiPath: string): Promise<Blob | null> {
      try {
        const res = await call(fetchImpl, origin, apiPath.replace(/^\/api\//, '/api/sync/'), { token, timeoutMs: 30_000 });
        const type = res.headers.get('content-type') ?? '';
        if (!type.startsWith('image/')) throw new ApiError('server', '不是图片', res.status);
        return await res.blob();
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return null;
        throw e;
      }
    },
    revoke: async (token: string) => void (await call(fetchImpl, origin, '/api/sync/revoke', { method: 'POST', token, timeoutMs: 5000 })),
    // ── 我的收藏 (v0.4; needs items:* scopes) ─────────────────────────────
    folders: async (token: string) => json<{ folders: { id: string; label: string; locked: boolean }[]; account: { id: string; label: string } }>(await call(fetchImpl, origin, '/api/v2/folders', { token })),
    findItem: async (token: string, url: string) => (await json<{ items: Item[] }>(await call(fetchImpl, origin, `/api/v2/items?url=${encodeURIComponent(url)}`, { token }))).items[0] ?? null,
    createItem: async (token: string, body: { opId: string; source: 'extension'; item: ItemInput; pinToHome: boolean; duplicatePolicy: 'prompt' | 'update' }) => json<ItemWriteResult>(await call(fetchImpl, origin, '/api/v2/items', { method: 'POST', token, body, timeoutMs: 15_000 })),
  };
}

export type DeviceApi = ReturnType<typeof deviceApi>;
