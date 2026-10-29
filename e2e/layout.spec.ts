import type { APIRequestContext } from '@playwright/test';
import { expect, ops, serverConfig, test } from './fixtures';

async function pinMany(api: APIRequestContext, n: number) {
  const cfg = (await serverConfig(api)) as unknown as { apps: Record<string, unknown>[] };
  const gh = cfg.apps.find((a) => a.id === 'github')!;
  const sites = Array.from({ length: n }, (_, i) => ({ ...gh, id: `wide-${i}`, name: `一个名字相当长的网站 ${i}`, url: `https://w${i}.example.com`, icon: { source: 'letter', ref: '', letter: 'W', tone: 0 } }));
  await ops(api, sites.map((app) => ({ type: 'app.upsert', app })));
  await ops(api, sites.map((s) => ({ type: 'pin.add', appId: s.id })));
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the smallest desktop window keeps the open extension and labels inside the window', async ({ home: page }) => {
    await pinMany(page.context().request, 25);
    await page.setViewportSize({ width: 900, height: 560 });
    await page.reload();
    await page.getByRole('button', { name: /展开更多快捷方式/ }).click();
    const slab = (await page.locator('.group\\/slab').boundingBox())!;
    expect(slab.x).toBeGreaterThanOrEqual(0);
    expect(slab.x + slab.width).toBeLessThanOrEqual(900);
    expect(slab.y + slab.height).toBeLessThanOrEqual(560);
    // Long names are cut with an ellipsis, never pushing tiles around.
    const label = page.getByRole('group', { name: /更多快捷方式/ }).getByRole('link').first().locator('span').last();
    expect(await label.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('a zoomed-in browser (200 %) gets the phone layout instead of a cramped desktop', async ({ home: page }) => {
    await page.setViewportSize({ width: 720, height: 450 });
    await page.reload();
    await expect(page.getByRole('searchbox', { name: '搜索' })).toBeVisible();
    await expect(page.locator('.group\\/slab')).toHaveCount(0);
  });

  test('a category moved while offline is sent when the connection returns', async ({ home: page, context }) => {
    await page.goto('/settings/apps');
    await page.getByRole('button', { name: '排序' }).click();
    await context.setOffline(true);
    await page.getByRole('button', { name: '分类「开发」的移动选项' }).click();
    await page.getByRole('menuitem', { name: '移到最后' }).click();
    await expect(page.locator('[data-sort-cat]').last()).toHaveAttribute('data-sort-cat', 'dev');
    await context.setOffline(false);
    const cats = async () => ((await serverConfig(context.request)) as unknown as { categories: { id: string }[] }).categories.map((k) => k.id);
    await expect.poll(cats, { timeout: 15_000 }).toEqual(['hosted', 'work', 'media', 'none', 'dev']);
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile layout');

  test('a short phone screen: the pulled-up sheet stops below the clock and scrolls inside', async ({ home: page }) => {
    await pinMany(page.context().request, 20);
    await page.setViewportSize({ width: 375, height: 600 });
    await page.reload();
    await page.getByRole('button', { name: '展开更多快捷方式' }).tap();
    const grid = page.getByRole('group', { name: '全部快捷方式' });
    await expect(grid).toBeVisible();
    const clock = (await page.locator('.tabular-nums').first().boundingBox())!;
    const sheetTop = await grid.evaluate((el) => el.closest('.overflow-hidden')!.getBoundingClientRect().top);
    expect(sheetTop).toBeGreaterThan(clock.y + clock.height);
    expect(await grid.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
