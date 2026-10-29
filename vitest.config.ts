import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'apps/web', 'apps/server', 'apps/chrome-extension'],
  },
});
