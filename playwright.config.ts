import { defineConfig, devices } from '@playwright/test';

const PORT = 8790;
const desktop = { viewport: { width: 1440, height: 900 } };

/**
 * End-to-end acceptance against the production build: Desktop Chrome, the locally installed
 * Microsoft Edge, and WebKit emulating iPhone Safari. Run with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: 'e2e',
  // One server, shared state: run serially and reset the configuration before each test.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', locale: 'zh-CN' },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
  },
  projects: [
    { name: 'chrome', testIgnore: /extension\.spec/, use: { ...devices['Desktop Chrome'], ...desktop } },
    { name: 'edge', testIgnore: /extension\.spec/, use: { ...devices['Desktop Edge'], channel: 'msedge', ...desktop } },
    { name: 'iphone', testIgnore: /extension\.spec/, use: { ...devices['iPhone 13'] } },
    // The Chrome extension (apps/chrome-extension) in a persistent Chromium profile it launches itself.
    { name: 'extension', testMatch: /extension\.spec/ },
  ],
});
