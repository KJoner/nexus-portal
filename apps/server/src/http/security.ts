import { CLIENT_HEADER } from '@nexus/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Env } from '../env';

export const apiError = (c: Context, status: 400 | 401 | 403 | 404 | 413 | 415 | 422 | 429 | 500, code: string, message: string) => c.json({ error: { code, message } }, status);

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
 * CSRF guard for API writes: a custom header (cannot be set cross-site without a CORS preflight,
 * which Nexus never grants) plus an Origin check when the browser sends one.
 */
export function csrf(env: Env): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    if (c.req.header(CLIENT_HEADER) !== '1') return apiError(c, 403, 'csrf', '请求缺少 Nexus 客户端标识');
    const origin = c.req.header('origin');
    if (origin) {
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
