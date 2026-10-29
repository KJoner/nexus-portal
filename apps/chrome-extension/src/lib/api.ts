import { CLIENT_HEADER, type ApiErrorBody, type ConfigResponse, type PairPollResponse, type PairStartResponse, type ServiceStatus } from '@nexus/shared';

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
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Fetch = typeof fetch;

interface CallInit {
  method?: 'GET' | 'POST';
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
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new ApiError('offline', `Nexus Portal 暂时不可用（${res.status}）`, res.status);
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  const code = body?.error?.code;
  // Only Nexus' own answer counts as a revoked token: a 401 from a proxy in front must not wipe the cache.
  if (res.status === 401 && code === 'device_unauthorized') throw new ApiError('unauthorized', body!.error.message, 401);
  if (res.status === 404 && path.startsWith('/api/pair/')) throw new ApiError('incompatible', '这个地址不是 Nexus Portal，或服务端版本低于 0.3.0', 404);
  throw new ApiError('server', body?.error?.message ?? `Nexus Portal 返回错误（${res.status}）`, res.status);
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
    pairStart: async (name: string) => json<PairStartResponse>(await call(fetchImpl, origin, '/api/pair/start', { method: 'POST', body: { name } })),
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
  };
}

export type DeviceApi = ReturnType<typeof deviceApi>;
