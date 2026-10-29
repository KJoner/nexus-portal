import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
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
      workbox: {
        // The shell opens offline; configuration comes from the app's own local cache, never the SW.
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,woff2}'],
        // Hundreds of CJK font subsets: fetched on first use instead of all upfront.
        globIgnores: ['**/noto-sans-sc-*'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/noto-sans-sc-'),
            handler: 'CacheFirst',
            options: { cacheName: 'nexus-fonts', expiration: { maxEntries: 400 } },
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
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    // Keep the browser's Host so the server's same-origin (CSRF) check sees the real origin.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: {
    target: 'es2022',
  },
});
