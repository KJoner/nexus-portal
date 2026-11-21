import { defineConfig } from '@playwright/test';

/**
 * 生产扩展包实装（NEX-05）：发布 zip 在真实浏览器里的端到端测试（e2e/extension-release.spec.ts）。
 * Windows 上运行（浏览器自己的对话框与右键菜单经 UI Automation）；先构建：
 *   npm run build && npm run package -w @nexus/chrome-extension
 *   npx playwright test -c playwright.release.config.ts [--project chromium|chrome|msedge]
 * 端口：E2E_REL_BASE_PORT（默认 39540）之后的 4 个；有窗口弹出，期间不要操作这些窗口。
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: /extension-release\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: process.env.E2E_REL_REPORT ?? 'test-results/extension-release.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    // Playwright's Chromium (unbranded): loads the unpacked package from the command line.
    { name: 'chromium' },
    // The installed Google Chrome: the package is installed over CDP (branded Chrome ignores --load-extension).
    { name: 'chrome' },
    // The installed Microsoft Edge, with the Edge zip (no manifest.key).
    { name: 'msedge' },
  ],
});
