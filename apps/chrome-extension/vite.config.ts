import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/**
 * manifest.json carries the package version. NEXUS_EXT_TEST_HOSTS exists for the end-to-end tests
 * only (a separate output directory): it pre-grants the test server, because a browser under
 * automation cannot click Chrome's permission prompt. Release builds never set it.
 */
function manifest(): Plugin {
  return {
    name: 'nexus-manifest',
    generateBundle() {
      const m = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      m.version = pkg.version;
      const hosts = process.env.NEXUS_EXT_TEST_HOSTS;
      if (hosts) m.host_permissions = hosts.split(',');
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(m, null, 2)}\n` });
      // The built-in wallpaper is the portal's own file, not a second copy in the repository.
      this.emitFile({ type: 'asset', fileName: 'wallpapers/fallingwater.jpg', source: readFileSync(resolve(root, '../web/public/wallpapers/fallingwater.jpg')) });
    },
  };
}

/** Fontsource lists a .woff fallback after every .woff2; each Chrome that runs MV3 reads woff2. */
function woff2Only(): Plugin {
  return {
    name: 'nexus-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/@fontsource[\\/].+\.css$/.test(id)) return;
      return code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, '');
    },
  };
}

export default defineConfig({
  plugins: [woff2Only(), react(), tailwindcss(), manifest()],
  resolve: {
    // The new tab reuses the portal's home components (apps/web/src) instead of copying them.
    alias: { '@web': resolve(root, '../web/src') },
  },
  build: {
    target: 'es2022',
    outDir: process.env.NEXUS_EXT_OUT ?? 'dist',
    emptyOutDir: true,
    // The polyfill would land in background.js too, where there is no document.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { newtab: resolve(root, 'newtab.html'), options: resolve(root, 'options.html'), background: resolve(root, 'src/background.ts') },
      output: { entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js') },
    },
  },
});
