import type { APIRequestContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, ops, serverConfig, test } from './fixtures';

type Look = { wallpaper: string; favorites: string[]; blocked: string[]; rotation: Record<string, unknown> };
type Ui = { desktop: Record<string, unknown>; mobile: Record<string, unknown> };
const settings = async (api: APIRequestContext) => ((await serverConfig(api)) as unknown as { settings: { look: Look; ui: Ui } }).settings;
const revision = async (api: APIRequestContext) => ((await (await api.get('/api/config')).json()) as { revision: number }).revision;

async function patchUi(api: APIRequestContext, desktop: Record<string, unknown>, mobile: Record<string, unknown> = {}) {
  const ui = (await settings(api)).ui;
  await ops(api, [{ type: 'settings.patch', section: 'ui', patch: { preset: 'custom', desktop: { ...ui.desktop, ...desktop }, mobile: { ...ui.mobile, ...mobile } } }]);
}

/** Uploads the built-in photo again as a library wallpaper; returns its id. */
async function uploadWallpaper(api: APIRequestContext) {
  const jpg = readFileSync(join(import.meta.dirname, '../apps/web/public/wallpapers/fallingwater.jpg'));
  const r = await api.post('/api/wallpapers', { headers: { 'X-Nexus-Client': '1' }, multipart: { file: { name: 'copy.jpg', mimeType: 'image/jpeg', buffer: jpg } } });
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as { id: string }).id;
}

const wallpaperImg = (page: Page) => page.locator('[aria-hidden="true"] img[fetchpriority="high"]').first();

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('with every optional control hidden, settings stay reachable', async ({ home: page }) => {
    await patchUi(page.context().request, { topbar: 'hide', status: 'hide', settings: 'hide', search: 'hide', wallpaperName: 'hide', wallpaperCredit: 'hide', wallpaperActions: 'hide' });
    await page.reload();
    await expect(page.locator('[data-dock="github"]')).toBeVisible();
    await expect(page.getByRole('link', { name: '设置' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);

    // `/` still brings the hidden search field back.
    await page.keyboard.press('/');
    await expect(page.getByRole('combobox', { name: '搜索' })).toBeFocused();
    await page.keyboard.press('Escape');

    // `,` opens settings.
    await page.mouse.click(60, 600);
    await page.keyboard.press(',');
    await expect(page).toHaveURL(/\/settings$/);

    // Right-click on the empty wallpaper offers the same.
    await page.goto('/');
    await page.mouse.click(60, 600, { button: 'right' });
    await page.getByRole('menuitem', { name: /打开设置/ }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('minimal preset: the top bar fades in when the pointer nears the top', async ({ home: page }) => {
    await page.mouse.click(60, 600, { button: 'right' });
    await page.getByRole('menuitem', { name: '切换到极简模式' }).click();
    await expect.poll(async () => (await settings(page.context().request)).ui.desktop.topbar).toBe('hover');
    const nav = page.getByRole('navigation', { name: '主导航' }).locator('..');
    await page.mouse.move(700, 600);
    await expect(nav).toHaveCSS('opacity', '0');
    await page.mouse.move(200, 30);
    await expect(nav).toHaveCSS('opacity', '1');
    // Apps and pins are untouched by presets.
    await expect(page.locator('[data-dock]')).toHaveCount(5);
  });

  test('a wallpaper that fails to load falls back to the built-in picture', async ({ home: page }) => {
    const api = page.context().request;
    const id = await uploadWallpaper(api);
    await ops(api, [{ type: 'settings.patch', section: 'look', patch: { wallpaper: id } }]);
    await page.route('**/api/wallpapers/*/*', (r) => r.abort());
    await page.reload();
    await expect(page.getByRole('combobox', { name: '搜索' })).toBeVisible();
    await expect(wallpaperImg(page)).toHaveAttribute('src', '/wallpapers/fallingwater.jpg');
  });

  test('每日一图 unavailable: the home page opens with the chosen wallpaper', async ({ home: page }) => {
    const api = page.context().request;
    const look = (await settings(api)).look;
    await ops(api, [{ type: 'settings.patch', section: 'look', patch: { rotation: { ...look.rotation, mode: 'potd' } } }]);
    await page.route('**/api/daily', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"x"}}' }));
    await page.reload();
    await expect(page.getByRole('combobox', { name: '搜索' })).toBeVisible();
    await expect(wallpaperImg(page)).toHaveAttribute('src', '/wallpapers/fallingwater.jpg');
  });

  test('timed rotation: 换一张 moves on locally without writing to the server', async ({ home: page }) => {
    const api = page.context().request;
    const look = (await settings(api)).look;
    await ops(api, [{ type: 'settings.patch', section: 'look', patch: { rotation: { ...look.rotation, mode: 'daily' } } }]);
    await page.reload();
    const bar = page.getByRole('group', { name: '壁纸操作' }).locator('..');
    const before = await bar.innerText();
    const rev = await revision(api);
    await page.getByRole('button', { name: '换一张' }).click();
    await expect.poll(() => bar.innerText()).not.toBe(before);
    expect(await revision(api)).toBe(rev);
    // Locking keeps the picture now on screen and stops rotating (a synced change).
    await bar.hover();
    await page.getByRole('button', { name: '锁定当前壁纸' }).click();
    await expect.poll(async () => (await settings(api)).look.rotation.mode).toBe('off');
  });

  test('favorite and dislike from the wallpaper bar', async ({ home: page }) => {
    const api = page.context().request;
    const bar = page.getByRole('group', { name: '壁纸操作' }).locator('..');
    await bar.hover();
    await page.getByRole('button', { name: '收藏当前壁纸' }).click();
    await expect.poll(async () => (await settings(api)).look.favorites).toEqual(['fallingwater']);
    await page.getByRole('button', { name: '不喜欢这张' }).click();
    await expect.poll(async () => (await settings(api)).look.blocked).toEqual(['fallingwater']);
    // Fixed mode: disliking also moves on to the next picture.
    await expect.poll(async () => (await settings(api)).look.wallpaper).not.toBe('fallingwater');
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile layout');

  test('settings button hidden: a long press on the wallpaper opens settings', async ({ home: page }) => {
    await patchUi(page.context().request, {}, { settings: 'hide', status: 'hide' });
    await page.reload();
    await expect(page.getByRole('link', { name: '设置' })).toHaveCount(0);
    const bg = page.locator('[data-bg-press]');
    const at = { pointerType: 'touch', isPrimary: true, pointerId: 11, button: 0, buttons: 1, clientX: 120, clientY: 300 };
    await bg.dispatchEvent('pointerdown', at);
    await page.waitForTimeout(650);
    await bg.dispatchEvent('pointerup', at);
    await page.getByRole('button', { name: '打开设置' }).tap();
    await expect(page).toHaveURL(/\/settings$/);
  });
});
