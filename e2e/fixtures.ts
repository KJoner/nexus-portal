import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PASSWORD = 'e2e-password';
const H = { 'X-Nexus-Client': '1' };

export async function signIn(context: BrowserContext) {
  const r = await context.request.post('/api/auth/login', { headers: H, data: { password: PASSWORD } });
  expect(r.ok()).toBeTruthy();
  // v0.5: a fresh browser starts with its own local collection; these tests are about the account's
  // (as if the person had chosen 「使用账号里的收藏」 after signing in). Local mode: e2e/local.spec.ts.
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('nexus.workspace.v1')) localStorage.setItem('nexus.workspace.v1', JSON.stringify({ kind: 'account', id: 'legacy-admin' }));
    } catch {
      /* storage disabled */
    }
  });
}

export async function ops(api: APIRequestContext, list: unknown[]) {
  const r = await api.post('/api/config/ops', { headers: H, data: { clientId: 'e2e', batchId: `e2e-${Date.now()}-${Math.random()}`, ops: list } });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

/**
 * Ids for apps a test creates. Each test resets the configuration, which moves the apps it made to
 * 回收站; since v0.4.1 (NEX-04) an ordinary upsert never brings a deleted id back, so every call
 * makes new ones.
 */
export const freshTag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
