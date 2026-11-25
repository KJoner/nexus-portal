import type { APIRequestContext, Page } from '@playwright/test';
import { expect, freshTag, ops, serverConfig, signIn, test } from './fixtures';

type App = Record<string, unknown> & { id: string; name: string; categoryId: string };
const dock = (id: string) => `[data-dock="${id}"]`;

/** Adds `n` letter-icon sites (no network needed) and pins them after the existing pins. */
async function addPinnedSites(api: APIRequestContext, n: number) {
  const cfg = (await serverConfig(api)) as unknown as { apps: App[] };
  const gh = cfg.apps.find((a) => a.id === 'github')!;
  const tag = freshTag();
  const sites = Array.from({ length: n }, (_, i) => ({ ...gh, id: `site-${tag}-${i}`, name: `站点 ${i}`, url: `https://s${i}.example.com`, icon: { source: 'letter', ref: '', letter: 'S', tone: 0 } }));
  await ops(api, sites.map((app) => ({ type: 'app.upsert', app })));
  await ops(api, sites.map((s) => ({ type: 'pin.add', appId: s.id })));
  return (await serverConfig(api)).pins;
}

/**
 * Collects Chrome's aria-hidden complaints. It only makes them while the accessibility tree is
 * alive, as it is with a screen reader or DevTools open, so a plain run would never see one.
 */
async function blockedAria(page: Page) {
  const seen: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Blocked aria-hidden')) seen.push(m.text());
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  await cdp.send('Accessibility.getFullAXTree');
  return seen;
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('more pins than fit: the first row is full, the rest page through the extension, column for column', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 28);
    expect(pins).toHaveLength(33);
    await page.reload();
    // A 760 px panel with 56 px icons has nine columns: eight pins and 快速打开 in the first row.
    const first = page.locator('[data-dock-row="first"] [data-dock]');
    await expect(first).toHaveCount(8);
    const firstIds = await first.evaluateAll((els) => els.map((e) => e.getAttribute('data-dock')));
    expect(firstIds).toEqual(pins.slice(0, 8));

    const toggle = page.getByRole('button', { name: '展开更多快捷方式（另有 25 个）' });
    await toggle.click();
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    await expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 1 / 2 页');
    await expect(ext.locator(dock(pins[8]!))).toBeVisible();
    // One grid: the rows under the first are as wide as it, each tile on the column above it (the
    // ninth column under 快速打开).
    const left = async (sel: string) => Math.round((await page.locator(sel).boundingBox())!.x);
    expect(await left(dock(pins[8]!))).toBe(await left(dock(pins[0]!)));
    expect(await left(dock(pins[15]!))).toBe(await left(dock(pins[7]!)));
    const allX = Math.round((await page.locator('[data-dock-row="first"]').getByRole('button', { name: '快速打开' }).boundingBox())!.x);
    expect(await left(dock(pins[16]!))).toBe(allX);
    await ext.getByRole('button', { name: '下一页' }).click();
    await expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 2 / 2 页');
    const last = ext.locator(dock(pins[32]!));
    await expect(last).toBeVisible();
    await expect(last).toHaveAttribute('href', 'https://s27.example.com');

    // The wheel turns pages only over the extension, one page per gesture.
    await ext.hover();
    await page.mouse.wheel(0, -120);
    await expect(ext).toHaveAttribute('aria-label', '更多快捷方式，第 1 / 2 页');

    // Collapsing and expanding keeps both the first row and the order.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /展开更多快捷方式/ })).toHaveAttribute('aria-expanded', 'false');
    expect(await first.evaluateAll((els) => els.map((e) => e.getAttribute('data-dock')))).toEqual(pins.slice(0, 8));
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

  test('the mouse opens the extension for a moment; the button keeps it open', async ({ home: page }) => {
    await addPinnedSites(page.context().request, 20);
    await page.reload();
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    const handle = page.getByRole('button', { name: /更多快捷方式/ });
    const center = async (l: typeof ext) => {
      const b = (await l.boundingBox())!;
      return [b.x + b.width / 2, b.y + b.height / 2] as const;
    };
    const firstRow = await center(page.locator('[data-dock-row="first"]'));
    const away = [60, 600] as const;

    // Hovering the first row opens it, leaving folds it back.
    await page.mouse.move(...firstRow);
    await expect(ext).toBeVisible();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.move(...away);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(ext).toBeHidden();

    // First row → second row → button and back: it never folds on the way.
    await page.mouse.move(...firstRow);
    await expect(ext).toBeVisible();
    await page.waitForTimeout(400);
    await handle.evaluate((el) => {
      const w = window as unknown as { flips: number };
      w.flips = 0;
      new MutationObserver((changes) => (w.flips += changes.length)).observe(el, { attributes: true, attributeFilter: ['aria-expanded'] });
    });
    await page.mouse.move(...(await center(ext)), { steps: 8 });
    await page.mouse.move(...(await center(handle)), { steps: 8 });
    await page.waitForTimeout(500);
    await page.mouse.move(...firstRow, { steps: 8 });
    await page.waitForTimeout(500);
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => (window as unknown as { flips: number }).flips)).toBe(0);

    // Only leaving everything folds it.
    await page.mouse.move(...away);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');

    // The button alone does not open it, so it stays put under the pointer.
    await page.waitForTimeout(400);
    const closedBox = (await handle.boundingBox())!;
    await page.mouse.move(...(await center(handle)));
    await page.waitForTimeout(400);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    expect(await handle.boundingBox()).toEqual(closedBox);

    // Clicking pins it: leaving no longer folds it.
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByRole('button', { name: '收起更多快捷方式' })).toBeVisible();
    await page.mouse.move(...away);
    await page.waitForTimeout(500);
    await expect(ext).toBeVisible();

    // Collapsing with the button ends that, and hover works again.
    await page.getByRole('button', { name: '收起更多快捷方式' }).click();
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(...away);
    await page.waitForTimeout(400);
    await expect(ext).toBeHidden();
    await page.mouse.move(...firstRow);
    await expect(ext).toBeVisible();

    // Pinning from a peek keeps it open too; Esc from a peek folds it without pinning.
    await page.getByRole('button', { name: /固定展开更多快捷方式/ }).click();
    await expect(page.getByRole('button', { name: '收起更多快捷方式' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(...firstRow);
    await expect(ext).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(...away);
    await page.waitForTimeout(400);
    await expect(ext).toBeHidden();
  });

  test('a menu opened on a peeking tile keeps the extension open under it', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 20);
    await page.reload();
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    await page.locator('[data-dock-row="first"]').hover();
    await expect(ext).toBeVisible();
    await ext.locator(dock(pins[8]!)).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '向前移动' }).hover();
    await page.waitForTimeout(500);
    await expect(ext).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.move(60, 600);
    await expect(ext).toBeHidden();
  });

  test('folding hands the focus to the button, by every path, and Chrome blocks nothing', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 20);
    await page.reload();
    const blocked = await blockedAria(page);
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    const handle = page.getByRole('button', { name: /更多快捷方式/ });
    const firstRow = page.locator('[data-dock-row="first"]');
    const tile = ext.locator(dock(pins[8]!));

    // Peeking, focus on a tile, the mouse leaves.
    await firstRow.hover();
    await expect(ext).toBeVisible();
    await tile.focus();
    await page.mouse.move(60, 600);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(handle).toBeFocused();
    await expect(ext).toBeHidden();

    // Fixed open, keyboard focus on a tile, Esc.
    await handle.click();
    await expect(ext).toBeVisible();
    await tile.focus();
    await page.keyboard.press('Escape');
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(handle).toBeFocused();

    // A menu gives the focus back to its tile, then the extension folds under it.
    await page.mouse.move(60, 600);
    await expect(ext).toBeHidden();
    await firstRow.hover();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(400); // the slab has grown: the tile is under the pointer's way
    await tile.click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(tile).toBeFocused();
    await page.mouse.move(60, 600);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(handle).toBeFocused();

    await page.waitForTimeout(300);
    expect(blocked).toEqual([]);
  });

  test('clicking a shortcut leaves the focus on it; the extension still folds', async ({ home: page }) => {
    const context = page.context();
    const api = context.request;
    const pins = await addPinnedSites(api, 20);
    const app = ((await serverConfig(api)) as unknown as { apps: App[] }).apps.find((a) => a.id === pins[8])!;
    await ops(api, [{ type: 'app.upsert', app: { ...app, openIn: 'new' } }]);
    await context.route('https://*.example.com/**', (r) => r.fulfill({ contentType: 'text/html', body: 'ok' }));
    await page.reload();
    const blocked = await blockedAria(page);
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    const handle = page.getByRole('button', { name: /更多快捷方式/ });

    await page.locator('[data-dock-row="first"]').hover();
    await expect(ext).toBeVisible();
    await page.waitForTimeout(400); // the slab has grown: the tile is under the pointer's way
    const opened = context.waitForEvent('page');
    await ext.locator(dock(pins[8]!)).click();
    await (await opened).close();
    await page.bringToFront();
    await expect(ext.locator(dock(pins[8]!))).toBeFocused();

    await page.mouse.move(60, 600);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(ext).toBeHidden();
    await page.waitForTimeout(300);
    expect(blocked).toEqual([]);
  });

  test('Tab skips a folded extension and walks through an open one, both ways', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 7);
    await page.reload();
    const all = page.locator('[data-dock-row="first"]').getByRole('button', { name: '快速打开' });
    const handle = page.getByRole('button', { name: /更多快捷方式/ });
    const first = page.locator(dock(pins[8]!));
    const last = page.locator(dock(pins[pins.length - 1]!));

    // Folded: the hidden links are skipped — after 快速打开 comes the button hanging under the slab,
    // in both directions.
    await all.focus();
    await page.keyboard.press('Tab');
    await expect(handle).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(all).toBeFocused();

    // Open: every link is reachable again.
    await handle.focus();
    await page.keyboard.press('Enter');
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(handle).toBeFocused();
    await all.focus();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();

    // Esc from inside lands on the button, where the keyboard carries on (folded again: back to 快速打开).
    await page.keyboard.press('Escape');
    await expect(handle).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(all).toBeFocused();
  });

  test('the fade plays out while nothing inside can be clicked or focused', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 20);
    await page.reload();
    await page.getByRole('button', { name: /展开更多快捷方式/ }).click();
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    await expect(ext).toHaveCSS('opacity', '1');
    // Off the rows: a pointer left on them would open it again as soon as it folds.
    await page.mouse.move(60, 600);
    await page.waitForTimeout(400);

    const seen = await ext.evaluate(async (el, id) => {
      const tile = el.querySelector<HTMLElement>(`[data-dock="${id}"]`)!;
      const box = tile.getBoundingClientRect();
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await frame();
      await frame();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      tile.focus();
      // By the clock, not by frames: the number of frames in the fade depends on the display.
      const samples: { ms: number; opacity: number; visibility: string }[] = [];
      const start = performance.now();
      for (let ms = 0; ms < 800; ms = performance.now() - start) {
        const s = getComputedStyle(el);
        samples.push({ ms: Math.round(ms), opacity: Number(s.opacity), visibility: s.visibility });
        await frame();
      }
      return { inert: el.hasAttribute('inert'), hitInside: !!hit && el.contains(hit), focused: document.activeElement === tile, samples };
    }, pins[8]!);

    expect(seen.inert).toBe(true);
    expect(seen.hitInside).toBe(false);
    expect(seen.focused).toBe(false);
    // Still fading on the first frames: it did not vanish, and it only goes hidden once it is gone.
    expect(seen.samples[0]!.opacity).toBeGreaterThan(0.1);
    expect(seen.samples.filter((s) => s.visibility === 'hidden' && s.opacity > 0.02)).toEqual([]);
    expect(seen.samples.at(-1)).toMatchObject({ opacity: 0, visibility: 'hidden' });
  });

  test('opening and closing in quick succession ends in step, with nothing blocked', async ({ home: page }) => {
    const pins = await addPinnedSites(page.context().request, 20);
    await page.reload();
    const blocked = await blockedAria(page);
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    const handle = page.getByRole('button', { name: /更多快捷方式/ });
    const box = (await page.locator('[data-dock-row="first"]').boundingBox())!;
    // The role finds it only while it is shown; this one finds it folded too.
    const element = page.locator('[role="group"][aria-label^="更多快捷方式"]');

    // The mouse in and out, faster and slower than the open and close delays.
    for (const pause of [0, 80, 200, 320, 0, 200]) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(pause);
      await page.mouse.move(60, 600);
      await page.waitForTimeout(pause);
    }
    await page.waitForTimeout(500);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(ext).toBeHidden();
    await expect(element).toHaveAttribute('inert');

    // The button, with the focus thrown into the extension on the way.
    for (let i = 0; i < 6; i++) {
      await handle.click();
      if (i % 2 === 0) await ext.locator(dock(pins[8]!)).focus();
    }
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(element).toHaveAttribute('inert');
    await expect(ext).toBeHidden();

    await handle.click();
    await expect(ext).toBeVisible();
    await expect(element).not.toHaveAttribute('inert');
    await page.waitForTimeout(300);
    expect(blocked).toEqual([]);
  });

  test('the button stays clear of the search panel and of the window edge', async ({ home: page }) => {
    await addPinnedSites(page.context().request, 20);
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.reload();
    const handle = page.getByRole('button', { name: /更多快捷方式/ });
    await handle.click();
    const box = (await page.getByRole('button', { name: '收起更多快捷方式' }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    await page.getByRole('combobox', { name: '搜索' }).click();
    const wrapper = page.locator('[inert]', { has: page.getByRole('button', { name: /更多快捷方式/ }) }).last();
    await expect(wrapper).toHaveCSS('opacity', '0');
  });

  test('edit mode: Alt+→ moves a pin from the first row into the extension', async ({ home: page }) => {
    // Nine pins: eight fill the first row, the ninth is in the extension.
    const pins = await addPinnedSites(page.context().request, 4);
    await page.reload();
    const moved = pins[7]!;
    await page.locator(dock(moved)).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '编辑首页…' }).click();
    const ext = page.getByRole('group', { name: /更多快捷方式/ });
    await expect(ext).toBeVisible();
    await page.locator(dock(moved)).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(async () => (await serverConfig(page.context().request)).pins.indexOf(moved)).toBe(8);
    await expect(ext.locator(dock(moved))).toBeFocused();
    await expect(page.locator('[data-dock-row="first"] [data-dock]').nth(7)).toHaveAttribute('data-dock', pins[8]!);
  });

  test('context menu offers new tab and moving to the ends', async ({ home: page }) => {
    await page.locator(dock('youtube')).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /在新标签页打开/ })).toBeVisible();
    await page.getByRole('menuitem', { name: '移到最前' }).click();
    await expect.poll(async () => (await serverConfig(page.context().request)).pins[0]).toBe('youtube');
    await expect(page.locator('[data-dock]').first()).toHaveAttribute('data-dock', 'youtube');
  });

  test('我的收藏: drag inside a group, move across groups, sync and reload', async ({ home: page, browser }) => {
    // A second device watches the drawer while this one sorts.
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await signIn(other);
    const b = await other.newPage();
    await b.goto('/');
    await b.getByRole('button', { name: '快速打开' }).click();
    const devGrid = b.getByRole('dialog', { name: '快速打开' }).locator('section', { hasText: '开发' });
    await expect(devGrid.getByRole('link')).toHaveText(['GitHub', 'Vercel', 'Cloudflare']);

    // 我的收藏 › 开发 is in its own order: rows can be dragged there (UI v2: no separate 排序 mode).
    await page.goto('/settings/favorites?view=group:dev');
    const rows = page.getByRole('listbox', { name: /^开发（\d+ 条）$/ }).getByRole('option');
    await expect(rows).toHaveCount(3);

    // Mouse drag by the handle: Cloudflare above GitHub.
    const handle = page.getByRole('button', { name: /^拖动以排序「Cloudflare」/ });
    const target = rows.filter({ hasText: 'GitHub' });
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

    // No drag needed: the ⋯ menu moves Figma into 开发 (to its end), by keyboard.
    await page.goto('/settings/favorites?view=group:work');
    await page.getByRole('button', { name: '「Figma」的操作' }).click();
    await page.getByRole('menuitem', { name: '移动到分组…' }).press('Enter');
    const move = page.getByRole('dialog', { name: '移动「Figma」' });
    await move.getByRole('combobox', { name: '移动到分组' }).selectOption('dev');
    await move.getByRole('button', { name: '移动' }).press('Enter');
    await expect.poll(() => inCat('dev')).toEqual(['cloudflare', 'github', 'vercel', 'figma']);

    // The other device follows without reloading; this one keeps the order after a reload.
    await expect(devGrid.getByRole('link')).toHaveText(['Cloudflare', 'GitHub', 'Vercel', 'Figma'], { timeout: 5000 });
    await page.goto('/settings/favorites?view=group:dev');
    await expect(page.getByRole('listbox', { name: /^开发（\d+ 条）$/ }).getByRole('option')).toHaveText([/Cloudflare/, /GitHub/, /Vercel/, /Figma/]);
    await other.close();
  });

  test('我的收藏: the group menu reorders groups, undo restores', async ({ home: page }) => {
    await page.goto('/settings/favorites');
    const tree = page.getByRole('navigation', { name: '收藏分组' });
    await tree.getByRole('button', { name: '「影音与社区」的操作' }).click();
    await page.getByRole('menuitem', { name: '移到最前' }).click();
    const cats = async () => ((await serverConfig(page.context().request)) as unknown as { categories: { id: string }[] }).categories.map((k) => k.id).filter((id) => id !== 'none');
    await expect.poll(cats).toEqual(['media', 'hosted', 'dev', 'work']);
    await page.getByRole('button', { name: '撤销' }).click();
    await expect.poll(cats).toEqual(['hosted', 'dev', 'work', 'media']);
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
    // Eight fill the first row (1440 px window, default panel); four are left for the extension.
    await expect(page.getByRole('button', { name: '展开更多快捷方式（另有 4 个）' })).toBeVisible();
  });
});

test.describe('mobile', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile layout');

  test('extra pins sit on swipeable pages and the sheet pulls up to show them all', async ({ home: page }) => {
    // 5 + 14 pins at 4 × 2 a page (UI v2: no service area on the first page): 8, 8, 3.
    const pins = await addPinnedSites(page.context().request, 14);
    await page.reload();
    const strip = page.getByRole('group', { name: /快捷方式，第/ });
    await expect(strip).toHaveAttribute('aria-label', '快捷方式，第 1 / 3 页');
    await strip.evaluate((el) => el.scrollTo({ left: el.clientWidth }));
    await expect(strip).toHaveAttribute('aria-label', '快捷方式，第 2 / 3 页');
    expect(new URL(page.url()).pathname).toBe('/');
    // The first of page 2: the 9th pin.
    await expect(page.getByRole('link', { name: '站点 3', exact: true })).toBeInViewport();

    await page.getByRole('button', { name: '展开更多快捷方式' }).tap();
    const all = page.getByRole('group', { name: '全部快捷方式' });
    await expect(all).toBeVisible();
    // Every pin, in the shared order (services only when pinned — none here).
    await expect(all.getByRole('link')).toHaveCount(pins.length);
    await expect(page.getByRole('button', { name: '收起快捷方式' })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '收起快捷方式' }).tap();
    await expect(all).toBeHidden();
  });

  test('long press on a later page opens the sheet with move options', async ({ home: page }) => {
    await addPinnedSites(page.context().request, 10);
    await page.reload();
    const strip = page.getByRole('group', { name: /快捷方式，第/ });
    await strip.evaluate((el) => el.scrollTo({ left: el.clientWidth }));
    // On page 2 at 4 × 2 a page (5 + 10 pins).
    const tile = page.getByRole('link', { name: '站点 5', exact: true });
    const b = (await tile.boundingBox())!;
    const at = { pointerType: 'touch', isPrimary: true, pointerId: 9, button: 0, buttons: 1, clientX: b.x + b.width / 2, clientY: b.y + 20 };
    await tile.dispatchEvent('pointerdown', at);
    await page.waitForTimeout(650);
    await tile.dispatchEvent('pointerup', at);
    await tile.dispatchEvent('click');
    const sheet = page.getByRole('dialog', { name: '站点 5' });
    await expect(sheet.getByRole('button', { name: '移到最前' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    await sheet.getByRole('button', { name: '移到最前' }).tap();
    const site5 = (await serverConfig(page.context().request)).apps.find((a) => a.name === '站点 5')!.id;
    await expect.poll(async () => (await serverConfig(page.context().request)).pins[0]).toBe(site5);
  });

  test('我的收藏 on a phone orders a group without dragging', async ({ home: page }) => {
    await page.goto('/settings/favorites?view=group:media');
    await page.getByRole('button', { name: '「Telegram」的操作' }).tap();
    await page.getByRole('dialog', { name: 'Telegram' }).getByRole('button', { name: '移到分组最前' }).tap();
    const media = async () => ((await serverConfig(page.context().request)) as unknown as { apps: App[] }).apps.filter((a) => a.categoryId === 'media').map((a) => a.id);
    await expect.poll(media).toEqual(['telegram', 'youtube', 'bilibili', 'spotify', 'reddit', 'x']);
  });
});
