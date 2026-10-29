/// <reference types="chrome" />
import { chromium, expect, request, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The Chrome extension against the real server, in Playwright's Chromium (branded Chrome no longer
 * loads unpacked extensions from the command line). The extension is built into dist-test with the
 * test server pre-granted, because automation cannot click Chrome's permission prompt; the release
 * build is otherwise identical.
 */
const PORT = 8790;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EXT_DIR = resolve(import.meta.dirname, '../apps/chrome-extension');
const BUILD = join(EXT_DIR, 'dist-test');
const H = { 'X-Nexus-Client': '1' };

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extId: string;
let api: APIRequestContext;
let profile: string;

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve(EXT_DIR, '../../node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], {
    cwd: EXT_DIR,
    env: { ...process.env, NEXUS_EXT_OUT: 'dist-test', NEXUS_EXT_TEST_HOSTS: 'http://127.0.0.1/*' },
    stdio: 'inherit',
  });
  api = await request.newContext({ baseURL: ORIGIN });
  expect((await api.post('/api/auth/login', { headers: H, data: { password: 'e2e-password' } })).ok()).toBeTruthy();
  const baseline = JSON.parse(readFileSync(join(import.meta.dirname, '.baseline.json'), 'utf8'));
  await api.post('/api/config/ops', { headers: H, data: { clientId: 'e2e', batchId: `ext-${Date.now()}`, ops: [{ type: 'config.replace', config: baseline }] } });
  profile = mkdtempSync(join(tmpdir(), 'nexus-ext-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${BUILD}`, `--load-extension=${BUILD}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await api?.dispose();
  rmSync(profile, { recursive: true, force: true });
});

/** Lets the next new tab check the server again (as if 30 s had passed). */
async function expireThrottle(page: Page) {
  await page.evaluate(async () => {
    const { sync } = await chrome.storage.local.get('sync');
    if (sync) await chrome.storage.local.set({ sync: { ...sync, checkedAt: 0, error: null } });
  });
}

async function newTab(): Promise<Page> {
  const page = await context.newPage();
  await page.goto('chrome://newtab/');
  return page;
}

test('installs, opens the setup page, and pairs with the portal’s approval', async () => {
  const options = context.pages().find((p) => p.url().includes('options.html')) ?? (await context.waitForEvent('page', (p) => p.url().includes('options.html')));
  await expect(options.getByRole('heading', { name: '欢迎使用 Nexus 新标签页' })).toBeVisible();
  await options.getByLabel('Nexus Portal 地址').fill(ORIGIN);
  const approvalOpened = context.waitForEvent('page', (p) => p.url().includes('/settings/data?pair='));
  await options.getByRole('button', { name: '连接', exact: true }).click();
  const code = (await options.getByTestId('pair-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // The portal page: sign in, compare the code, allow.
  const approval = await approvalOpened;
  await approval.getByLabel('访问密码').fill('e2e-password');
  await approval.getByRole('button', { name: '进入' }).click();
  await expect(approval.getByRole('dialog')).toContainText(code);
  await expect(approval.getByRole('dialog')).toContainText('Chrome');
  await approval.getByRole('button', { name: '连接码一致，允许连接' }).click();

  // The extension picks up its token, closes the approval tab and syncs.
  await expect(options.getByText('已同步', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(options.getByText('127.0.0.1:8790')).toBeVisible();
  await options.screenshot({ path: 'test-results/extension-options.png', fullPage: true });
  const devices = (await (await api.get('/api/devices')).json()) as { name: string }[];
  expect(devices.map((d) => d.name)).toEqual([expect.stringContaining('Chrome')]);
});

test('Ctrl+T opens the extension’s own page, rendered from the local cache', async () => {
  const page = await context.newPage();
  const downloaded = new Set<string>();
  page.on('response', (r) => r.url().startsWith(`${ORIGIN}/api/sync/icon`) && r.status() === 200 && downloaded.add(r.url()));
  await page.goto('chrome://newtab/');
  // chrome://newtab is the extension's bundled page, not a redirect to the portal.
  expect(await page.evaluate(() => location.href)).toBe(`chrome-extension://${extId}/newtab.html`);
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'GitHub' }).first()).toBeVisible();
  const href = await page.getByRole('link', { name: 'GitHub' }).first().getAttribute('href');
  expect(href).toBe('https://github.com');

  // Icons come from the extension's image cache once downloaded.
  await expect.poll(() => page.evaluate(() => [...document.images].some((i) => i.src.startsWith('blob:chrome-extension://') && i.complete && i.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: 'test-results/extension-newtab.png' });
  // Icons still downloading (the server fetches brand icons from public CDNs, slow on some
  // networks) may be asked for again by the next tab; the ones already stored must not be.
  const stored = new Set(downloaded);
  await page.waitForTimeout(300);

  // A second new tab within 30 s does not sync again, re-downloads nothing it has, and logs no
  // error (CSP included).
  const requests: string[] = [];
  const problems: string[] = [];
  const second = await context.newPage();
  second.on('request', (r) => r.url().startsWith(ORIGIN) && requests.push(r.url()));
  // Chrome also logs answered-with-an-error requests (an icon CDN down); those are not page errors.
  second.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && problems.push(m.text()));
  second.on('pageerror', (e) => problems.push(e.message));
  await second.goto('chrome://newtab/');
  await expect(second.getByRole('link', { name: 'GitHub' }).first()).toBeVisible();
  await second.waitForTimeout(800);
  expect(requests.filter((u) => u.includes('/api/sync/config') || u.includes('/api/sync/status'))).toEqual([]);
  expect(requests.filter((u) => stored.has(u))).toEqual([]);
  expect(problems).toEqual([]);
  await second.close();
  await page.close();
});

test('shows the cache first, then picks up a change made in the portal', async () => {
  const page = await newTab();
  await expect(page.getByRole('link', { name: 'GitHub' }).first()).toBeVisible();
  await api.post('/api/config/ops', { headers: H, data: { clientId: 'e2e', batchId: `ext-unpin-${Date.now()}`, ops: [{ type: 'pin.remove', appId: 'github' }] } });
  await expireThrottle(page);
  // Hold the server's answer: the cached home must already be on screen meanwhile.
  await context.route('**/api/sync/config', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  const responded = page.waitForResponse('**/api/sync/config');
  await page.reload();
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible({ timeout: 1000 });
  const dock = page.locator('[data-dock-row]').first();
  await expect(dock.getByRole('link', { name: 'GitHub' })).toBeVisible();
  expect((await responded).status()).toBe(200);
  await expect(dock.getByRole('link', { name: 'GitHub' })).toHaveCount(0);
  await context.unroute('**/api/sync/config');

  // Unchanged since: a conditional request answered with 304, nothing downloaded again.
  await expireThrottle(page);
  const again = page.waitForResponse('**/api/sync/config');
  await page.reload();
  expect((await again).status()).toBe(304);
  await page.close();
});

test('read-only: menus offer opening and the portal’s settings, nothing that writes', async () => {
  const page = await newTab();
  await page.getByRole('link', { name: 'Notion' }).first().click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /在新标签页打开/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /在设置中编辑/ })).toBeVisible();
  for (const name of [/从首页移除/, /隐藏此应用/, /向前移动/, /编辑首页/]) await expect(menu.getByRole('menuitem', { name })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.click(60, 600, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: /打开设置/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /编辑首页/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /极简模式/ })).toHaveCount(0);
  // The gear opens the extension's own settings, in this tab.
  await page.keyboard.press('Escape');
  await page.keyboard.press(',');
  await expect(page).toHaveURL(`chrome-extension://${extId}/options.html`);
  await page.close();
});

test('offline, the cached navigation still opens', async () => {
  const page = await newTab();
  await expireThrottle(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Notion' }).first()).toBeVisible();
  await context.setOffline(false);
  await page.close();
});

test('a damaged cache is dropped and downloaded again', async () => {
  const page = await newTab();
  await page.evaluate(async () => {
    const { cache } = await chrome.storage.local.get('cache');
    await chrome.storage.local.set({ cache: { ...cache, data: { ...cache.data, config: { apps: 'broken' } } } });
  });
  await page.reload();
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.close();
});

test('revoked in the portal: the cached data goes and the new tab asks to reconnect', async () => {
  const [device] = (await (await api.get('/api/devices')).json()) as { id: string }[];
  expect((await api.delete(`/api/devices/${device!.id}`, { headers: H })).ok()).toBeTruthy();
  const page = await newTab();
  await expireThrottle(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: '此设备的授权已失效' })).toBeVisible();
  expect(await page.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).sort())).toEqual(['server']);
  await page.close();
});
