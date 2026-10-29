import { expect, ops, serverConfig, signIn, test } from './fixtures';

test.skip(({ isMobile }) => isMobile, 'desktop layout');

const dock = (id: string) => `[data-dock="${id}"]`;

test('login gate: nothing private before sign-in, session survives reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('输入访问密码以继续')).toBeVisible();
  await expect(page.locator('[data-dock]')).toHaveCount(0);
  const pw = page.getByLabel('访问密码');
  await pw.fill('wrong-password');
  await pw.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('密码不正确');
  await pw.fill('e2e-password');
  await pw.press('Enter');
  await expect(page.getByRole('combobox', { name: '搜索' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: '搜索' })).toBeVisible();
});

test('search keyboard model (R1.5 · 01)', async ({ home: page }) => {
  const input = page.getByRole('combobox', { name: '搜索' });
  await page.keyboard.press('/');
  await expect(input).toBeFocused();
  await page.keyboard.type('lin');
  const results = page.getByRole('listbox', { name: '搜索结果' });
  await expect(results.getByRole('option').first()).toContainText('Linkwarden');
  await expect(input).toHaveAttribute('aria-activedescendant', 'nx-opt-0');
  await page.keyboard.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'nx-opt-1');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByRole('button', { name: /搜索引擎：Bing/ })).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator(dock('github'))).toBeFocused();
});

test('drawer: filter, 2-D arrows, Esc clears then closes and returns focus', async ({ home: page }) => {
  const all = page.getByRole('button', { name: '全部应用' });
  await all.click();
  const filter = page.getByLabel('筛选应用');
  await expect(filter).toBeFocused();
  await filter.fill('g');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '全部应用' })).toBeHidden();
  await expect(all).toBeFocused();
});

test('context menu remove → undo restores the position', async ({ home: page }) => {
  await page.locator(dock('youtube')).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '从首页移除' }).click();
  await expect(page.locator(dock('youtube'))).toHaveCount(0);
  await page.getByRole('button', { name: '撤销' }).click();
  await expect(page.locator('[data-dock]').nth(2)).toHaveAttribute('data-dock', 'youtube');
  await expect.poll(async () => (await serverConfig(page.context().request)).pins[2]).toBe('youtube');
});

test('a change on one device reaches another within seconds', async ({ home: page, browser }) => {
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await signIn(other);
  const b = await other.newPage();
  await b.goto('/');
  await expect(b.locator(dock('notion'))).toBeVisible();
  await page.locator(dock('notion')).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '从首页移除' }).click();
  await expect(b.locator(dock('notion'))).toHaveCount(0, { timeout: 5000 });
  await other.close();
});

test('offline edits are kept and sent when the connection returns', async ({ home: page, context }) => {
  await expect(page.locator(dock('gmail'))).toBeVisible();
  await context.setOffline(true);
  await page.locator(dock('gmail')).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '从首页移除' }).click();
  await expect(page.getByRole('button', { name: /服务状态：Nexus 服务端离线/ })).toBeVisible();
  await context.setOffline(false);
  await expect.poll(async () => (await serverConfig(context.request)).pins, { timeout: 10_000 }).not.toContain('gmail');
});

test('settings: adding an app is validated, saved and survives reload', async ({ home: page }) => {
  await page.goto('/settings/apps?new=Jellyfin');
  const dialog = page.getByRole('dialog', { name: '新增应用' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '添加' }).click();
  await expect(dialog.getByText('还有 1 项需要修正')).toBeVisible();
  const url = dialog.getByRole('textbox', { name: /网址/ });
  await url.fill('jellyfin.home');
  await url.blur();
  await expect(url).toHaveValue('https://jellyfin.home');
  await dialog.getByRole('button', { name: '添加' }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByText('jellyfin.home').first()).toBeVisible();
});

test('appearance is previewed first and applied explicitly', async ({ home: page }) => {
  await page.goto('/settings/appearance');
  await page.getByRole('button', { name: '暖炭' }).click();
  await expect(page.getByRole('region', { name: '未应用的外观更改' })).toBeVisible();
  expect((await serverConfig(page.context().request) as unknown as { settings: { look: { wallpaper: string } } }).settings.look.wallpaper).toBe('fallingwater');
  await page.getByRole('button', { name: '应用到首页' }).click();
  await expect.poll(async () => (await serverConfig(page.context().request) as unknown as { settings: { look: { wallpaper: string } } }).settings.look.wallpaper).toBe('ember');
});

test('reduced motion is honoured', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  await signIn(ctx);
  const p = await ctx.newPage();
  await p.goto('/');
  await expect(p.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await ctx.close();
});

test('health status comes from the server, not the browser', async ({ home: page }) => {
  // Loopback is refused by the checker, so enabling a check against it yields a real failure.
  const cfg = await serverConfig(page.context().request);
  const lb = (cfg.apps as unknown as Record<string, unknown>[]).find((a) => a.id === 'litebox')!;
  await ops(page.context().request, [{ type: 'app.upsert', app: { ...lb, url: 'http://127.0.0.1:9', health: { enabled: true, target: '/', intervalSec: 30 } } }]);
  await page.request.post('/api/status/litebox/check', { headers: { 'X-Nexus-Client': '1' } });
  await expect(page.getByRole('button', { name: /服务状态：LiteBox 状态未知/ })).toBeVisible();
  await page.getByRole('button', { name: /服务状态/ }).click();
  await expect(page.locator('#nx-status')).toContainText('目标地址不允许检查');
});
