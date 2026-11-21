import { defineConfig, devices } from '@playwright/test';

const desktop = { viewport: { width: 1440, height: 900 } };

/**
 * 统一登录与 Service Worker 的端到端测试（NEX-01 · RA-2）。每个用例自己启停生产构建的服务端和
 * 模拟身份服务（端口 39410/39411），所以不用 webServer，也不能与 playwright.config.ts 并行。
 * 运行：npm run build && npx playwright test -c playwright.auth.config.ts --project=chrome
 */
export default defineConfig({
  testDir: 'e2e-auth',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/auth-sw/results.json' }]],
  outputDir: 'test-results/auth-sw/artifacts',
  globalSetup: './e2e-auth/global-setup.ts',
  use: { trace: 'retain-on-failure', locale: 'zh-CN', serviceWorkers: 'allow' },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], ...desktop } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge', ...desktop } },
    { name: 'iphone', use: { ...devices['iPhone 13'] } },
  ],
});
