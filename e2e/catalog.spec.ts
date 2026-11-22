import { join } from 'node:path';
import { expect, serverConfig, test } from './fixtures';

/** Evidence screenshots for the delivery notes when E2E_SHOTS_DIR is set (never in CI). */
const shot = async (page: import('@playwright/test').Page, name: string) => {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  // Icons come through the server's icon cache on first view; let them arrive before the picture.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500); // drawers and toasts finish their transitions
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};

test('应用目录: browse, add without pinning, then find it in 收藏库', async ({ home, isMobile }, info) => {
  const page = home;
  if (isMobile) await page.goto('/catalog');
  else await page.getByRole('link', { name: '应用目录' }).click();
  await expect(page.getByRole('heading', { name: '应用目录' })).toBeVisible();
  // The seed's GitHub is recognised as already saved; nothing private is offered.
  await expect(page.getByRole('checkbox', { name: '选择 GitHub' })).toBeDisabled();
  await expect(page.getByText(/LiteBox|Linkwarden/)).toHaveCount(0);
  await shot(page, `catalog-${info.project.name}`);

  await page.getByRole('textbox', { name: '搜索应用目录' }).fill('知乎');
  await page.getByRole('button', { name: '添加 知乎' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已把「知乎」加入「未分类」' })).toBeVisible();
  await expect.poll(async () => (await serverConfig(page.request)).apps.some((a) => a.name === '知乎')).toBe(true);
  const cfg = await serverConfig(page.request);
  const zhihu = cfg.apps.find((a) => a.name === '知乎')!;
  expect(cfg.pins).not.toContain(zhihu.id);
  await shot(page, `catalog-added-${info.project.name}`);

  if (!isMobile) {
    await page.getByRole('link', { name: '返回首页' }).click();
    await page.getByRole('button', { name: '快速打开' }).first().click();
    await expect(page.getByRole('dialog', { name: '快速打开' }).getByRole('link', { name: /知乎/ })).toBeVisible();
    await shot(page, `library-drawer-${info.project.name}`);
  }
});

test('应用目录: nothing found leads to 自定义添加 with the address prefilled', async ({ home }) => {
  await home.goto('/catalog?q=docs.example.org/guide');
  await home.getByRole('button', { name: '自定义添加' }).click();
  // A dialog on desktop, a full page on phones: the prefilled fields are what matters.
  await expect(home.getByRole('textbox', { name: /网址/ })).toHaveValue('https://docs.example.org/guide');
  await expect(home.getByRole('textbox', { name: /名称/ })).toHaveValue('docs.example.org');
  await expect(home.getByRole('switch', { name: '固定到首页' })).not.toBeChecked();
});
