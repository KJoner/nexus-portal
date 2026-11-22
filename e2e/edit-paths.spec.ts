import { expect, serverConfig, test } from './fixtures';

/**
 * U2b（01-UX-PLAN §3.1）：一个字段只在一处修改。网站的网址、标题、分组、标签与备注在收藏库；它在首页上的
 * 图标、搜索别名与打开方式在「设置 › 网站与服务」，那里不再能改网址和标题。首页的「编辑收藏」直接打开
 * 收藏库里的这一条。
 */
test('a site is edited in the collection, its home look in 网站与服务 — one place per field', async ({ home: page, isMobile }) => {
  if (isMobile) await page.goto('/library?edit=github');
  else {
    await page.getByRole('link', { name: 'GitHub' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /编辑收藏/ }).click();
  }
  const dialog = page.getByRole('dialog', { name: '编辑收藏' });
  await expect(dialog.getByRole('textbox', { name: '网址' })).toHaveValue(/github\.com/);
  // The link is used once: reloading the library does not open the dialog again.
  await expect(page).toHaveURL(/\/library$/);
  await dialog.getByRole('textbox', { name: '标题' }).fill('GitHub 代码');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await serverConfig(page.context().request)).apps.find((a) => a.id === 'github')?.name).toBe('GitHub 代码');

  // The home look is one step away; there the address and title are shown, not edited.
  await page.goto('/library?edit=github');
  await page.getByRole('dialog', { name: '编辑收藏' }).getByRole('link', { name: '编辑首页显示' }).click();
  await expect(page).toHaveURL(/\/settings\/apps\?edit=github$/);
  await expect(page.getByText('网址、标题与分组在收藏库修改')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /名称/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '添加别名' })).toBeVisible();
});

test('the collection search ignores case, like the home search', async ({ home: page }) => {
  await page.goto('/library');
  await page.getByRole('textbox', { name: '搜索收藏库' }).fill('GitHub');
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(1);
  await expect(page.getByText('收藏库里没有「GitHub」')).toHaveCount(0);
});
