import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PASSWORD = 'e2e-password';
const H = { 'X-Nexus-Client': '1' };

export async function signIn(context: BrowserContext) {
  const r = await context.request.post('/api/auth/login', { headers: H, data: { password: PASSWORD } });
  expect(r.ok()).toBeTruthy();
}

export async function ops(api: APIRequestContext, list: unknown[]) {
  const r = await api.post('/api/config/ops', { headers: H, data: { clientId: 'e2e', batchId: `e2e-${Date.now()}-${Math.random()}`, ops: list } });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

export async function serverConfig(api: APIRequestContext) {
  return (await (await api.get('/api/config')).json()).config as { pins: string[]; apps: { id: string; name: string }[] };
}

/** Every test starts signed in, on the default configuration. */
export const test = base.extend<{ home: Page }>({
  home: async ({ page, context }, use) => {
    await signIn(context);
    await ops(context.request, [{ type: 'config.replace', config: JSON.parse(readFileSync(join(import.meta.dirname, '.baseline.json'), 'utf8')) }]);
    await page.goto('/');
    // First visit renders a boot screen until the server answers; wait for the real home.
    await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
    await use(page);
  },
});

export { expect };
