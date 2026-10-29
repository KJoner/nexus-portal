import type { APIRequestContext } from '@playwright/test';
import { expect, ops, serverConfig, test } from './fixtures';

async function addApps(api: APIRequestContext) {
  const cfg = (await serverConfig(api)) as unknown as { apps: Record<string, unknown>[] };
  const gh = cfg.apps.find((a) => a.id === 'github')!;
  const make = (id: string, name: string, url: string) => ({ ...gh, id, name, url, aliases: [], icon: { source: 'letter', ref: '', letter: '', tone: 0 } });
  await ops(api, [
    { type: 'app.upsert', app: make('tdocs', '腾讯文档', 'https://docs.qq.com') },
    { type: 'app.upsert', app: make('qqmail', 'QQ邮箱', 'https://mail.qq.com') },
  ]);
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('pinyin initials, full pinyin and gapped letters find apps, with highlights', async ({ home: page }) => {
    await addApps(page.context().request);
    await page.reload();
    const input = page.getByRole('combobox', { name: '搜索' });
    const first = page.getByRole('listbox', { name: '搜索结果' }).getByRole('option').first();
    await input.fill('txwd');
    // pinyin-pro arrives as a lazy chunk while idle; the list updates when it does.
    await expect(first).toContainText('腾讯文档');
    await expect(first.locator('mark')).toHaveText('腾讯文档');
    await input.fill('tengxunwendang');
    await expect(first).toContainText('腾讯文档');
    await input.fill('qqyx');
    await expect(first).toContainText('QQ邮箱');
    await input.fill('lbx');
    await expect(first).toContainText('LiteBox');
    await expect(first.locator('mark')).toHaveText(['L', 'B', 'x']);
    await input.fill('gh');
    await expect(first).toContainText('GitHub');
  });

  test('fuzzy matches never take over a typed address or the Enter key', async ({ home: page }) => {
    await page.route('https://gtihub.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>site</title>' }));
    await page.route('https://www.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>google</title>' }));
    const input = page.getByRole('combobox', { name: '搜索' });
    const results = page.getByRole('listbox', { name: '搜索结果' });
    // A typo of an app name: only a guess, listed after the web search.
    await input.fill('gtihub');
    await expect(results.getByRole('group').first()).toHaveAttribute('aria-label', '网页');
    await expect(results.getByRole('group', { name: '可能是这些应用' })).toContainText('GitHub');
    await input.press('Enter');
    await expect(page).toHaveURL(/google\.com\/search\?q=gtihub/);

    await page.goto('/');
    await page.getByRole('combobox', { name: '搜索' }).fill('gtihub.com');
    await expect(page.getByRole('listbox', { name: '搜索结果' }).getByRole('option').first()).toContainText('前往 gtihub.com');
    await page.getByRole('combobox', { name: '搜索' }).press('Enter');
    await expect(page).toHaveURL('https://gtihub.com/');
  });

  test('aliases are edited in the app editor and found by search', async ({ home: page }) => {
    await page.goto('/settings/apps?edit=github');
    const dialog = page.getByRole('dialog');
    const alias = dialog.getByRole('textbox', { name: '添加别名' });
    await alias.fill('代码托管，dm');
    await alias.press('Enter');
    await expect(dialog.getByRole('button', { name: '删除别名 代码托管' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '删除别名 dm' })).toBeVisible();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect.poll(async () => ((await serverConfig(page.context().request)) as unknown as { apps: { id: string; aliases: string[] }[] }).apps.find((a) => a.id === 'github')!.aliases).toEqual(['代码托管', 'dm']);
    await page.goto('/');
    await page.getByRole('combobox', { name: '搜索' }).fill('dm');
    const first = page.getByRole('listbox', { name: '搜索结果' }).getByRole('option').first();
    await expect(first).toContainText('GitHub');
    await expect(first).toContainText('别名 dm');
  });

  test('no matching app is said out loud, and the drawer filter understands pinyin', async ({ home: page }) => {
    await addApps(page.context().request);
    await page.reload();
    await page.getByRole('combobox', { name: '搜索' }).fill('zzqx');
    await expect(page.getByRole('status').filter({ hasText: '没有匹配的应用或收藏' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '全部应用' }).click();
    await page.getByLabel('筛选应用').fill('tx');
    await expect(page.getByRole('dialog', { name: '全部应用' }).getByRole('link', { name: '腾讯文档' })).toBeVisible();
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile layout');

  test('pinyin search on the phone', async ({ home: page }) => {
    await addApps(page.context().request);
    await page.reload();
    await page.getByRole('searchbox', { name: '搜索' }).tap();
    await page.keyboard.type('txwd');
    await expect(page.getByRole('link', { name: /腾讯文档/ }).first()).toBeVisible();
  });
});
