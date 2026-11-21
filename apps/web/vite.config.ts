import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { PWA } from './pwa.config.ts';

export default defineConfig({
  // Service Worker routing and caches live in pwa.config.ts (NEX-01: what the shell may answer).
  plugins: [react(), tailwindcss(), VitePWA(PWA)],
  server: {
    port: 5173,
    // Keep the browser's Host so the server's same-origin (CSRF) check sees the real origin. /auth is
    // the server's too (unified sign-in): never the dev server's SPA fallback.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false }, '/auth': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: {
    target: 'es2022',
  },
});
