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

/** 添加收藏 › 应用商店 (UI v2): pick one site, one primary action. */
async function addFromCatalog(page: Page, name: string) {
  await page.goto(`/settings/favorites?add=store&sq=${encodeURIComponent(name)}`);
  const dialog = page.getByRole('dialog', { name: '添加收藏' });
  await dialog.getByRole('button', { name: `选择 ${name}` }).click();
  await dialog.getByRole('button', { name: '添加 1 个网站' }).click();
  await expect(page.getByRole('status').filter({ hasText: `已添加「${name}」` })).toBeVisible();
}

/** Finds a saved item in 我的收藏 the way a person would with many: its search box. */
async function findInLibrary(page: Page, text: string) {
  if (new URL(page.url()).pathname !== '/settings/favorites') await page.goto('/settings/favorites');
  await page.getByRole('searchbox', { name: '搜索我的收藏' }).fill(text);
  return page.getByRole('listbox', { name: /（\d+ 条）$/ }).getByText(text);
}

async function addPage(page: Page, title: string, url: string) {
  await page.goto('/settings/favorites');
  await page.getByRole('button', { name: '添加收藏' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加收藏' });
  await dialog.getByRole('textbox', { name: /网址/ }).fill(url);
  await dialog.getByRole('textbox', { name: /名称/ }).fill(title);
  await dialog.getByRole('button', { name: '添加这个收藏' }).click();
  await expect(dialog).toBeHidden();
}

/** The top bar's pill on the home page: 仅此设备 for this browser's own collection. */
async function expectLocalPill(page: Page) {
  // Changing spaces is a fresh load of the home page by the app itself: let it land, never race it.
  await page.waitForURL((u) => u.pathname === '/', { timeout: 10_000 });
  await expect(page.getByRole('link', { name: /^保存状态：仅此设备/ })).toBeVisible();
}

test('L01/L03/L05/L06: first visit is a usable home; saves stay in this browser, with no private request', async ({ page }) => {
  const priv = watchPrivate(page);
  await page.goto('/');
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
  // Where the collection is, and that signing in is what syncs it — in the pill, without any account name.
  await expect(page.getByRole('link', { name: /^保存状态：仅此设备/ })).toHaveAttribute('aria-label', /登录后可以同步/);
  // The public template (UI v2 N3): the eight 常用网站 pinned, in order; no private service.
  await expect(page.locator('[data-dock]')).toHaveCount(8);
  expect(await page.locator('[data-dock]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dock')))).toEqual(['google', 'youtube', 'github', 'gmail', 'bing', 'bilibili', 'chatgpt', 'wikipedia']);
  await shot(page, 'local-1-first-visit');

  await addFromCatalog(page, '知乎');
  await expect(page.getByText(/LiteBox|Linkwarden/)).toHaveCount(0);
  await addPage(page, '一篇以后读的长文', 'https://read.example.org/long-read?id=7');
  await expect(await findInLibrary(page, '一篇以后读的长文')).toBeVisible();
  await shot(page, 'local-2-library');

  // Reload, and a new tab of the same browser: still there.
  await page.reload();
  await expect(page.getByRole('listbox', { name: /（\d+ 条）$/ }).getByText('一篇以后读的长文')).toBeVisible();
  const again = await page.context().newPage();
  // (The old 收藏库 link lands on 我的收藏.)
  await again.goto('/library');
  await expect(again).toHaveURL(/\/settings\/favorites$/);
  await expect(again.getByRole('listbox', { name: /（\d+ 条）$/ }).getByText('知乎')).toBeVisible();
  await expect(again.getByText('一篇以后读的长文')).toBeVisible();
  expect(priv).toEqual([]);
});

test('N1 (UI v2): 常用网站 · 整理 above the shortcuts; the first row fills the row before anything goes under it; no favorites buttons under the slab', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the desktop home page');
  /** Its centre is on screen and nothing covers it (Playwright would scroll a clipped element into view). */
  const onTop = (name: string) =>
    page.getByRole('button', { name, exact: true }).evaluate((el) => {
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return b.bottom <= innerHeight && !!hit && el.contains(hit);
    });
  const first = page.locator('[data-dock-row="first"] [data-dock]');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  const shortcuts = page.getByRole('region', { name: '常用网站' });
  await expect(shortcuts).toBeVisible();
  // The eight starter sites all fit the first row of a 760 px panel: nothing is left for a second one.
  await expect(shortcuts.locator('[data-dock]')).toHaveCount(8);
  await expect(first).toHaveCount(8);
  await expect(page.getByRole('group', { name: /更多快捷方式/ })).toHaveCount(0);
  // 我的收藏 is in the top bar and behind 整理; the home page has no 打开我的收藏 / 添加收藏 of its own.
  for (const name of ['打开我的收藏', '添加收藏']) await expect(page.getByRole('button', { name, exact: true }), name).toHaveCount(0);
  await expect(page.getByText('固定到首页的收藏会出现在这里')).toHaveCount(0);
  expect(await onTop('整理首页快捷方式')).toBe(true);
  await shot(page, 'local-n1-home-frame');

  // A laptop height keeps the heading.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(first).toHaveCount(8);
  expect(await onTop('整理首页快捷方式'), '整理 at 1280×720').toBe(true);

  // The narrowest desktop window still has the default 760 px panel: all eight in one row.
  // (Rows under a full first row, column for column: shortcuts.spec.)
  await page.setViewportSize({ width: 900, height: 720 });
  await expect(first).toHaveCount(8);
  await expect(page.getByRole('group', { name: /更多快捷方式/ })).toHaveCount(0);

  // 整理 opens 我的收藏 on 首页快捷方式.
  await page.getByRole('button', { name: '整理首页快捷方式' }).click();
  await expect(page).toHaveURL(/\/settings\/favorites\?view=pinned$/);
});

test('L08: a saved page that is not on the home page is found by the home search and by 快速打开', async ({ page }) => {
  await addPage(page, '没有固定的参考文档', 'https://docs.example.org/reference/unpinned');
  await page.goto('/');
  // Only the eight starter sites are pinned; the page saved without pinning is not on the home page.
  await expect(page.locator('[data-dock]')).toHaveCount(8);
  await expect(page.locator('[data-dock]').filter({ hasText: '没有固定的参考文档' })).toHaveCount(0);
  const search = page.getByRole('combobox', { name: '搜索' });
  await search.fill('参考文档');
  await expect(page.getByRole('listbox', { name: '搜索结果' }).getByRole('option').filter({ hasText: '没有固定的参考文档' })).toBeVisible();
  await shot(page, 'u2-search-unpinned');
  await search.fill('');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '快速打开' }).first().click();
  const panel = page.getByRole('dialog', { name: '快速打开' });
  await page.getByLabel('筛选收藏').fill('参考');
  await expect(panel.getByRole('link', { name: /没有固定的参考文档/ })).toBeVisible();
  await shot(page, 'u2-quick-open');
});

test('L10: signing in cancelled — back where the person was, the collection untouched', async ({ page }) => {
  await addPage(page, '取消前保存的', 'https://kept.example.org/');
  await page.goto('/');
  // The pill leads to 账号与同步, where 登录同步 is.
  await page.getByRole('link', { name: /^保存状态：仅此设备/ }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.getByRole('button', { name: '登录同步' }).click();
  await expect(page.getByRole('heading', { name: '登录以跨设备同步' })).toBeVisible();
  await shot(page, 'local-3-connect');
  await page.getByRole('button', { name: '继续仅在此浏览器使用' }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(await findInLibrary(page, '取消前保存的')).toBeVisible();
  // The identity service sending back a cancelled sign-in: a notice, the local home.
  await page.goto('/?auth_error=access_denied');
  await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
  // Back on 登录同步 without a session (U2b): the account center's reason is kept, not replaced by a generic one.
  await page.goto('/account/connect?return=1&auth_error=invite_invalid');
  await expect(page.locator('#connect-error')).toHaveText('邀请码无效、已过期或已经用过。此浏览器的收藏没有任何改动，可以再试一次。');
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
  await expect(page.getByRole('link', { name: /^保存状态：已同步/ })).toBeVisible({ timeout: 10_000 });
  await expect(await findInLibrary(page, '合并测试：本地网页')).toBeVisible();
  expect(imports).toEqual(['preview', 'apply']);
  await shot(page, 'local-6-account-after-merge');

  // The local collection is still here, apart from the account's.
  await page.goto('/settings/account');
  await page.getByRole('button', { name: '切回本地收藏' }).click();
  await expectLocalPill(page);
  await expect(await findInLibrary(page, '合并测试：本地网页')).toBeVisible();
});

test('L11: 「暂时继续本地使用」 keeps the collection local and sends nothing', async ({ page }) => {
  await addPage(page, '只留在本地', `https://local-only.example.org/${Date.now()}`);
  const priv = watchPrivate(page);
  await page.goto('/account/connect');
  await page.getByLabel('访问密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: /暂时继续本地使用/ }).click();
  await expectLocalPill(page);
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
  await expect(page.getByRole('link', { name: /^保存状态：已同步/ })).toBeVisible({ timeout: 10_000 });
  await expect(await findInLibrary(page, '退出后仍在的本地收藏')).toHaveCount(0);

  await page.goto('/settings/account');
  await page.getByRole('button', { name: '退出', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '退出', exact: true }).click();
  await expectLocalPill(page);
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
