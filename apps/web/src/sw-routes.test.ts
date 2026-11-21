import { describe, expect, it } from 'vitest';
import { NavigationRoute } from 'workbox-routing';
import { AUTH_NAVIGATION_ROUTE, PWA, SERVER_ONLY_NAVIGATIONS, WORKBOX } from '../pwa.config';

/**
 * NEX-01 · RA-2 的正确行为（复审反例 nexus-sw-route-repro.mjs 转正）：用构建实际使用的配置
 * （pwa.config.ts，vite.config.ts 直接引用它）和安装依赖中真实的 Workbox NavigationRoute，
 * 判定每个导航会不会被离线应用壳接走。旧配置下 /auth/* 三个地址都被接走（审查结果 true）。
 * 生产构建在真实浏览器里的同一组断言见 e2e-auth/sw-auth.spec.ts。
 */
const shell = new NavigationRoute(() => Promise.resolve(new Response('CACHED INDEX')), { denylist: WORKBOX.navigateFallbackDenylist ?? [] });
const origin = self.location.href;
// A navigation as the Service Worker sees it (NavigationRoute only looks at the URL and `mode`).
const nav = (path: string) => !!shell.match({ url: new URL(path, origin), request: { mode: 'navigate' } } as never);

describe('Service Worker navigation routing (NEX-01)', () => {
  it.each([
    '/auth/login?returnTo=%2F',
    '/auth/login?returnTo=%2Flibrary&invite=nxi_x',
    '/auth/callback?code=redacted&state=redacted',
    '/auth/callback?error=access_denied&state=redacted',
    '/auth/link/start',
    '/auth/backchannel-logout',
    '/auth',
    '/api/v2/me',
    '/api/v2/export',
    '/api/healthz',
    '/api/events',
    '/icons/icon-192.png',
    '/manifest.webmanifest',
  ])('%s goes to the server, never to the cached shell', (path) => {
    expect(nav(path)).toBe(false);
  });

  it.each(['/', '/library', '/catalog', '/settings/data', '/settings/data?pair=ABCD-EFGH', '/?auth_error=state', '/?q=a.b', '/library?folder=x.y'])('%s still opens offline from the app shell', (path) => {
    expect(nav(path)).toBe(true);
  });

  it('the build config is the one vite.config.ts uses, with the old single rule replaced', () => {
    expect(PWA.workbox).toBe(WORKBOX);
    expect(WORKBOX.navigateFallback).toBe('/index.html');
    expect(WORKBOX.navigateFallbackDenylist).toBe(SERVER_ONLY_NAVIGATIONS);
    expect(SERVER_ONLY_NAVIGATIONS.map(String)).not.toEqual(['/^\\/api\\//']);
    // An installed older worker must give way at once, or it keeps answering /auth/* with the shell.
    expect(WORKBOX.skipWaiting).toBe(true);
    expect(WORKBOX.clientsClaim).toBe(true);
    expect(WORKBOX.runtimeCaching?.[0]).toBe(AUTH_NAVIGATION_ROUTE);
  });

  it('sign-in navigations are network-only; offline they get a clear 503 page, never the shell', async () => {
    const match = AUTH_NAVIGATION_ROUTE.urlPattern as (o: { request: { mode: string }; url: URL }) => boolean;
    expect(match({ request: { mode: 'navigate' }, url: new URL('/auth/login?returnTo=%2F', origin) })).toBe(true);
    expect(match({ request: { mode: 'navigate' }, url: new URL('/auth/callback?code=x&state=y', origin) })).toBe(true);
    expect(match({ request: { mode: 'cors' }, url: new URL('/auth/login', origin) })).toBe(false);
    expect(match({ request: { mode: 'navigate' }, url: new URL('/authors', origin) })).toBe(false);
    expect(match({ request: { mode: 'navigate' }, url: new URL('/library', origin) })).toBe(false);
    expect(AUTH_NAVIGATION_ROUTE.handler).toBe('NetworkOnly');
    const plugin = AUTH_NAVIGATION_ROUTE.options!.plugins![0]!;
    const res = (await plugin.handlerDidError!({} as never))!;
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('暂时无法登录');
    expect(html).toContain('这次登录没有完成');
    // Serialized into sw.js as source: it must not reference anything outside its own body.
    expect(String(plugin.handlerDidError)).not.toMatch(/\b(?:WORKBOX|PWA|SERVER_ONLY_NAVIGATIONS|import)\b/);
  });
});
