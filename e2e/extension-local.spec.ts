/// <reference types="chrome" />
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 此扩展的本地收藏 (v0.5 · U1, 06-ACCEPTANCE L02/L17): a fresh install, never paired. The new tab is a
 * usable home, and the popup, the context menu and the new tab all work on the one collection kept
 * in the extension — saves made at the same moment are all kept. No server is involved; the e2e
 * server only serves an ordinary web page to collect.
 */
const PORT = Number(process.env.E2E_PORT) || 8790;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EXT_DIR = resolve(import.meta.dirname, '../apps/chrome-extension');
const BUILD = join(EXT_DIR, 'dist-test');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extId: string;
let profile: string;

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve(EXT_DIR, '../../node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], {
    cwd: EXT_DIR,
    env: { ...process.env, NEXUS_EXT_OUT: 'dist-test', NEXUS_EXT_TEST_HOSTS: 'http://127.0.0.1/*' },
    stdio: 'inherit',
  });
  profile = mkdtempSync(join(tmpdir(), 'nexus-ext-local-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.E2E_EXT_CHANNEL ?? 'chromium',
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${BUILD}`, `--load-extension=${BUILD}`],
  });
  // The extension's own worker (by URL), never whichever service worker the context lists first.
  const ours = (w: { url(): string }) => w.url().startsWith('chrome-extension://');
  const worker = context.serviceWorkers().find(ours) ?? (await context.waitForEvent('serviceworker', { predicate: ours }));
  extId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
});

async function localItems(): Promise<{ title: string; url: string }[]> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  const rows = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('nexus-local');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const state = await new Promise<{ rows: Record<string, { title: string; url: string; deletedAt: number | null }> } | undefined>((res) => {
      const g = db.transaction('kv').objectStore('kv').get('state');
      g.onsuccess = () => res(g.result);
    });
    return Object.values(state?.rows ?? {})
      .filter((r) => r.deletedAt === null)
      .map((r) => ({ title: r.title, url: r.url }));
  });
  await page.close();
  return rows;
}

test('L02: a fresh install welcomes with a usable new tab — no pairing asked first', async () => {
  const options = context.pages().find((p) => p.url().includes('options.html')) ?? (await context.waitForEvent('page', (p) => p.url().includes('options.html')));
  await expect(options.getByRole('heading', { name: '欢迎使用 Nexus 新标签页' })).toBeVisible();
  await expect(options.getByText('新标签页已经可以使用')).toBeVisible();
  const tab = await context.newPage();
  await tab.goto('chrome://newtab/');
  await expect(tab.getByLabel('搜索', { exact: true })).toBeVisible();
  // The pill says where the collection is: this extension, nothing of any account.
  await expect(tab.getByRole('link', { name: /^保存状态：仅此设备。收藏只保存在此扩展/ })).toBeVisible();
  await expect(tab.getByText('连接 Nexus Portal')).toHaveCount(0);
});

test('L02: the popup saves the current page into this extension, and says so once it is stored', async () => {
  const target = await context.newPage();
  const url = `${ORIGIN}/api/v2/catalog?for=popup`;
  await target.goto(url);
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extId}/options.html`);
  const tabId = await helper.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.getByLabel('标题').fill('Popup 保存的页面');
  await popup.getByRole('button', { name: '保存', exact: true }).click();
  await expect(popup.getByRole('status')).toHaveText('已保存到此扩展的本地收藏');
  expect(await localItems()).toContainEqual({ title: 'Popup 保存的页面', url });
  // The same page again: shown as already saved, and saving updates it — no second copy.
  await popup.reload();
  await expect(popup.getByText(/已在收藏里/)).toBeVisible();
});

test('L02/L17: the context menu saves into the same collection; simultaneous saves are all kept', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  const first = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'test:menu', info: { menuItemId: 'nexus-save-link', linkUrl: 'https://example.org/from-menu' }, tab: { title: '某页', url: 'https://example.org/page' } }));
  expect(first).toMatchObject({ persisted: true, state: 'saved' });
  const again = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'test:menu', info: { menuItemId: 'nexus-save-link', linkUrl: 'https://example.org/from-menu' }, tab: { title: '某页', url: 'https://example.org/page' } }));
  expect(again).toMatchObject({ state: 'duplicate' });
  const ok = await page.evaluate(async () => {
    const jobs: Promise<{ ok?: boolean; persisted?: boolean } | undefined>[] = [];
    for (let i = 0; i < 10; i++) jobs.push(chrome.runtime.sendMessage({ type: 'test:menu', info: { menuItemId: 'nexus-save-link', linkUrl: `https://menu.example.org/${i}` }, tab: { title: 't', url: 'https://example.org/' } }));
    for (let i = 0; i < 10; i++) {
      const opId = `ext-e2e-concurrent-${String(i).padStart(6, '0')}`;
      jobs.push(chrome.runtime.sendMessage({ type: 'local:save', opId, body: { opId, source: 'extension', item: { kind: 'page', title: `并发 ${i}`, url: `https://popup.example.org/${i}`, tags: [] }, pinToHome: false, duplicatePolicy: 'prompt' } }));
    }
    return (await Promise.all(jobs)).filter((r) => r?.ok || r?.persisted).length;
  });
  expect(ok).toBe(20);
  const items = await localItems();
  // The extension's new collection started with the eight 常用网站 (UI v2 N3), then these saves.
  expect(items.slice(0, 8).map((i) => i.url)).toEqual(['https://www.google.com', 'https://www.youtube.com', 'https://github.com', 'https://mail.google.com', 'https://www.bing.com', 'https://www.bilibili.com', 'https://chatgpt.com', 'https://zh.wikipedia.org']);
  expect(items).toHaveLength(8 + 1 + 1 + 20);
  // The new tab shows them (收藏 inside the extension, not the website).
  const tab = await context.newPage();
  // (The old #/library link lands on 我的收藏 inside the extension.)
  await tab.goto(`chrome-extension://${extId}/newtab.html#/library`);
  await tab.getByRole('searchbox', { name: '搜索我的收藏' }).fill('并发 7');
  await expect(tab.getByRole('listbox', { name: /（\d+ 条）$/ }).getByText('并发 7')).toBeVisible();
});
