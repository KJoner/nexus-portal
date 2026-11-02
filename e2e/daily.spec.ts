import type { APIRequestContext, Page, Route } from '@playwright/test';
import { expect, ops, test } from './fixtures';

/**
 * 每日一图 against the real server, whose cache e2e/serve.mjs fills with today's picture, so no test
 * reaches Wikimedia. Days to come are answered by the tests themselves. The Service Worker is off:
 * Playwright cannot see the requests it makes.
 */
test.use({ serviceWorkers: 'block' });

const TODAY_ID = 'dl-0e2e0e2e0e2e';
const NEXT_ID = 'dl-1e2e1e2e1e2e';

type Look = { wallpaper: string; favorites: string[]; rotation: { mode: string } };
type Portal = { revision: number; config: { settings: { look: Look } }; wallpapers: { id: string; source: string; ref: string }[] };

const portal = async (api: APIRequestContext) => (await (await api.get('/api/config')).json()) as Portal;
const useDaily = async (api: APIRequestContext) => {
  const { rotation } = (await portal(api)).config.settings.look;
  await ops(api, [{ type: 'settings.patch', section: 'look', patch: { rotation: { ...rotation, mode: 'potd' } } }]);
};
const shown = (page: Page) => page.locator('[aria-hidden="true"] img[fetchpriority="high"]').first();
const expectPicture = (page: Page, id: string) => expect(shown(page)).toHaveAttribute('src', new RegExp(`/api/wallpapers/${id}/`));
/** Rows that exist because of 每日一图; other specs share this server and leave their uploads. */
const dailyRows = async (api: APIRequestContext) => (await portal(api)).wallpapers.filter((w) => w.source === 'daily' || w.source === 'saved');
const removeKept = async (api: APIRequestContext) => {
  for (const w of await dailyRows(api)) await api.delete(`/api/wallpapers/${w.id}`, { headers: { 'X-Nexus-Client': '1' } });
};

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const nextPicture = async (api: APIRequestContext) => {
  const today = (await (await api.get('/api/daily')).json()) as { wallpaper: Record<string, unknown> };
  return { date: day(1), wallpaper: { ...today.wallpaper, id: NEXT_ID, name: '每日一图 · 下一天' } };
};
/** The next day's files are today's, under the next day's id. */
const serveNextFiles = (page: Page) => page.route(`**/api/wallpapers/${NEXT_ID}/**`, (r: Route) => r.continue({ url: r.request().url().replace(NEXT_ID, TODAY_ID) }));

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('setting it again and again adds nothing to the library or to the fixed wallpaper', async ({ home: page }) => {
    const api = page.context().request;
    await page.goto('/settings/appearance');
    const apply = page.getByRole('button', { name: '应用到首页' });
    for (let i = 0; i < 3; i++) {
      await page.getByRole('tab', { name: '每日一图' }).click();
      await page.getByRole('button', { name: '使用每日一图' }).click();
      await apply.click();
      await expect.poll(async () => (await portal(api)).config.settings.look.rotation.mode).toBe('potd');
      await page.getByRole('tab', { name: '我的壁纸' }).click();
      await page.getByRole('button', { name: '夜苔' }).click();
      await apply.click();
      await expect.poll(async () => (await portal(api)).config.settings.look.rotation.mode).toBe('off');
    }
    await page.getByRole('tab', { name: '每日一图' }).click();
    await page.getByRole('button', { name: '使用每日一图' }).click();
    await apply.click();
    await expect.poll(async () => (await portal(api)).config.settings.look.rotation.mode).toBe('potd');

    expect(await dailyRows(api)).toEqual([]);
    expect((await portal(api)).config.settings.look.wallpaper).toBe('moss');

    // The mode, not a picture, is what was saved: it survives a reload.
    await page.goto('/');
    await expectPicture(page, TODAY_ID);
    await page.reload();
    await expectPicture(page, TODAY_ID);
    expect((await portal(api)).config.settings.look.rotation.mode).toBe('potd');
  });

  test('an open page changes with the date, with no request but the picture and nothing saved', async ({ home: page }) => {
    const api = page.context().request;
    await useDaily(api);
    const next = await nextPicture(api);
    await serveNextFiles(page);
    const midnight = Date.parse(`${day(1)}T00:00:00Z`);
    await page.clock.install({ time: midnight - 20_000 });
    let daily = 0;
    const writes: string[] = [];
    let tomorrow = false;
    await page.route('**/api/daily', async (r) => {
      daily++;
      if (tomorrow) return r.fulfill({ json: next });
      return r.continue();
    });
    page.on('request', (r) => {
      if (r.method() !== 'GET') writes.push(r.url());
    });
    await page.reload();
    await expectPicture(page, TODAY_ID);
    const before = await portal(api);
    daily = 0;

    // Still the same day: the once-a-minute check asks nobody.
    await page.clock.runFor(10_000);
    expect(daily).toBe(0);

    tomorrow = true;
    await page.clock.runFor(70_000);
    await expectPicture(page, NEXT_ID);
    await expect(page.getByText('每日一图 · 下一天').first()).toBeVisible();
    expect(daily).toBe(1);

    await page.clock.runFor(180_000);
    expect(daily).toBe(1);
    expect(writes).toEqual([]);
    expect((await portal(api)).revision).toBe(before.revision);
    expect(await dailyRows(api)).toEqual([]);
  });

  test('with the network failing the last picture stays, then the new one arrives by itself', async ({ home: page }) => {
    const api = page.context().request;
    await useDaily(api);
    const next = await nextPicture(api);
    await serveNextFiles(page);
    await page.reload();
    await expectPicture(page, TODAY_ID);

    await page.clock.install({ time: Date.parse(`${day(1)}T00:00:05Z`) });
    let failing = true;
    let asked = 0;
    await page.route('**/api/daily', (r) => {
      asked++;
      return failing ? r.abort() : r.fulfill({ json: next });
    });
    await page.reload();
    await expectPicture(page, TODAY_ID);
    await expect.poll(() => asked).toBe(1);

    // Not every minute check goes out: the pause after a failure holds.
    await page.clock.runFor(30_000);
    expect(asked).toBe(1);
    await page.clock.runFor(100_000);
    expect(asked).toBe(2);
    await expectPicture(page, TODAY_ID);

    failing = false;
    await page.clock.runFor(5 * 60_000);
    await expectPicture(page, NEXT_ID);
    await expect(page.getByRole('combobox', { name: '搜索' })).toBeVisible();
  });

  test('settings show the picture in use; another wallpaper turns the mode off again', async ({ home: page }) => {
    const api = page.context().request;
    await useDaily(api);
    await page.goto('/settings/appearance');
    const preview = page.getByRole('img', { name: /外观预览/ });
    await expect(page.getByRole('tab', { name: '每日一图' })).toHaveAttribute('aria-selected', 'true');
    await expect(preview.locator('img[fetchpriority="high"]')).toHaveAttribute('src', new RegExp(TODAY_ID));
    await expect(page.getByText('每日一图 · 测试').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '已在使用每日一图' })).toBeDisabled();

    // Dynamic: no picture of the library counts as chosen.
    await page.getByRole('tab', { name: '我的壁纸' }).click();
    await expect(page.getByRole('tabpanel').locator('[aria-pressed="true"]')).toHaveCount(0);

    await page.getByRole('button', { name: '流水别墅' }).click();
    await expect(preview.locator('img[fetchpriority="high"]')).toHaveAttribute('src', '/wallpapers/fallingwater.jpg');
    await page.getByRole('button', { name: '应用到首页' }).click();
    await expect.poll(async () => (await portal(api)).config.settings.look.rotation.mode).toBe('off');
    await page.goto('/');
    await expect(shown(page)).toHaveAttribute('src', '/wallpapers/fallingwater.jpg');
  });

  test('a timed rotation still works after 每日一图', async ({ home: page }) => {
    const api = page.context().request;
    await useDaily(api);
    const { rotation } = (await portal(api)).config.settings.look;
    await ops(api, [{ type: 'settings.patch', section: 'look', patch: { rotation: { ...rotation, mode: 'hourly' } } }]);
    await page.reload();
    const bar = page.getByRole('group', { name: '壁纸操作' }).locator('..');
    const before = await bar.innerText();
    await page.getByRole('button', { name: '换一张' }).click();
    await expect.poll(() => bar.innerText()).not.toBe(before);
    expect(await dailyRows(api)).toEqual([]);
  });

  test('stepping is not offered; 收藏 keeps the picture for good, in 我的壁纸', async ({ home: page }) => {
    const api = page.context().request;
    await useDaily(api);
    await page.reload();
    await expectPicture(page, TODAY_ID);
    const bar = page.getByRole('group', { name: '壁纸操作' }).locator('..');
    await expect(page.getByRole('button', { name: '换一张' })).toHaveCount(0);
    await bar.hover();
    await expect(page.getByRole('button', { name: '下一张壁纸' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '不喜欢这张' })).toHaveCount(0);

    await page.getByRole('button', { name: '收藏当前壁纸' }).click();
    await expect.poll(() => dailyRows(api)).toMatchObject([{ source: 'saved', ref: TODAY_ID }]);
    const { id } = (await dailyRows(api))[0]!;
    await expect.poll(async () => (await portal(api)).config.settings.look.favorites).toEqual([id]);
    await expect(page.getByRole('button', { name: '取消收藏当前壁纸' })).toBeVisible();
    await expectPicture(page, id);

    await page.goto('/settings/appearance');
    await page.getByRole('tab', { name: '我的壁纸' }).click();
    await expect(page.getByRole('button', { name: '每日一图 · 测试', exact: true })).toBeVisible();
    expect((await api.get(`/api/wallpapers/${id}/1280.webp`)).ok()).toBeTruthy();
    await removeKept(api);
  });

  test('锁定 fixes a library copy, so the wallpaper outlives the cache', async ({ home: page }) => {
    const api = page.context().request;
    await useDaily(api);
    await page.reload();
    await expectPicture(page, TODAY_ID);
    await page.getByRole('group', { name: '壁纸操作' }).locator('..').hover();
    await page.getByRole('button', { name: '锁定当前壁纸' }).click();
    await expect.poll(async () => (await portal(api)).config.settings.look.rotation.mode).toBe('off');
    const rows = await dailyRows(api);
    expect(rows).toMatchObject([{ source: 'saved', ref: TODAY_ID }]);
    expect((await portal(api)).config.settings.look.wallpaper).toBe(rows[0]!.id);
    await removeKept(api);
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile layout');

  test('the phone shows the same picture and keeps it across a reload', async ({ home: page }) => {
    const api = page.context().request;
    await useDaily(api);
    await page.reload();
    await expectPicture(page, TODAY_ID);
    await page.reload();
    await expectPicture(page, TODAY_ID);
    expect(await dailyRows(api)).toEqual([]);
  });
});
