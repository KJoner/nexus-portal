import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, freshTag, ops, test } from './fixtures';

/**
 * 我的收藏 · 拖动 (UI v2 · v12.0.3 N2/N4, spec 06 B06/B10) on the built app: groups dragged in the
 * tree (beside a group, or into it as a subgroup), favorites dragged onto a group (the selected
 * ones with them), the grid sorted by drag. Real mouse events; every result is read back from the
 * server (after a reload where it matters). Synthetic data only (example.test). The Service Worker
 * is off, as in the other suites that stage requests.
 */
test.use({ serviceWorkers: 'block' });

const H = { 'X-Nexus-Client': '1' };
type Cat = { id: string; label: string; parentId?: string | null };
type It = { id: string; title: string; folderId: string; position: number; version: number; deletedAt: number | null };

const categories = async (api: APIRequestContext) => ((await (await api.get('/api/config')).json()).config.categories as Cat[]).map((c) => ({ ...c, parentId: c.parentId ?? null }));
const siblings = async (api: APIRequestContext, parentId: string | null) => (await categories(api)).filter((c) => c.id !== 'none' && c.parentId === parentId).map((c) => c.id);
const search = async (api: APIRequestContext, q: string, deleted = false) => (await (await api.get(`/api/v2/items?q=${encodeURIComponent(q)}&limit=200${deleted ? '&deleted=1' : ''}`)).json()).items as It[];
let n = 0;
const create = async (api: APIRequestContext, title: string, folderId: string) => {
  const r = await api.post('/api/v2/items', { headers: H, data: { opId: `e2e-drag-${Date.now()}-${++n}`, item: { title, url: `https://${encodeURIComponent(title)}-${n}.example.test/`, folderId } } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).item as It;
};
const clean = async (api: APIRequestContext, q: string) => {
  for (const i of await search(api, q)) await api.delete(`/api/v2/items/${i.id}?opId=e2e-clean-${i.id}-${Date.now()}`, { headers: H });
};
const tree = (page: Page) => page.getByRole('navigation', { name: '收藏分组' });
const groupRow = (page: Page, label: string) => tree(page).getByRole('button', { name: new RegExp(`(^|/ )${label}，直属`) });
const hint = (page: Page) => page.getByTestId('drop-hint');

/** Presses on `from` and moves just past the 6 px that starts a drag (a click below that stays a click). */
async function pick(page: Page, from: Locator, x = 24) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + x, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + x + 6, a.y + a.height / 2 + 8, { steps: 4 });
}
/** Moves over `to`: its top edge, middle or bottom edge (where on a tree row decides before / inside / after). */
async function over(page: Page, to: Locator, at: 'top' | 'middle' | 'bottom' = 'middle') {
  const b = (await to.boundingBox())!;
  const y = at === 'top' ? b.y + 3 : at === 'bottom' ? b.y + b.height - 3 : b.y + b.height / 2;
  await page.mouse.move(b.x + Math.min(48, b.width / 2), y, { steps: 12 });
}
/** Evidence screenshots for the delivery record: E2E_FAV_EVIDENCE=<directory> writes them there. */
const evidence = async (page: Page, name: string) => {
  const dir = process.env.E2E_FAV_EVIDENCE;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name) });
};

test('N4/B06: groups dragged in the tree — beside a sibling, into a group; refused drops say why; a reload shows the same tree', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'a phone moves groups with the ⋯ menu (see the B11 test)');
  const api = page.request;
  const tag = freshTag();
  const [a, b] = [`da${tag}`, `db${tag}`];
  await ops(api, [
    { type: 'group.create', group: { id: a, label: '拖动甲', parentId: null } },
    { type: 'group.create', group: { id: b, label: '拖动乙', parentId: null } },
  ]);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/settings/favorites');
  await expect(groupRow(page, '拖动乙')).toBeVisible();
  const roots = await siblings(api, null);
  expect(roots.indexOf(b)).toBe(roots.indexOf(a) + 1);

  // 乙 onto the top edge of 甲: same level, in front of it.
  await pick(page, groupRow(page, '拖动乙'));
  await over(page, groupRow(page, '拖动甲'), 'top');
  await expect(hint(page)).toHaveText('松开后：把「拖动乙」放到「拖动甲」前面（顶层）');
  await expect(tree(page).locator('[data-drop="before"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: '已调整「拖动乙」的位置' })).toBeVisible();
  await expect.poll(async () => { const r = await siblings(api, null); return r.indexOf(b) === r.indexOf(a) - 1; }).toBe(true);
  await page.getByRole('button', { name: '关闭提示' }).click();

  // 乙 onto the middle of 甲: a subgroup of it. The drop hint while hovering is the evidence shot.
  await pick(page, groupRow(page, '拖动乙'));
  await over(page, groupRow(page, '拖动甲'), 'middle');
  await expect(hint(page)).toHaveText('松开后：把「拖动乙」放进「拖动甲」，作为子分组');
  await expect(tree(page).locator('[data-drop="inside"]')).toHaveCount(1);
  await evidence(page, 'fav-drag-tree.png');
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: '已把「拖动乙」移到「拖动甲 / 拖动乙」' })).toBeVisible();
  await expect.poll(async () => (await categories(api)).find((c) => c.id === b)?.parentId).toBe(a);

  // 甲 into its own subgroup: shown as refused while hovering, sent anyway — group.move refuses it in its own words.
  const before = await categories(api);
  await pick(page, groupRow(page, '拖动甲'));
  await over(page, groupRow(page, '拖动乙'), 'middle');
  await expect(hint(page)).toHaveText('不能放在这里：不能移到它自己或它的子分组里');
  await expect(tree(page).locator('[data-drop="inside-refused"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: /^不能移到它自己或它的子分组里$/ })).toBeVisible();
  // A system view is no place for a group: nothing happens over 回收站.
  await pick(page, groupRow(page, '拖动甲'));
  await over(page, tree(page).getByRole('button', { name: /^回收站/ }));
  await expect(hint(page)).toHaveText(/拖到分组的上部或下部/);
  await page.mouse.up();
  expect(await categories(api)).toEqual(before);

  // Reopened (another device reads the same): the same tree.
  await page.reload();
  await expect(tree(page).getByRole('button', { name: /^拖动甲 \/ 拖动乙，直属/ })).toBeVisible();
  expect((await categories(api)).find((c) => c.id === b)?.parentId).toBe(a);
});

test('N2: favorites dragged onto a group — the selected ones go along; onto 未分组 too; the words of 移动到分组…', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'a phone moves favorites with 移动到分组…');
  const api = page.request;
  const tag = freshTag();
  const [a, b] = [`ia${tag}`, `ib${tag}`];
  await ops(api, [
    { type: 'group.create', group: { id: a, label: '来源组', parentId: null } },
    { type: 'group.create', group: { id: b, label: '目标组', parentId: null } },
  ]);
  const q = `拖到分组${tag}`;
  const [one, two, three] = [await create(api, `${q}一`, a), await create(api, `${q}二`, a), await create(api, `${q}三`, a)];
  try {
    await page.goto(`/settings/favorites?view=group:${a}`);
    const list = page.getByRole('listbox', { name: /（3 条）$/ });
    await expect(list).toBeVisible();
    // Two selected, one of them dragged by its grip onto 目标组: both go.
    await list.getByRole('checkbox', { name: `选择 ${one.title}` }).click();
    await list.getByRole('checkbox', { name: `选择 ${two.title}` }).click();
    await pick(page, list.getByRole('button', { name: `拖动以排序「${two.title}」（也可用空格键拿起后按方向键）` }), 12);
    await over(page, groupRow(page, '目标组'));
    await expect(hint(page)).toHaveText('松开后：把 2 个收藏移到「目标组」');
    await page.mouse.up();
    await expect(page.getByRole('status').filter({ hasText: '已把 2 个收藏移到「目标组」' })).toBeVisible();

    // From 全部收藏, by its name, onto 未分组.
    await page.goto('/settings/favorites');
    const all = page.getByRole('listbox', { name: /全部收藏（\d+ 条）/ });
    await pick(page, all.getByRole('button', { name: `编辑「${three.title}」` }));
    await over(page, tree(page).getByRole('button', { name: /^未分组/ }));
    await expect(hint(page)).toHaveText(`松开后：把「${three.title}」移到「未分组」`);
    await page.mouse.up();
    await expect(page.getByRole('status').filter({ hasText: '已移到「未分组」' })).toBeVisible();

    // A click on the name is still a click: the editor opens, nothing moves.
    await all.getByRole('button', { name: `编辑「${one.title}」` }).click();
    await expect(page.getByRole('dialog', { name: `编辑「${one.title}」` })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.reload();
    const after = Object.fromEntries((await search(api, q)).map((i) => [i.title, i.folderId]));
    expect(after).toEqual({ [one.title]: b, [two.title]: b, [three.title]: 'none' });
  } finally {
    await clean(api, q);
  }
});

test('B10: the grid sorts by drag in a group — the same order the list and 上移 / 下移 use', async ({ home: page, isMobile }) => {
  test.skip(isMobile, 'no grid on a phone');
  const api = page.request;
  const tag = freshTag();
  const g = `gg${tag}`;
  await ops(api, [{ type: 'group.create', group: { id: g, label: '网格组', parentId: null } }]);
  const q = `网格排序${tag}`;
  const made = [await create(api, `${q}甲`, g), await create(api, `${q}乙`, g), await create(api, `${q}丙`, g)];
  const order = async () => (await search(api, q)).sort((x, y) => x.position - y.position || (x.id < y.id ? -1 : 1)).map((i) => i.title);
  try {
    await page.goto(`/settings/favorites?view=group:${g}`);
    await page.getByRole('radio', { name: '网格' }).click();
    const grid = page.getByRole('list', { name: /网格组，3 项/ });
    await expect(grid.locator('[data-card]')).toHaveCount(3);
    // 丙's grip onto 甲's card: 丙 first.
    await pick(page, grid.getByRole('button', { name: `拖动以排序「${made[2]!.title}」（也可用空格键拿起后按方向键）` }), 12);
    await over(page, grid.locator(`[data-card="${made[0]!.id}"]`));
    await page.mouse.up();
    await expect(page.getByRole('status').filter({ hasText: `已移动「${made[2]!.title}」` })).toBeVisible();
    await expect.poll(order).toEqual([`${q}丙`, `${q}甲`, `${q}乙`]);
    // And from the keyboard: Space picks up 甲, → moves it one card on, Space puts it down.
    await page.reload();
    await grid.getByRole('button', { name: `拖动以排序「${made[0]!.title}」（也可用空格键拿起后按方向键）` }).focus();
    // (A beat between keys: the sensor starts listening for the arrows on the next tick.)
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await page.keyboard.press('Space');
    await expect.poll(order).toEqual([`${q}丙`, `${q}乙`, `${q}甲`]);
    // The list shows the same order after a reload.
    await page.getByRole('radio', { name: '列表' }).click();
    await expect(page.getByRole('listbox', { name: /（3 条）$/ }).getByRole('option')).toHaveText([new RegExp(`${q}丙`), new RegExp(`${q}乙`), new RegExp(`${q}甲`)]);
  } finally {
    await clean(api, q);
  }
});
