import type { Page, Request } from '@playwright/test';
import { join } from 'node:path';
import { expect, PASSWORD, test } from './fixtures';

/**
 * 本地收藏 (v0.5 · UI 焕新 U1, 06-ACCEPTANCE §A): a browser with no account uses Nexus right away;
 * signing in is the person's choice, and what happens to this browser's collection is decided after
 * it — previewed, never uploaded by itself. Each test starts in a fresh browser context (no cookie,
 * no storage). The Service Worker is off so every request is visible here.
 */
test.use({ serviceWorkers: 'block' });
test.skip(({ isMobile }) => isMobile, 'desktop flows; the phone layout is covered by the screenshots');

const shot = async (page: Page, name: string) => {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(dir, `${name}.png`) });
};

/** Requests that only an account may make: none of them in a local collection. */
const PRIVATE = /^\/api\/(config|status|events|v2\/(me|snapshot|changes|items|pins|import|export|account|devices))/;

function watchPrivate(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r: Request) => {
    const path = new URL(r.url()).pathname;
    if (PRIVATE.test(path)) seen.push(`${r.method()} ${path}`);
  });
  return seen;
}

async function addFromCatalog(page: Page, name: string) {
  await page.goto('/catalog');
  await page.getByRole('textbox', { name: '搜索应用目录' }).fill(name);
  await page.getByRole('button', { name: `添加 ${name}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `已把「${name}」加入` })).toBeVisible();
}

/** Finds a saved item in 收藏库 the way a person would with many: its search box. */
async function findInLibrary(page: Page, text: string) {
  if (!page.url().endsWith('/library')) await page.goto('/library');
  await page.getByRole('textbox', { name: '搜索收藏库' }).fill(text);
  return page.getByRole('listbox').getByText(text);
}

async function addPage(page: Page, title: string, url: string) {
  await page.goto('/library');
  await page.getByRole('button', { name: '新增' }).first().click();
  await page.getByLabel('网址').fill(url);
  await page.getByLabel('标题').fill(title);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('L01/L03/L05/L06: first visit is a usable home; saves stay in this browser, with no private request', async ({ page }) => {
  const priv = watchPrivate(page);
  await page.goto('/');
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
  await expect(page.getByText('仅保存在此浏览器')).toBeVisible();
  await expect(page.getByRole('link', { name: /登录同步/ })).toBeVisible();
  // The public template: nothing pinned, no private service.
  await expect(page.locator('[data-dock]')).toHaveCount(0);
  await shot(page, 'local-1-first-visit');

  await addFromCatalog(page, '知乎');
  await expect(page.getByText(/LiteBox|Linkwarden/)).toHaveCount(0);
  await addPage(page, '一篇以后读的长文', 'https://read.example.org/long-read?id=7');
  await expect(await findInLibrary(page, '一篇以后读的长文')).toBeVisible();
  await shot(page, 'local-2-library');

  // Reload, and a new tab of the same browser: still there.
  await page.reload();
  await expect(page.getByText('一篇以后读的长文')).toBeVisible();
  const again = await page.context().newPage();
  await again.goto('/library');
  await expect(again.getByText('知乎')).toBeVisible();
  await expect(again.getByText('一篇以后读的长文')).toBeVisible();
  expect(priv).toEqual([]);
});

test('L10: signing in cancelled — back where the person was, the collection untouched', async ({ page }) => {
  await addPage(page, '取消前保存的', 'https://kept.example.org/');
  await page.goto('/');
  await page.getByRole('link', { name: /登录同步/ }).click();
  await expect(page.getByRole('heading', { name: '登录以跨设备同步' })).toBeVisible();
  await shot(page, 'local-3-connect');
  await page.getByRole('button', { name: '继续仅在此浏览器使用' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/library');
  await expect(page.getByText('取消前保存的')).toBeVisible();
  // The identity service sending back a cancelled sign-in: a notice, the local home.
  await page.goto('/?auth_error=access_denied');
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
});

test('L11/L12: after signing in, nothing is uploaded until a previewed merge is confirmed; the local collection stays', async ({ page }) => {
  await addFromCatalog(page, '知乎');
  await addPage(page, '合并测试：本地网页', `https://merge.example.org/${Date.now()}`);
  const imports: string[] = [];
  page.on('request', (r) => r.url().includes('/api/v2/import/collection') && imports.push(JSON.parse(r.postData() ?? '{}').dryRun ? 'preview' : 'apply'));

  await page.goto('/account/connect');
  await page.getByLabel('访问密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '如何使用这台浏览器里的收藏？' })).toBeVisible();
  await shot(page, 'local-4-choose');
  expect(imports).toEqual([]);

  await page.getByRole('button', { name: /合并到我的账号/ }).click();
  await expect(page.getByRole('heading', { name: /合并到「/ })).toBeVisible();
  await expect(page.getByText(/新增 \d+ 条收藏/)).toBeVisible();
  await shot(page, 'local-5-merge-preview');
  expect(imports).toEqual(['preview']);

  await page.getByRole('button', { name: '确认合并' }).click();
  // The account's collection now, with the merged page in it.
  await expect(page.getByText('已同步')).toBeVisible({ timeout: 10_000 });
  await expect(await findInLibrary(page, '合并测试：本地网页')).toBeVisible();
  expect(imports).toEqual(['preview', 'apply']);
  await shot(page, 'local-6-account-after-merge');

  // The local collection is still here, apart from the account's.
  await page.goto('/settings/account');
  await page.getByRole('button', { name: '切回本地收藏' }).click();
  await expect(page.getByText('仅保存在此浏览器')).toBeVisible();
  await expect(await findInLibrary(page, '合并测试：本地网页')).toBeVisible();
});

test('L11: 「暂时继续本地使用」 keeps the collection local and sends nothing', async ({ page }) => {
  await addPage(page, '只留在本地', `https://local-only.example.org/${Date.now()}`);
  const priv = watchPrivate(page);
  await page.goto('/account/connect');
  await page.getByLabel('访问密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: /暂时继续本地使用/ }).click();
  await expect(page.getByText('仅保存在此浏览器')).toBeVisible();
  // Only the identity question (/api/v2/me) went out — no collection request of any kind.
  expect(priv.filter((x) => !x.endsWith('/api/v2/me'))).toEqual([]);
  const r = await page.context().request.get('/api/v2/items?q=只留在本地', { headers: { 'X-Nexus-Client': '1' } });
  expect((await r.json()).items).toEqual([]);
});

test('L14/L16: signing out of the account comes back to this browser’s own collection, unchanged', async ({ page }) => {
  await addPage(page, '退出后仍在的本地收藏', `https://after-logout.example.org/${Date.now()}`);
  await page.goto('/account/connect');
  await page.getByLabel('访问密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: /使用账号里的收藏/ }).click();
  await expect(page.getByText('已同步')).toBeVisible({ timeout: 10_000 });
  await expect(await findInLibrary(page, '退出后仍在的本地收藏')).toHaveCount(0);

  await page.goto('/settings/account');
  await page.getByRole('button', { name: '退出', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByText('仅保存在此浏览器')).toBeVisible();
  await expect(await findInLibrary(page, '退出后仍在的本地收藏')).toBeVisible();
});

test('L18: a browser that refuses to store says so; nothing is reported as saved', async ({ page }) => {
  await page.addInitScript(() => {
    // As some private windows do.
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new DOMException('denied', 'InvalidStateError'); } } });
  });
  await page.goto('/');
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /没有保存/ })).toBeVisible();
  await shot(page, 'local-7-storage-refused');
  await page.goto('/settings/data');
  await expect(page.getByText('没有保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出备份' })).toBeVisible();
});
