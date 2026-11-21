import { join } from 'node:path';
import { expect, test } from './fixtures';

/**
 * 收藏库 (NP-04/05, EX-05) on the built app: 5000 items, windowed rows, search, keyboard,
 * multi-select batch actions, trash and restore, bookmark import with preview and undo, export.
 */
const H = { 'X-Nexus-Client': '1' };
const shot = async (page: import('@playwright/test').Page, name: string) => {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};

test('5000 items: light DOM, search, keyboard, batch move, delete/restore, import and undo, export', async ({ home, isMobile }, info) => {
  test.setTimeout(120_000);
  const page = home;
  const api = page.request;
  // Synthetic collection: 5000 pages with predictable names, a few tagged.
  // Unique per run: the shared e2e server keeps what an earlier project's run left (edited items survive an undo).
  const run = `${info.project.name}-${Date.now().toString(36)}`;
  const items = Array.from({ length: 5000 }, (_, i) => ({ kind: 'page', title: `合成收藏 ${String(i).padStart(4, '0')}`, url: `https://synthetic.example.org/${run}/p/${i}?ref=${i % 7}#s${i % 3}`, tags: i % 500 === 0 ? ['抽样'] : [] }));
  const imported = await (await api.post('/api/v2/import', { headers: H, data: { opId: `e2e-big-${Date.now()}`, items } })).json();
  expect(imported.imported).toBe(5000);
  try {
    await page.goto('/library');
    await expect(page.getByRole('heading', { name: '收藏库' })).toBeVisible();
    const list = page.getByRole('listbox', { name: /收藏（\d+ 条）/ });
    await expect(list).toHaveAttribute('aria-label', /收藏（50\d\d 条）/);
    // Windowed: a few dozen rows in the document, not 5000.
    const rows = await list.getByRole('option').count();
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBeLessThan(120);
    await shot(page, `library-${info.project.name}`);

    // Search (personal collection only), timed in the page.
    const t0 = Date.now();
    await page.getByRole('textbox', { name: '搜索收藏库' }).fill('合成收藏 4321');
    await expect(list).toHaveAttribute('aria-label', '收藏（1 条）');
    const searchMs = Date.now() - t0;
    test.info().annotations.push({ type: 'search-5000-ms', description: String(searchMs) });
    await page.getByRole('textbox', { name: '搜索收藏库' }).fill('');

    // Tag filter, then keyboard: ↓ ↓ Space selects exactly the third row.
    await page.getByRole('button', { name: /#抽样/ }).click();
    await expect(list).toHaveAttribute('aria-label', '收藏（10 条）');
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(' ');
    // (Scoped to the list: the batch bar's <select> has a selected <option> of its own.)
    await expect(list.getByRole('option', { selected: true })).toHaveCount(1);
    await expect(list.getByRole('option', { selected: true })).toContainText('合成收藏 1000');

    // Batch: shift-click selects a range (1500…2500 in this filtered list), then move them together.
    await page.getByRole('checkbox', { name: '选择 合成收藏 1500' }).click();
    await page.getByRole('checkbox', { name: '选择 合成收藏 2500' }).click({ modifiers: ['Shift'] });
    // 1000 (keyboard) + the range 1500…2500 (shift-click) = 4.
    await expect(page.getByRole('region', { name: '批量操作' })).toContainText('已选 4 条');
    await expect(list.getByRole('option', { selected: true })).toHaveText([/合成收藏 1000/, /合成收藏 1500/, /合成收藏 2000/, /合成收藏 2500/]);
    const target = await page.getByRole('combobox', { name: '批量移动到分组' }).locator('option').nth(1).getAttribute('value');
    await page.getByRole('combobox', { name: '批量移动到分组' }).selectOption(target!);
    await page.getByRole('button', { name: '移动', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已移动：4 条' })).toBeVisible();
    await expect.poll(async () => ((await (await api.get(`/api/v2/items?url=${encodeURIComponent(`https://synthetic.example.org/${run}/p/2500?ref=1#s1`)}`)).json()).items[0]?.folderId)).toBe(target);

    // Delete one → trash → restore.
    await page.getByRole('checkbox', { name: '选择 合成收藏 2000' }).click();
    await page.getByRole('button', { name: '删除' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已移入回收站 1 条' })).toBeVisible();
    await expect(list).toHaveAttribute('aria-label', '收藏（9 条）');
    if (isMobile) await page.getByRole('combobox', { name: '收藏库分组' }).selectOption('{"kind":"trash"}');
    else await page.getByRole('navigation', { name: '收藏库分组' }).getByRole('button', { name: /回收站/ }).click();
    await expect(list.getByRole('option').filter({ hasText: '合成收藏 2000' })).toBeVisible();
    await list.getByRole('option').filter({ hasText: '合成收藏 2000' }).getByRole('button', { name: '恢复' }).click();
    await expect(list.getByRole('option').filter({ hasText: '合成收藏 2000' })).toHaveCount(0);

    // Import a bookmarks file: preview, import, then undo the import.
    if (isMobile) await page.getByRole('combobox', { name: '收藏库分组' }).selectOption('{"kind":"all"}');
    else await page.getByRole('navigation', { name: '收藏库分组' }).getByRole('button', { name: /^全部/ }).click();
    await page.getByRole('button', { name: '导入' }).click();
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>工作</H3><DL><p><DT><A HREF="https://e2e-import.example.org/a?x=1#y">导入甲</A><DT><A HREF="https://e2e-import.example.org/b">导入乙</A><DT><A HREF="javascript:void(0)">小工具</A></DL><p></DL>`;
    await page.getByLabel('选择要导入的文件').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    const preview = page.getByLabel('导入预览');
    await expect(preview).toContainText('可导入2');
    await expect(preview).toContainText('不支持的地址（跳过）1');
    await shot(page, `library-import-${info.project.name}`);
    await page.getByRole('button', { name: '导入 2 条' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已导入 2 条' })).toBeVisible();
    await page.getByRole('button', { name: '撤销本次导入' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已撤销导入：移入回收站 2 条' })).toBeVisible();

    // Export: a file with folders, tags and pins.
    if (!isMobile) {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^nexus-collection-\d{4}-\d{2}-\d{2}\.json$/);
    }
  } finally {
    // Leave nothing behind for the next project: undo the import, then remove what was edited (undo keeps those).
    await api.post(`/api/v2/import/${imported.importId}/undo`, { headers: H, data: { opId: `e2e-undo-${Date.now()}` } });
    for (;;) {
      const left = (await (await api.get(`/api/v2/items?q=${encodeURIComponent(run)}&limit=200`)).json()).items as { id: string }[];
      if (!left.length) break;
      for (const i of left) await api.delete(`/api/v2/items/${i.id}?opId=e2e-clean-${i.id}-${Date.now()}`, { headers: H });
    }
  }
});
