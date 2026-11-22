import { expect, ops, test } from './fixtures';

test.skip(({ isMobile }) => !isMobile, 'mobile layout');

test('home panel shows pins and services with 44pt targets', async ({ home: page }) => {
  // UI v2: a service is a favorite — pinned, it sits with the other shortcuts and keeps its state.
  await ops(page.context().request, [{ type: 'pin.add', appId: 'litebox' }]);
  await page.reload();
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /LiteBox，未监测/ })).toBeVisible();
  const box = await page.getByRole('button', { name: /服务状态/ }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test('long press opens the action sheet without opening the app', async ({ home: page }) => {
  const gmail = page.getByRole('link', { name: 'Gmail', exact: true });
  const b = (await gmail.boundingBox())!;
  const at = { pointerType: 'touch', isPrimary: true, pointerId: 7, button: 0, buttons: 1, clientX: b.x + b.width / 2, clientY: b.y + 20 };
  await gmail.dispatchEvent('pointerdown', at);
  await page.waitForTimeout(650);
  await gmail.dispatchEvent('pointerup', at);
  await gmail.dispatchEvent('click');
  const sheet = page.getByRole('dialog', { name: 'Gmail' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: '向前移动' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await sheet.getByRole('button', { name: '取消' }).click();
  await expect(sheet).toBeHidden();
});

test('search mode: results above the field, 取消 returns home', async ({ home: page }) => {
  await page.getByRole('searchbox', { name: '搜索' }).tap();
  await page.keyboard.type('git');
  await expect(page.getByRole('link', { name: /GitHub/ }).first()).toBeVisible();
  await page.getByRole('button', { name: '取消' }).tap();
  await expect(page.getByRole('searchbox', { name: '搜索' })).toHaveValue('');
});

test('settings use push navigation with a back label', async ({ home: page }) => {
  await page.goto('/settings');
  // 我的收藏 took the place of 网站与服务 (UI v2).
  await expect(page.getByRole('button', { name: /网站与服务/ })).toHaveCount(0);
  await page.getByRole('button', { name: /我的收藏/ }).first().tap();
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /OBsync/ }).first().tap();
  // The one editor, full screen on a phone, closed with 关闭; nothing to save until something changes.
  const editor = page.getByRole('dialog', { name: '编辑「OBsync」' });
  await expect(editor.getByRole('button', { name: '关闭' })).toBeVisible();
  await expect(editor.getByRole('button', { name: '保存' })).toBeDisabled();
  await editor.getByRole('textbox', { name: '名称' }).fill('OBsync 笔记');
  await expect(editor.getByRole('button', { name: '保存' })).toBeEnabled();
});
