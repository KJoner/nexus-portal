import type { APIRequestContext } from '@playwright/test';
import { expect, ops, serverConfig, signIn, test } from './fixtures';

type App = Record<string, unknown> & { id: string; name: string; categoryId: string };
const dock = (id: string) => `[data-dock="${id}"]`;

/** Adds `n` letter-icon sites (no network needed) and pins them after the existing pins. */
async function addPinnedSites(api: APIRequestContext, n: number) {
  const cfg = (await serverConfig(api)) as unknown as { apps: App[] };
  const gh = cfg.apps.find((a) => a.id === 'github')!;
  const sites = Array.from({ length: n }, (_, i) => ({ ...gh, id: `site-${i}`, name: `站点 ${i}`, url: `https://s${i}.example.com`, icon: { source: 'letter', ref: '', letter: 'S', tone: 0 } }));
  await ops(api, sites.map((app) => ({ type: 'app.upsert', app })));
  await ops(api, sites.map((s) => ({ type: 'pin.add', appId: s.id })));
  return (await serverConfig(api)).pins;
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('more than 12 pins: the first row stays, the rest page through the extension', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 20);
    expect(pins).toHaveLength(25);
    await page.reload();
    const first = page.locator('[data-dock-row="first"] [data-dock]');
    await expect(first).toHaveCount(5);
    const firstIds = await first.evaluateAll((els) => els.map((e) => e.getAttribute('data-dock')));
    expect(firstIds).toEqual(pins.slice(0, 5));

    const toggle = page.getByRole('button', { name: '展开更多快捷方式（另有 20 个）' });
    await toggle.click();
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    await expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 1 / 2 页');
    await expect(ext.locator(dock(pins[5]!))).toBeVisible();
    await ext.getByRole('button', { name: '下一页' }).click();
    await expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 2 / 2 页');
    const last = ext.locator(dock(pins[24]!));
    await expect(last).toBeVisible();
    await expect(last).toHaveAttribute('href', 'https://s19.example.com');

    // The wheel turns pages only over the extension, one page per gesture.
    await ext.hover();
    await page.mouse.wheel(0, -120);
    await expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 1 / 2 页');

    // Collapsing and expanding keeps both the first row and the order.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /展开更多快捷方式/ })).toHaveAttribute('aria-expanded', 'false');
    expect(await first.evaluateAll((els) => els.map((e) => e.getAttribute('data-dock')))).toEqual(pins.slice(0, 5));
    expect((await serverConfig(page.context().request)).pins).toEqual(pins);
  });

  test('the open extension never moves the clock or the search field', async ({ home: page }) => {
    await addPinnedSites(page.context().request, 20);
    await page.reload();
    const search = page.getByRole('combobox', { name: '搜索' });
    const before = await search.boundingBox();
    await page.getByRole('button', { name: /展开更多快捷方式/ }).click();
    await expect(page.getByRole('group', { name: /更多快捷方式/ })).toBeVisible();
    expect(await search.boundingBox()).toEqual(before);
    // A short window keeps the open slab inside the viewport (fewer rows per page).
    await page.setViewportSize({ width: 1280, height: 600 });
    const slab = page.locator('.group\\/slab');
    await expect.poll(async () => (await slab.boundingBox())!.y + (await slab.boundingBox())!.height).toBeLessThan(600 - 40);
  });

  test('edit mode: Alt+→ moves a pin from the first row into the extension', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 3);
    await page.reload();
    await page.locator(dock('notion')).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '编辑首页…' }).click();
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    await expect(ext).toBeVisible();
    await page.locator(dock('notion')).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(async () => (await serverConfig(page.context().request)).pins.indexOf('notion')).toBe(5);
    await expect(ext.locator(dock('notion'))).toBeFocused();
    await expect(page.locator('[data-dock-row="first"] [data-dock]').nth(4)).toHaveAttribute('data-dock', pins[5]!);
  });

  test('context menu offers new tab and moving to the ends', async ({ home: page }) => {
    await page.locator(dock('youtube')).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /在新标签页打开/ })).toBeVisible();
    await page.getByRole('menuitem', { name: '移到最前' }).click();
    await expect.poll(async () => (await serverConfig(page.context().request)).pins[0]).toBe('youtube');
    await expect(page.locator('[data-dock]').first()).toHaveAttribute('data-dock', 'youtube');
  });

  test('sort mode: drag inside a category, move across categories, sync and reload', async ({ home: page, browser }) => {
    // A second device watches the drawer while this one sorts.
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await signIn(other);
    const b = await other.newPage();
    await b.goto('/');
    await b.getByRole('button', { name: '全部应用' }).click();
    const devGrid = b.getByRole('dialog', { name: '全部应用' }).locator('section', { hasText: '开发' });
    await expect(devGrid.getByRole('link')).toHaveText(['GitHub', 'Vercel', 'Cloudflare']);

    await page.goto('/settings/apps');
    await page.getByRole('button', { name: '排序' }).click();
    const work = page.getByRole('region', { name: '工作' });
    await expect(work).toBeVisible();

    // Mouse drag by the handle: Cloudflare above GitHub.
    const handle = page.getByRole('button', { name: '拖动排序 Cloudflare' });
    const target = page.locator('[data-sort-app="github"]');
    const h = (await handle.boundingBox())!;
    const t = (await target.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, h.y - 20, { steps: 4 });
    await page.mouse.move(t.x + 40, t.y + 8, { steps: 12 });
    await page.mouse.up();
    const inCat = async (id: string) => ((await serverConfig(page.context().request)) as unknown as { apps: App[] }).apps.filter((a) => a.categoryId === id).map((a) => a.id);
    await expect.poll(() => inCat('dev')).toEqual(['cloudflare', 'github', 'vercel']);
    await expect(page.getByText('已移动「Cloudflare」')).toBeVisible();

    // No drag needed: the ⋯ menu moves Figma into 开发.
    await page.getByRole('button', { name: 'Figma 的移动选项' }).click();
    // The submenu by keyboard: → opens it, Enter picks.
    await page.getByRole('menuitem', { name: '移到分类' }).press('ArrowRight');
    await page.getByRole('menuitem', { name: '移到「开发」' }).press('Enter');
    await expect.poll(() => inCat('dev')).toEqual(['cloudflare', 'github', 'vercel', 'figma']);

    // The other device follows without reloading; this one keeps the order after a reload.
    await expect(devGrid.getByRole('link')).toHaveText(['Cloudflare', 'GitHub', 'Vercel', 'Figma'], { timeout: 5000 });
    await page.reload();
    await page.getByRole('button', { name: '排序' }).click();
    await expect(page.getByRole('region', { name: '开发' }).locator('[data-sort-app]')).toHaveCount(4);
    await other.close();
  });

  test('sort mode: the menu reorders categories, undo restores', async ({ home: page }) => {
    await page.goto('/settings/apps');
    await page.getByRole('button', { name: '排序' }).click();
    await page.getByRole('button', { name: '分类「影音与社区」的移动选项' }).click();
    await page.getByRole('menuitem', { name: '移到最前' }).click();
    const cats = async () => ((await serverConfig(page.context().request)) as unknown as { categories: { id: string }[] }).categories.map((k) => k.id);
    await expect.poll(cats).toEqual(['media', 'hosted', 'dev', 'work', 'none']);
    await page.getByRole('button', { name: '撤销' }).click();
    await expect.poll(cats).toEqual(['hosted', 'dev', 'work', 'media', 'none']);
  });

  test('a v0.1 export imports unchanged: 12 pins, defaults for the new settings', async ({ home: page }) => {
    const api = page.context().request;
    const cfg = (await serverConfig(api)) as unknown as { pins: string[]; apps: App[]; settings: { home: Record<string, unknown> } };
    const legacy = structuredClone(cfg);
    delete legacy.settings.home.shortcuts;
    legacy.pins = ['github', 'gmail', 'youtube', 'bilibili', 'notion', 'vercel', 'cloudflare', 'figma', 'gdrive', 'gcal', 'chatgpt', 'claude'];
    legacy.apps = [...legacy.apps].reverse();
    await ops(api, [{ type: 'config.replace', config: legacy }]);
    const after = (await serverConfig(api)) as unknown as typeof cfg;
    expect(after.pins).toEqual(legacy.pins);
    expect(after.settings.home.shortcuts).toEqual({ mode: 'expand', pageRows: 2, pager: true, remember: false });
    await page.reload();
    await expect(page.getByRole('button', { name: '展开更多快捷方式（另有 7 个）' })).toBeVisible();
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile layout');

  test('extra pins sit on swipeable pages and the sheet pulls up to show them all', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 10);
    await page.reload();
    const strip = page.getByRole('group', { name: /快捷方式，第/ });
    await expect(strip).toHaveAttribute('aria-label', '快捷方式，第 1 / 3 页');
    await strip.evaluate((el) => el.scrollTo({ left: el.clientWidth }));
    await expect(strip).toHaveAttribute('aria-label', '快捷方式，第 2 / 3 页');
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.getByRole('link', { name: '站点 0', exact: true })).toBeInViewport();

    await page.getByRole('button', { name: '展开更多快捷方式' }).tap();
    const all = page.getByRole('group', { name: '全部快捷方式' });
    await expect(all).toBeVisible();
    // Every pin plus the three services, in the shared order.
    await expect(all.getByRole('link')).toHaveCount(pins.length + 3);
    await expect(page.getByRole('button', { name: '收起快捷方式' })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '收起快捷方式' }).tap();
    await expect(all).toBeHidden();
  });

  test('long press on a later page opens the sheet with move options', async ({ home: page }) => {
    await addPinnedSites(page.context().request, 10);
    await page.reload();
    const strip = page.getByRole('group', { name: /快捷方式，第/ });
    await strip.evaluate((el) => el.scrollTo({ left: el.clientWidth }));
    const tile = page.getByRole('link', { name: '站点 2', exact: true });
    const b = (await tile.boundingBox())!;
    const at = { pointerType: 'touch', isPrimary: true, pointerId: 9, button: 0, buttons: 1, clientX: b.x + b.width / 2, clientY: b.y + 20 };
    await tile.dispatchEvent('pointerdown', at);
    await page.waitForTimeout(650);
    await tile.dispatchEvent('pointerup', at);
    await tile.dispatchEvent('click');
    const sheet = page.getByRole('dialog', { name: '站点 2' });
    await expect(sheet.getByRole('button', { name: '移到最前' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    await sheet.getByRole('button', { name: '移到最前' }).tap();
    await expect.poll(async () => (await serverConfig(page.context().request)).pins[0]).toBe('site-2');
  });

  test('sort mode on a phone offers the non-drag menu', async ({ home: page }) => {
    await page.goto('/settings/apps');
    await page.getByRole('button', { name: '调整顺序' }).tap();
    await page.getByRole('button', { name: 'Telegram 的移动选项' }).tap();
    await page.getByRole('dialog', { name: 'Telegram' }).getByRole('button', { name: '移到最前' }).tap();
    const media = async () => ((await serverConfig(page.context().request)) as unknown as { apps: App[] }).apps.filter((a) => a.categoryId === 'media').map((a) => a.id);
    await expect.poll(media).toEqual(['telegram', 'youtube', 'bilibili', 'spotify', 'reddit', 'x']);
  });
});
