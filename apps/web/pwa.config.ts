import type { VitePWAOptions } from 'vite-plugin-pwa';
import type { RuntimeCaching } from 'workbox-build';

/**
 * 只由服务端回答的导航（NEX-01）：接口，以及统一登录的全部路径——/auth/login、/auth/callback、
 * /auth/link/start（旧管理员认领）、/auth/backchannel-logout。Service Worker 绝不能拿缓存的应用壳
 * 回答它们：壳不能替任何人登录，而 /auth/callback 上的缓存页面看起来像「登录完成」，实际上什么都
 * 没有到达服务端。路径最后一段带扩展名的（直接打开的文件、下载）也不是应用页面。
 *
 * Workbox 用「路径 + 查询串」匹配这张表，所以扩展名规则只看查询串之前的部分。
 */
export const SERVER_ONLY_NAVIGATIONS: RegExp[] = [/^\/api(?:[/?]|$)/, /^\/auth(?:[/?]|$)/, /^[^?]*\/[^/?]+\.[a-z0-9]+(?:\?.*)?$/i];

/**
 * 0.4.0 起就有的运行时缓存（字体、壁纸、图标）。升级测试用它重建 0.4.0 的 Service Worker，所以单独导出。
 */
export const SHELL_RUNTIME_CACHING: RuntimeCaching[] = [
  {
    urlPattern: ({ url }) => url.pathname.startsWith('/assets/noto-sans-sc-'),
    handler: 'CacheFirst',
    options: { cacheName: 'nexus-fonts', expiration: { maxEntries: 400 } },
  },
  {
    // 每日一图 turns over daily: a small cache of its own that cannot push out library pictures.
    urlPattern: ({ url }) => /^\/api\/wallpapers\/dl-[^/]+\/[^/]+$/.test(url.pathname),
    handler: 'CacheFirst',
    options: { cacheName: 'nexus-daily', expiration: { maxEntries: 6, maxAgeSeconds: 7 * 86_400 }, cacheableResponse: { statuses: [200] } },
  },
  {
    // Library wallpaper variants never change (new picture → new id); gallery previews neither.
    urlPattern: ({ url }) => /^\/api\/wallpapers\/[^/]+\/[^/]+$/.test(url.pathname) || /^\/api\/gallery\/[^/]+\/preview$/.test(url.pathname),
    handler: 'CacheFirst',
    options: { cacheName: 'nexus-wallpapers', expiration: { maxEntries: 80 }, cacheableResponse: { statuses: [200] } },
  },
  {
    urlPattern: ({ url }) => url.pathname.startsWith('/api/icon-cache/') || url.pathname.startsWith('/api/icons/'),
    handler: 'StaleWhileRevalidate',
    options: { cacheName: 'nexus-icons', expiration: { maxEntries: 400 }, cacheableResponse: { statuses: [200] } },
  },
];

/**
 * 统一登录的导航一律走网络。离线（或服务端不可达）时回答一页明确的「暂时无法登录」（503），而不是
 * 应用壳——壳会让人以为已经登录。这个函数会被原样序列化进 sw.js，所以页面内容必须写在函数体里，
 * 不能引用外部变量。
 */
export const AUTH_NAVIGATION_ROUTE: RuntimeCaching = {
  urlPattern: ({ request, url }) => request.mode === 'navigate' && /^\/auth(?:\/|$)/.test(url.pathname),
  handler: 'NetworkOnly',
  options: {
    plugins: [
      {
        handlerDidError: async () =>
          new Response(
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>暂时无法登录 · Nexus</title></head>' +
              '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#1b1a17;color:#efeae1;font:15px/1.7 system-ui,sans-serif">' +
              '<main data-nexus-offline-auth style="max-width:420px;padding:28px"><h1 style="font-size:20px;font-weight:600;margin:0 0 12px">暂时无法登录</h1>' +
              '<p style="margin:0 0 10px;color:#efeae1b3">统一登录需要连接 Nexus 服务端和账号中心，但现在连不上（设备离线，或服务端暂时不可用）。这次登录没有完成，也没有改变任何登录状态。</p>' +
              '<p style="margin:0 0 18px;color:#efeae1b3">恢复网络后重新打开登录页即可。</p><a href="/" style="color:#e6c08a">返回首页</a></main></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
          ),
      },
    ],
  },
};

export const WORKBOX: NonNullable<VitePWAOptions['workbox']> = {
  // The shell opens offline; configuration comes from the app's own local cache, never the SW.
  globPatterns: ['**/*.{js,css,html,svg,png,jpg,woff2}'],
  // Hundreds of CJK font subsets: fetched on first use instead of all upfront.
  globIgnores: ['**/noto-sans-sc-*'],
  navigateFallback: '/index.html',
  navigateFallbackDenylist: SERVER_ONLY_NAVIGATIONS,
  maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
  cleanupOutdatedCaches: true,
  // 页面自己注册 Service Worker（injectRegister: false），这也关掉了 registerType 'autoUpdate' 本来会
  // 打开的这两项：没有它们，新版本要等所有 Nexus 标签页都关掉才生效——已安装的 0.4.0 版本会一直
  // 用应用壳回答 /auth/*（NEX-01）。新版本安装后立即接管，页面随即重新加载（autoUpdate）。
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [AUTH_NAVIGATION_ROUTE, ...SHELL_RUNTIME_CACHING],
};

/** vite-plugin-pwa options of the web app (vite.config.ts), shared with the upgrade test fixture. */
export const PWA: Partial<VitePWAOptions> = {
  registerType: 'autoUpdate',
  injectRegister: false,
  manifest: {
    name: 'Nexus',
    short_name: 'Nexus',
    description: '个人数字入口',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#1b1a17',
    theme_color: '#1b1a17',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: WORKBOX,
};
