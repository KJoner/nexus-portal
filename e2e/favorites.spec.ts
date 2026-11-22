import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expect, freshTag, ops, serverConfig, test } from './fixtures';

/**
 * 我的收藏 (UI v2 · v12.0.3 N1–N4, spec 06 A06–A10, B01–B03, B06, B09–B11, C01–C05, C11) on the
 * built app, signed in as the legacy administrator on the e2e baseline. One page for every favorite,
 * reached from the home page and from 设置; one editor; 添加收藏 with 应用商店 inside; old links.
 */
const H = { 'X-Nexus-Client': '1' };
const shot = async (page: Page, name: string) => {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};
const list = (page: Page) => page.getByRole('listbox', { name: /（\d+ 条）$/ });
const items = async (page: Page, q: string) => (await (await page.request.get(`/api/v2/items?q=${encodeURIComponent(q)}&limit=50`)).json()).items as { id: string; title: string; folderId: string; app?: Record<string, unknown> | null; note: string; version: number }[];

test('A06/A07: the home page and 设置 open the same 我的收藏; old links land on the same tasks', async ({ home: page, isMobile }) => {
  if (!isMobile) {
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link', { name: '应用目录' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: '收藏库' })).toHaveCount(0);
    await nav.getByRole('link', { name: '我的收藏' }).click();
  } else await page.goto('/settings/favorites');
  await expect(page).toHaveURL(/\/settings\/favorites/);
  await expect(list(page)).toBeVisible();
  await shot(page, `favorites-${isMobile ? 'phone' : 'desktop'}`);
  // 设置 has 我的收藏 in place of 网站与服务 (spec 01 §3).
  await page.goto('/settings');
  await expect(page.getByText('网站与服务')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /我的收藏/ }).first()).toBeVisible();
  // Old links.
  await page.goto('/library');
  await expect(page).toHaveURL(/\/settings\/favorites$/);
  await page.goto('/settings/apps?edit=github');
  await expect(page.getByRole('dialog', { name: '编辑「GitHub」' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/favorites$/);
  await page.keyboard.press('Escape');
  await page.goto('/catalog?q=知乎');
  const add = page.getByRole('dialog', { name: '添加收藏' });
  await expect(add.getByRole('textbox', { name: '搜索应用商店' })).toHaveValue('知乎');
});

test('C02/C03/C04: 应用商店 inside 添加收藏 — 已添加, one primary action, back to the form, nothing found → manual', async ({ home: page, isMobile }, info) => {
  await page.goto('/settings/favorites?add=store');
  const dialog = page.getByRole('dialog', { name: '添加收藏' });
  if (isMobile) await dialog.getByRole('tab', { name: /应用商店/ }).click();
  // The seed's GitHub is recognised as already saved, and leads to it; nothing private is offered.
  await dialog.getByRole('textbox', { name: '搜索应用商店' }).fill('github');
  await expect(dialog.getByRole('button', { name: 'GitHub 已添加，查看原条目' })).toBeVisible();
  await expect(dialog.getByText(/LiteBox|Linkwarden/)).toHaveCount(0);
  await shot(page, `add-store-${info.project.name}`);
  // Pick two; the manual form gives way to the list and ONE 「添加 2 个网站」.
  if (!isMobile) await dialog.getByRole('textbox', { name: /网址/ }).fill('https://typed-before.example.org');
  await dialog.getByRole('textbox', { name: '搜索应用商店' }).fill('知乎');
  await dialog.getByRole('button', { name: '选择 知乎' }).click();
  await dialog.getByRole('textbox', { name: '搜索应用商店' }).fill('豆瓣');
  await dialog.getByRole('button', { name: '选择 豆瓣' }).click();
  await expect(dialog.getByRole('button', { name: '添加 2 个网站' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '添加这个收藏' })).toHaveCount(0);
  if (!isMobile) {
    // 返回手动填写 brings the unsent form back as it was (and drops the selection).
    await dialog.getByRole('button', { name: /返回手动填写/ }).click();
    await expect(dialog.getByRole('textbox', { name: /网址/ })).toHaveValue('https://typed-before.example.org');
    await expect(dialog.getByRole('button', { name: /^添加 \d+ 个网站$/ })).toHaveCount(0);
    for (const name of ['知乎', '豆瓣']) {
      await dialog.getByRole('textbox', { name: '搜索应用商店' }).fill(name);
      await dialog.getByRole('button', { name: `选择 ${name}` }).click();
    }
  }
  // On a phone the group and the pin are on the selection list, one tap from the store.
  if (isMobile) await dialog.getByRole('button', { name: '更改分组与固定' }).click();
  await dialog.getByRole('combobox', { name: '保存到分组' }).selectOption('media');
  await dialog.getByRole('button', { name: '添加 2 个网站' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '已添加 2 个到「影音与社区」' })).toBeVisible();
  await expect.poll(async () => (await items(page, '知乎')).map((i) => i.folderId)).toEqual(['media']);
  // Added without pinning (the pin is a separate choice).
  const cfg = await serverConfig(page.request);
  expect(cfg.pins.some((id) => cfg.apps.find((a) => a.id === id)?.name === '知乎')).toBe(false);
  if (!isMobile) {
    // Not on the home page, but 快速打开 finds it.
    await page.goto('/');
    await page.getByRole('button', { name: '快速打开' }).first().click();
    await expect(page.getByRole('dialog', { name: '快速打开' }).getByRole('link', { name: /知乎/ })).toBeVisible();
    await shot(page, `quick-open-after-store-${info.project.name}`);
    await page.keyboard.press('Escape');
  }

  // Nothing found → 使用此网址手动添加, prefilled.
  await page.goto('/settings/favorites?add=store');
  if (isMobile) await dialog.getByRole('tab', { name: /应用商店/ }).click();
  await dialog.getByRole('textbox', { name: '搜索应用商店' }).fill('docs.example.org/guide');
  await dialog.getByRole('button', { name: '使用此网址手动添加' }).click();
  await expect(dialog.getByRole('textbox', { name: /网址/ })).toHaveValue(/^(https:\/\/)?docs\.example\.org\/guide$/);
  await expect(dialog.getByRole('textbox', { name: /名称/ })).toHaveValue('docs.example');
  await expect(dialog.getByRole('switch', { name: '同时固定到首页' })).toHaveAttribute('aria-checked', 'false');
  // Cleanup: what this test added.
  for (const q of ['知乎', '豆瓣']) for (const i of await items(page, q)) await page.request.delete(`/api/v2/items/${i.id}?opId=e2e-clean-${i.id}-${Date.now()}&baseVersion=${i.version}`, { headers: H });
});

/**
 * The one primary action is really on screen, not just in the DOM: Playwright scrolls clipped elements
 * into view before clicking, so a footer pushed under the dialog's edge still "clicks" in a test while a
 * person cannot reach it (seen at 1440×960 before the fix). Hit-test the button's centre instead.
 */
async function reachable(page: Page, name: string) {
  const button = page.getByRole('dialog', { name: '添加收藏' }).getByRole('button', { name, exact: true });
  await expect(button).toBeAttached();
  return button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const dialog = el.closest('[role="dialog"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit) && r.top >= 0 && r.bottom <= innerHeight && r.bottom <= dialog.bottom + 1;
  });
}

test('C02: 添加收藏 keeps its one primary action on screen — manual and with sites picked, laptop heights too', async ({ home: page, isMobile }) => {
  const sizes = isMobile ? [null] : [{ width: 1440, height: 960 }, { width: 1280, height: 720 }];
  for (const size of sizes) {
    if (size) await page.setViewportSize(size);
    await page.goto('/settings/favorites?add=manual');
    await expect(page.getByRole('dialog', { name: '添加收藏' })).toBeVisible();
    expect(await reachable(page, '添加这个收藏'), `添加这个收藏 at ${size ? `${size.width}×${size.height}` : 'phone'}`).toBe(true);
    const dialog = page.getByRole('dialog', { name: '添加收藏' });
    if (isMobile) await dialog.getByRole('tab', { name: /应用商店/ }).click();
    await dialog.getByRole('textbox', { name: '搜索应用商店' }).fill('知乎');
    await dialog.getByRole('button', { name: '选择 知乎' }).click();
    expect(await reachable(page, '添加 1 个网站'), `添加 1 个网站 at ${size ? `${size.width}×${size.height}` : 'phone'}`).toBe(true);
    await page.keyboard.press('Escape');
  }
});

test('C01/C05: manual add — group, pin, back where it was; the same address asks first', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'covered on desktop; the phone sheet is in the screenshots');
  const url = `https://manual.example.org/${Date.now()}`;
  await page.goto('/settings/favorites?view=group:work');
  await page.getByRole('button', { name: '添加收藏' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加收藏' });
  // The group being looked at is preselected; the pin is explicit.
  await expect(dialog.getByRole('combobox', { name: '保存到分组' })).toHaveValue('work');
  await dialog.getByRole('textbox', { name: /网址/ }).fill(url);
  await dialog.getByRole('textbox', { name: /名称/ }).fill('手动添加的网页');
  await dialog.getByRole('switch', { name: '同时固定到首页' }).click();
  await dialog.getByRole('button', { name: '添加这个收藏' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/view=group%3Awork|view=group:work/);
  await expect(list(page).getByText('手动添加的网页')).toBeVisible();
  const [made] = await items(page, '手动添加的网页');
  expect(made!.folderId).toBe('work');
  await expect.poll(async () => (await serverConfig(page.request)).pins).toContain(made!.id);
  // The same address again: nothing written until the person chooses.
  await page.getByRole('button', { name: '添加收藏' }).first().click();
  await dialog.getByRole('textbox', { name: /网址/ }).fill(url);
  await dialog.getByRole('textbox', { name: /名称/ }).fill('再存一次');
  await dialog.getByRole('button', { name: '添加这个收藏' }).click();
  await expect(dialog.getByText(/这个网址已在我的收藏：「手动添加的网页」/)).toBeVisible();
  await dialog.getByRole('button', { name: '更新原有的' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await items(page, url)).map((i) => i.title)).toEqual(['再存一次']);
  await page.request.delete(`/api/v2/items/${made!.id}?opId=e2e-clean-${made!.id}-${Date.now()}`, { headers: H });
});

test('B01/B02/B03: one editor for everything; a 200-character title and 2000-character note survive an icon change', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'covered on desktop');
  const long = '长标题'.repeat(66) + '尾巴';
  const note = '备注'.repeat(1000);
  const r = await page.request.post('/api/v2/favorites', { headers: H, data: { opId: `e2e-long-${Date.now()}`, source: 'manual', duplicatePolicy: 'create', items: [{ kind: 'page', title: long, url: `https://long.example.org/${Date.now()}`, note }] } });
  const id = (await r.json()).results[0].item.id as string;
  try {
    await page.goto(`/settings/favorites?edit=${id}`);
    const dialog = page.getByRole('dialog', { name: /^编辑「/ });
    await dialog.getByRole('button', { name: /更多选项/ }).click();
    await dialog.getByRole('radio', { name: '字母' }).click();
    await dialog.getByRole('textbox', { name: '图标字母' }).fill('长');
    const alias = dialog.getByRole('textbox', { name: '搜索别名' });
    await alias.fill('长文，lw');
    await alias.press('Enter');
    await dialog.getByRole('radio', { name: '新标签页' }).click();
    // Service options are in the same form (no second page).
    await dialog.getByRole('button', { name: /服务选项/ }).click();
    await expect(dialog.getByRole('switch', { name: '这是自己的服务' })).toBeVisible();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await items(page, '长标题')).find((i) => i.id === id)?.app?.aliases).toEqual(['长文', 'lw']);
    const [after] = (await items(page, '长标题')).filter((i) => i.id === id);
    expect(after!.title).toBe(long);
    expect(after!.note).toBe(note);
    expect(after!.app).toMatchObject({ openIn: 'new', icon: { source: 'letter', letter: '长' } });
  } finally {
    await page.request.delete(`/api/v2/items/${id}?opId=e2e-clean-${id}-${Date.now()}`, { headers: H });
  }
});

test('B02: 编辑收藏 on the home page opens the same editor; the link is used once; search ignores case', async ({ home: page, isMobile }) => {
  if (isMobile) await page.goto('/settings/favorites?edit=github');
  else {
    await page.getByRole('link', { name: 'GitHub' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '编辑收藏' }).click();
  }
  const dialog = page.getByRole('dialog', { name: '编辑「GitHub」' });
  await expect(dialog.getByRole('textbox', { name: '网址' })).toHaveValue(/github\.com/);
  // One form: the address, the name and the home look (aliases) are edited together.
  await dialog.getByRole('button', { name: /更多选项/ }).click();
  await expect(dialog.getByRole('textbox', { name: '搜索别名' })).toBeVisible();
  await dialog.getByRole('textbox', { name: '名称' }).fill('GitHub 代码');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await serverConfig(page.request)).apps.find((a) => a.id === 'github')?.name).toBe('GitHub 代码');
  if (isMobile) await expect(page).toHaveURL(/\/settings\/favorites$/);
  // The collection search ignores case, like the home search.
  await page.goto('/settings/favorites');
  await page.getByRole('searchbox', { name: '搜索我的收藏' }).fill('GITHUB 代码');
  await expect(list(page).getByRole('option')).toHaveCount(1);
  await expect(list(page).getByRole('option')).toContainText('GitHub 代码');
});

test('B06/B09/B10/B11: three levels of groups, independent orders, delete keeps the content', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'tree on desktop; the phone sheet is in the screenshots');
  await page.goto('/settings/favorites');
  const tree = page.getByRole('navigation', { name: '收藏分组' });
  // 新建 → 子分组 → 子分组: 工作 / 项目 / 资料 (a leaf named like 影音与社区's would be fine too).
  const create = async (parentLabel: string | null, label: string) => {
    if (parentLabel) {
      await tree.getByRole('button', { name: `「${parentLabel}」的操作` }).click();
      await page.getByRole('menuitem', { name: '新建子分组' }).click();
    } else await tree.getByRole('button', { name: '新建分组' }).click();
    const d = page.getByRole('dialog', { name: parentLabel ? '新建子分组' : '新建分组' });
    await d.getByRole('textbox', { name: '分组名称' }).fill(label);
    await d.getByRole('button', { name: '新建' }).click();
    await expect(d).toBeHidden();
  };
  await create('工作', '项目');
  await create('项目', '资料');
  await create('影音与社区', '资料');
  await expect(tree.getByRole('button', { name: /^工作 \/ 项目 \/ 资料，直属 0 个/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /^影音与社区 \/ 资料，直属 0 个/ })).toBeVisible();

  // 移动到…: where it is and where it will be; a sibling with the same name is refused, not merged.
  const mediaDocs = tree.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^影音与社区 \/ 资料，直属/ }) });
  await mediaDocs.getByRole('button', { name: '「资料」的操作' }).click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  const mv = page.getByRole('dialog', { name: '移动分组' });
  await expect(mv).toContainText('影音与社区 / 资料');
  await mv.getByRole('combobox', { name: /^上级分组/ }).selectOption({ label: '工作 / 项目' });
  await expect(mv.getByRole('alert')).toBeVisible();
  await expect(mv.getByRole('button', { name: '移动' })).toBeDisabled();
  await mv.getByRole('combobox', { name: /^上级分组/ }).selectOption({ label: '开发' });
  await expect(mv.getByRole('alert')).toHaveCount(0);
  await expect(mv).toContainText('开发 / 资料');
  await shot(page, 'favorites-move-group');
  await mv.getByRole('button', { name: '移动' }).click();
  await expect(tree.getByRole('button', { name: /^开发 \/ 资料，直属 0 个/ })).toBeVisible();

  // Reopened (another device would read the same): the same three levels.
  await page.reload();
  await expect(tree.getByRole('button', { name: /^工作 \/ 项目 \/ 资料，直属/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /^开发 \/ 资料，直属/ })).toBeVisible();
  await shot(page, 'favorites-tree');

  // Favorites inside 工作: 上移 / 下移 from the ⋯ menu (no drag needed), and the home pins untouched.
  await tree.getByRole('button', { name: /^工作，直属/ }).click();
  const pinsBefore = (await serverConfig(page.request)).pins;
  const rows = list(page).getByRole('option');
  const second = (await rows.nth(1).getByRole('button', { name: /^编辑「/ }).getAttribute('aria-label'))!.slice(3, -1);
  await list(page).getByRole('button', { name: `「${second}」的操作` }).click();
  await page.getByRole('menuitem', { name: '在分组里上移' }).click();
  await expect(rows.first()).toContainText(second);
  // A view sort never rewrites the manual order.
  await page.getByRole('combobox', { name: /排序方式/ }).selectOption('name');
  await page.getByRole('combobox', { name: /排序方式/ }).selectOption('manual');
  await expect(rows.first()).toContainText(second);
  expect((await serverConfig(page.request)).pins).toEqual(pinsBefore);

  // Groups among their siblings: 移到最前, then 撤销.
  const cats = async () => (await serverConfig(page.request)).categories.map((k: { id: string }) => k.id) as string[];
  const before = await cats();
  await tree.getByRole('button', { name: '「影音与社区」的操作' }).click();
  await page.getByRole('menuitem', { name: '移到最前' }).click();
  await expect.poll(async () => (await cats())[0]).toBe('media');
  await page.getByRole('button', { name: '撤销' }).click();
  await expect.poll(cats).toEqual(before);

  // Delete 项目: the impact first; its sub-group moves up, nothing is deleted.
  await tree.getByRole('button', { name: '「项目」的操作' }).click();
  await page.getByRole('menuitem', { name: /删除分组/ }).click();
  const del = page.getByRole('dialog', { name: '删除分组「项目」' });
  await expect(del.getByLabel('删除后的影响')).toContainText('1 个子分组（资料）上移一层');
  await shot(page, 'favorites-delete-preview');
  await del.getByRole('button', { name: '删除分组' }).click();
  await expect(tree.getByRole('button', { name: /^工作 \/ 资料，直属/ })).toBeVisible();
  // Cleanup of the groups this test made.
  for (const label of ['资料']) {
    for (;;) {
      const g = (await serverConfig(page.request)).categories.find((k: { label: string }) => k.label === label) as { id: string } | undefined;
      if (!g) break;
      await page.request.post('/api/config/ops', { headers: H, data: { clientId: 'e2e', batchId: `e2e-del-${Date.now()}-${Math.random()}`, ops: [{ type: 'group.delete', groupId: g.id }] } });
    }
  }
});

test('5000 favorites: light DOM, search, keyboard, range select, batch move, trash and restore, import and undo, export', async ({ home, isMobile }, info) => {
  test.setTimeout(150_000);
  const page = home;
  const api = page.request;
  const run = `${info.project.name}-${Date.now().toString(36)}`;
  const batch = Array.from({ length: 5000 }, (_, i) => ({ kind: 'page', title: `合成收藏 ${String(i).padStart(4, '0')}`, url: `https://synthetic.example.org/${run}/p/${i}?ref=${i % 7}#s${i % 3}`, tags: i % 500 === 0 ? ['抽样'] : [] }));
  const imported = await (await api.post('/api/v2/import', { headers: H, data: { opId: `e2e-big-${Date.now()}`, items: batch } })).json();
  expect(imported.imported).toBe(5000);
  try {
    await page.goto('/settings/favorites');
    const all = list(page);
    await expect(all).toHaveAttribute('aria-label', /全部收藏（50\d\d 条）/);
    // Windowed: a few dozen rows in the document, not 5000.
    const rows = await all.getByRole('option').count();
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBeLessThan(120);
    await shot(page, `favorites-5000-${info.project.name}`);

    const search = page.getByRole('searchbox', { name: '搜索我的收藏' });
    const t0 = Date.now();
    await search.fill('合成收藏 4321');
    await expect(all).toHaveAttribute('aria-label', /（1 条）$/);
    test.info().annotations.push({ type: 'search-5000-ms', description: String(Date.now() - t0) });
    // Tags are searched too: the ten 抽样.
    await search.fill('抽样');
    await expect(all).toHaveAttribute('aria-label', /（10 条）$/);
    await all.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(' ');
    await expect(all.getByRole('option', { selected: true })).toHaveCount(1);
    await expect(all.getByRole('option', { selected: true })).toContainText('合成收藏 0500');

    // Shift-click selects a range (1500…2500 here): 0500 + 1500, 2000, 2500 = 4.
    await all.getByRole('checkbox', { name: '选择 合成收藏 1500' }).click();
    await all.getByRole('checkbox', { name: '选择 合成收藏 2500' }).click({ modifiers: ['Shift'] });
    await expect(page.getByRole('region', { name: '批量操作' })).toContainText('已选 4 项');
    await expect(all.getByRole('option', { selected: true })).toHaveText([/合成收藏 0500/, /合成收藏 1500/, /合成收藏 2000/, /合成收藏 2500/]);
    await page.getByRole('region', { name: '批量操作' }).getByRole('button', { name: '移动到分组' }).click();
    const move = page.getByRole('dialog', { name: '移动 4 个收藏' });
    await move.getByRole('combobox', { name: '移动到分组' }).selectOption('work');
    await move.getByRole('button', { name: '移动' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已把 4 个收藏移到「工作」' })).toBeVisible();
    await expect.poll(async () => (await (await api.get(`/api/v2/items?url=${encodeURIComponent(`https://synthetic.example.org/${run}/p/2500?ref=1#s1`)}`)).json()).items[0]?.folderId).toBe('work');

    // Trash one, then restore it from 回收站.
    await all.getByRole('checkbox', { name: '选择 合成收藏 2000' }).click();
    await page.getByRole('region', { name: '批量操作' }).getByRole('button', { name: '移到回收站' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已把「合成收藏 2000」移到回收站' })).toBeVisible();
    await expect(all).toHaveAttribute('aria-label', /（9 条）$/);
    await search.fill('');
    if (isMobile) {
      await page.getByRole('button', { name: /全部收藏/ }).first().click();
      await page.getByRole('dialog', { name: '选择分组' }).getByRole('button', { name: /回收站/ }).click();
    } else await page.getByRole('navigation', { name: '收藏分组' }).getByRole('button', { name: /回收站/ }).click();
    await expect(list(page).getByRole('option').filter({ hasText: '合成收藏 2000' })).toBeVisible();
    await list(page).getByRole('option').filter({ hasText: '合成收藏 2000' }).getByRole('button', { name: '恢复' }).click();
    await expect(list(page).getByRole('option').filter({ hasText: '合成收藏 2000' })).toHaveCount(0);

    // Import a bookmarks file with folders: kept as groups by default, previewed, then undone.
    if (isMobile) await page.getByRole('button', { name: '导入', exact: true }).click();
    else {
      await page.getByRole('button', { name: /更多：导入/ }).click();
      await page.getByRole('menuitem', { name: '导入书签或备份…' }).click();
    }
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>${run}-工作</H3><DL><p><DT><A HREF="https://e2e-import.example.org/${run}/a?x=1#y">导入甲</A><DT><H3>子目录</H3><DL><p><DT><A HREF="https://e2e-import.example.org/${run}/b">导入乙</A></DL><p><DT><A HREF="javascript:void(0)">小工具</A></DL><p></DL>`;
    await page.getByLabel('选择要导入的文件').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    const preview = page.getByLabel('导入预览');
    await expect(preview).toContainText('将导入2');
    await expect(preview).toContainText('新建 2 个');
    await expect(preview).toContainText('不支持的地址（跳过）1');
    await shot(page, `favorites-import-${info.project.name}`);
    await page.getByRole('button', { name: '导入 2 条' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已导入 2 条' })).toBeVisible();
    await expect.poll(async () => (await serverConfig(api)).categories.some((k: { label: string }) => k.label === '子目录')).toBe(true);
    await page.getByRole('button', { name: '撤销本次导入' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已撤销导入：移入回收站 2 条' })).toBeVisible();

    if (!isMobile) {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: /更多：导入/ }).click();
      await page.getByRole('menuitem', { name: '导出我的收藏' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^nexus-collection-\d{4}-\d{2}-\d{2}\.json$/);
    }
  } finally {
    await api.post(`/api/v2/import/${imported.importId}/undo`, { headers: H, data: { opId: `e2e-undo-${Date.now()}` } });
    for (;;) {
      const left = (await (await api.get(`/api/v2/items?q=${encodeURIComponent(run)}&limit=200`)).json()).items as { id: string }[];
      if (!left.length) break;
      for (const i of left) await api.delete(`/api/v2/items/${i.id}?opId=e2e-clean-${i.id}-${Date.now()}`, { headers: H });
    }
  }
});

test('A08: one set of names — 我的收藏, 添加收藏, 应用商店, 分组 / 子分组 / 未分组 — and none of the old ones', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'the same words on the phone are in the screenshots');
  const OLD = /收藏库|应用目录|网站与服务|未分类|分类管理/;
  const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的收藏' })).toBeVisible();
  expect(await text()).not.toMatch(OLD);
  await page.getByRole('button', { name: '快速打开' }).first().click();
  await expect(page.getByRole('dialog', { name: '快速打开' })).toBeVisible();
  expect(await page.getByRole('dialog', { name: '快速打开' }).innerText()).not.toMatch(OLD);
  await page.keyboard.press('Escape');

  await page.goto('/settings/favorites');
  await expect(page.getByRole('heading', { level: 1, name: /我的收藏/ })).toBeVisible();
  const tree = page.getByRole('navigation', { name: '收藏分组' });
  await expect(tree).toContainText('我的分组');
  await expect(tree.getByRole('button', { name: /^未分组/ })).toBeVisible();
  expect(await text()).not.toMatch(OLD);
  await tree.getByRole('button', { name: '「工作」的操作' }).click();
  await expect(page.getByRole('menuitem', { name: '新建子分组' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '添加收藏' }).first().click();
  const add = page.getByRole('dialog', { name: '添加收藏' });
  await expect(add.getByRole('region', { name: '应用商店' })).toBeVisible();
  await expect(add.getByRole('combobox', { name: '保存到分组' }).locator('option', { hasText: '未分组' })).toHaveCount(1);
  expect(await add.innerText()).not.toMatch(OLD);
  await page.keyboard.press('Escape');

  await page.goto('/settings');
  expect(await text()).not.toMatch(OLD);
});

test('A09: empty, no result and offline each say what they are', async ({ home: page, context, isMobile }) => {
  test.skip(isMobile, 'desktop');
  await page.goto('/settings/favorites?view=trash');
  await expect(page.getByText('回收站是空的')).toBeVisible();
  await page.goto('/settings/favorites?view=unfiled');
  await expect(page.getByText('这里还没有收藏')).toBeVisible();
  await page.goto(`/settings/favorites?q=${encodeURIComponent('没有这种收藏 zzz')}`);
  await expect(page.getByText('没有找到匹配的收藏')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(list(page).getByRole('option').first()).toBeVisible();

  // Offline: the add is kept on this device and said so — never reported as done.
  const url = `https://offline-add.example.org/${Date.now()}`;
  await context.setOffline(true);
  await page.getByRole('button', { name: '添加收藏' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加收藏' });
  await dialog.getByRole('textbox', { name: /网址/ }).fill(url);
  await dialog.getByRole('textbox', { name: /名称/ }).fill('离线时添加的');
  await dialog.getByRole('button', { name: '添加这个收藏' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已离线保存，联网后添加到「未分组」' })).toBeVisible();
  await context.setOffline(false);
  await expect.poll(async () => (await items(page, url)).map((i) => i.title), { timeout: 15_000 }).toEqual(['离线时添加的']);
  for (const i of await items(page, url)) await page.request.delete(`/api/v2/items/${i.id}?opId=e2e-clean-${i.id}-${Date.now()}`, { headers: H });
});

test('C05: when the home page is full the favorite is still added — only the pin is left out, and said so', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'desktop');
  const api = page.request;
  // Fill the home page to its 36 pins (letter-icon sites: no network).
  const cfg = (await serverConfig(api)) as unknown as { pins: string[]; apps: (Record<string, unknown> & { id: string })[] };
  const gh = cfg.apps.find((a) => a.id === 'github')!;
  const tag = freshTag();
  const sites = Array.from({ length: 36 - cfg.pins.length }, (_, i) => ({ ...gh, id: `full-${tag}-${i}`, name: `占位 ${i}`, url: `https://full${i}.example.com`, icon: { source: 'letter', ref: '', letter: 'F', tone: 0 } }));
  await ops(api, sites.map((app) => ({ type: 'app.upsert', app })));
  await ops(api, sites.map((x) => ({ type: 'pin.add', appId: x.id })));
  expect((await serverConfig(api)).pins).toHaveLength(36);

  const url = `https://pins-full.example.org/${Date.now()}`;
  await page.goto('/settings/favorites');
  await page.getByRole('button', { name: '添加收藏' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加收藏' });
  await dialog.getByRole('textbox', { name: /网址/ }).fill(url);
  await dialog.getByRole('textbox', { name: /名称/ }).fill('首页满了也要存下');
  await dialog.getByRole('switch', { name: '同时固定到首页' }).click();
  await expect(dialog).toContainText('还能固定 0 个');
  await dialog.getByRole('button', { name: '添加这个收藏' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '首页已满，1 个只加入收藏、没有固定' })).toBeVisible();
  const [made] = await items(page, url);
  expect(made!.title).toBe('首页满了也要存下');
  const after = (await serverConfig(api)).pins;
  expect(after).toHaveLength(36);
  expect(after).not.toContain(made!.id);
  await api.delete(`/api/v2/items/${made!.id}?opId=e2e-clean-${made!.id}-${Date.now()}`, { headers: H });
});

test('A10: dialogs close with Escape and give the focus back', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'keyboard path on desktop');
  await page.goto('/settings/favorites');
  const add = page.getByRole('button', { name: '添加收藏' }).first();
  await add.click();
  await expect(page.getByRole('dialog', { name: '添加收藏' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '添加收藏' })).toBeHidden();
  await expect(add).toBeFocused();
});

test('A04/C11: phone widths do not scroll sideways; the status pill never names the account', async ({ home: page, isMobile }) => {
  for (const width of isMobile ? [390, 360] : [1440, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/settings/favorites');
    await expect(list(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  }
  await page.goto('/');
  const pill = page.getByRole('link', { name: /^保存状态：/ });
  await expect(pill).toBeVisible();
  const me = (await (await page.request.get('/api/v2/me', { headers: H })).json()) as { account?: { email?: string; name?: string } };
  const words = `${await pill.textContent()} ${await pill.getAttribute('aria-label')} ${await pill.getAttribute('title')}`;
  for (const v of [me.account?.email, me.account?.name]) if (v) expect(words).not.toContain(v);
});
