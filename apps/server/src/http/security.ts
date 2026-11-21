import { CLIENT_HEADER } from '@nexus/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Env } from '../env';

export const apiError = (c: Context, status: 400 | 401 | 403 | 404 | 413 | 415 | 422 | 429 | 500 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);

export type V2Status = 400 | 401 | 403 | 404 | 409 | 410 | 412 | 413 | 422 | 426 | 429 | 500 | 502 | 503;

/**
 * Error body of the `/api/v2` interfaces (《A-接口与状态约定》§0.1): clients branch on `code` only;
 * `message` is for people and may be translated. The v1 interfaces keep `{error:{code,message}}`.
 */
export function v2Error(c: Context, status: V2Status, code: string, message: string, opts: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return c.json({ code, message, retryable: opts.retryable ?? status >= 500, requestId, ...(opts.details ? { details: opts.details } : {}) }, status);
}

/**
 * 配额与限流 (TN-07), the same two codes as LiteSync — they must stay distinguishable so clients
 * never retry forever:
 *  - QUOTA_EXCEEDED: permanent (counts 409, storage 413), retryable=false, details {kind, limit, used};
 *  - RATE_LIMITED: temporary, 429 + Retry-After, retryable=true, details {kind, retryAfterSeconds}.
 * On v1 routes the body also carries `error: {code, message}` so older clients still read it.
 */
export function quotaExceeded(c: Context, status: 409 | 413, details: { kind: string; limit: number; used: number }, message: string) {
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return c.json({ code: 'QUOTA_EXCEEDED', message, retryable: false, requestId, details, error: { code: 'quota_exceeded', message } }, status);
}

/**
 * A home-page change another device got ahead of (NEX-04): 409 with the 我的收藏 v2 code
 * (ITEM_DELETED / FIELD_CONFLICT / REVISION_CONFLICT) and what it is now, so the client keeps the
 * change for the person instead of dropping or forcing it. `error` keeps older clients reading it.
 */
export function opConflict(c: Context, code: string, v1Code: string, message: string, details?: Record<string, unknown>) {
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return c.json({ code, message, retryable: false, requestId, ...(details ? { details } : {}), error: { code: v1Code, message } }, 409);
}

export function rateLimited(c: Context, retryAfterSeconds: number, kind: string, message = '请求过于频繁，请稍后再试') {
  const secs = Math.max(1, Math.ceil(retryAfterSeconds));
  const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  c.header('Retry-After', String(secs));
  return c.json({ code: 'RATE_LIMITED', message, retryable: true, requestId, details: { kind, retryAfterSeconds: secs }, error: { code: 'rate_limited', message } }, 429);
}

export function isHttps(c: Context, env: Env): boolean {
  if (env.trustProxy) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    if (proto) return proto === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}

export function requestHost(c: Context, env: Env): string | undefined {
  return (env.trustProxy && c.req.header('x-forwarded-host')?.split(',')[0]?.trim()) || c.req.header('host');
}

/**
 * Brand icons still come from public CDNs until the icon cache lands (batch 3), hence `https:` in
 * img-src. Inline `style` attributes are part of the design, hence `'unsafe-inline'` for styles only.
 */
export const headers = () =>
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      // Vite inlines small font subsets as data: URIs.
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
    referrerPolicy: 'no-referrer',
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: 'same-origin',
    xFrameOptions: 'DENY',
  });

/**
 * Paired-device endpoints, called by the Chrome extension from its chrome-extension:// origin.
 * They never read the session cookie (pairing proves itself with a secret, sync with a bearer
 * token), so a forged cross-site request has nothing to ride on.
 */
const DEVICE_API = /^\/api\/(pair|sync)\//;
/**
 * Server-to-server (ADR-019 §2.4, the other product's revocation events): authenticated by an
 * HMAC signature over the raw body, never by a cookie — nothing for a cross-site request to ride on.
 */
const INTERNAL_API = /^\/api\/internal\//;

/**
 * CSRF guard for API writes: a custom header (cannot be set cross-site without a CORS preflight,
 * which Nexus never grants) plus an Origin check when the browser sends one — except on the
 * device endpoints above, which still need the header.
 */
export function csrf(env: Env): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || INTERNAL_API.test(c.req.path)) return next();
    if (c.req.header(CLIENT_HEADER) !== '1') return apiError(c, 403, 'csrf', '请求缺少 Nexus 客户端标识');
    const origin = c.req.header('origin');
    // A paired device authenticates with its bearer token, never with cookies: cross-site forgery
    // has nothing to ride on, and the extension's own origin is not this site's.
    const bearer = /^Bearer \S+$/.test(c.req.header('authorization') ?? '');
    if (origin && !bearer && !DEVICE_API.test(c.req.path)) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        /* invalid origin */
      }
      if (!host || (host !== requestHost(c, env) && !env.allowedOrigins.includes(origin))) return apiError(c, 403, 'csrf', '来源不受信任');
    }
    return next();
  };
}
