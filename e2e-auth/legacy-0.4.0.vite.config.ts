import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { PWA, SHELL_RUNTIME_CACHING } from '../apps/web/pwa.config.ts';

/**
 * 升级测试夹具：同一个应用，换回 0.4.0（审查基线 498a037）的 Service Worker 路由——离线壳只排除
 * /api/，没有 skipWaiting / clientsClaim，也没有 /auth/* 的网络路由。e2e-auth/global-setup.ts
 * 用它构建到 e2e-auth/.legacy-dist；设置 NEXUS_E2E_LEGACY_DIST 可以改用真实的旧版构建产物。
 */
export default defineConfig({
  root: fileURLToPath(new URL('../apps/web', import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({ ...PWA, workbox: { ...PWA.workbox, navigateFallbackDenylist: [/^\/api\//], skipWaiting: false, clientsClaim: false, runtimeCaching: SHELL_RUNTIME_CACHING } }),
  ],
  logLevel: 'warn',
  build: { target: 'es2022', outDir: fileURLToPath(new URL('./.legacy-dist', import.meta.url)), emptyOutDir: true },
});
