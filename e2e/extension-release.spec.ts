/// <reference types="chrome" />
import { expect, test } from '@playwright/test';
import { account, contextMenuSave, extensionPage, itemsOf, launch, openPopup, ORIGIN, PAGES, pair, pause, popupSave, queue, startStack, stopWorker, uia, workerRunning, type Account, type Browser, type Channel, type Stack } from './release/harness';

/**
 * 生产扩展包实装（NEX-05 · CC-NEXT §5）：`npm run package` 产出的 zip 原样解压装进真实浏览器
 * （Chromium / Google Chrome / Microsoft Edge，见 playwright.release.config.ts），不用测试构建、
 * 不用测试钩子、不预授权站点访问。站点访问提示、原生右键菜单与工具栏弹窗经 Windows UI Automation
 * 操作（e2e/release/uia.ps1）；服务端、身份服务、账号与网页全是本机合成的。
 *
 * 覆盖：右键收藏（链接与当前页面）、弹窗保存、后台 service worker 经 CDP 停止 / 唤醒、两次快速
 * 收藏、请求已到服务端但回答丢失时后台被停止、离线后换账号、撤销后草稿须确认、双 profile、
 * 同一网址不同路径、查询参数与锚点保留。
 */
test.describe.configure({ mode: 'serial' });
test.skip(process.platform !== 'win32', '浏览器自己的对话框与右键菜单经 Windows UI Automation 操作');

const channel = () => test.info().project.name as Channel;
let stack: Stack;
let A: Account;
let B: Account;
let one: Browser;
let two: Browser | null = null;
let aId = '';

test.beforeAll(async () => {
  stack = await startStack();
  A = await account('e2e-a', 'a@e2e.example.test');
  B = await account('e2e-b', 'b@e2e.example.test');
  aId = ((await (await A.api.get('/api/v2/me')).json()) as { account: { id: string } }).account.id;
  one = await launch(channel(), 'one');
});

test.afterAll(async () => {
  await two?.close().catch(() => undefined);
  await one?.close().catch(() => undefined);
  await stack?.stop();
});

const command = (b: Browser, msg: unknown) => extensionPage(b).then((p) => p.evaluate((m) => chrome.runtime.sendMessage(m), msg));

test('安装发布包：站点访问在浏览器自己的提示里「允许」，按账号 A 连接', async () => {
  expect(one.extId).toMatch(/^[a-p]{32}$/);
  // Chrome's zip keeps manifest.key (a stable id); Edge's has none (its store assigns one).
  if (channel() !== 'msedge') expect(one.extId).toBe('fofncjblmjaocmkmmkdnjdejkgjelcck');
  await pair(one, A);
  const page = await extensionPage(one);
  expect(await page.evaluate(async () => (await chrome.permissions.getAll()).origins)).toEqual([`${ORIGIN}/*`]);
  expect(await page.evaluate(async () => ((await chrome.storage.local.get('server')).server as { account?: { label: string } }).account?.label)).toBe(A.email);
});

test('右键「收藏此链接」保存链接本身，查询参数与锚点原样；同一网址不同路径是两条；「收藏当前页面」保存标签页地址', async () => {
  const page = await one.context.newPage();
  await page.goto(`${PAGES}/article/one?ref=a#part-1`);
  expect((await contextMenuSave(one, page, '#query', '收藏此链接到 Nexus')).ok).toBe(true);
  await expect.poll(async () => (await itemsOf(A, 'https://docs.example.org/guide/install?id=7&x=1#step-2'))[0]?.url, { timeout: 15_000 }).toBe('https://docs.example.org/guide/install?id=7&x=1#step-2');
  expect((await contextMenuSave(one, page, '#path-a', '收藏此链接到 Nexus')).ok).toBe(true);
  expect((await contextMenuSave(one, page, '#path-b', '收藏此链接到 Nexus')).ok).toBe(true);
  await expect
    .poll(async () => (await itemsOf(A)).filter((i) => i.url.startsWith('https://same.example.org/')).map((i) => i.url).sort(), { timeout: 15_000 })
    .toEqual(['https://same.example.org/a/page?v=1', 'https://same.example.org/b/page?v=1']);
  expect((await contextMenuSave(one, page, null, '收藏当前页面到 Nexus')).ok).toBe(true);
  await expect.poll(async () => (await itemsOf(A, `${PAGES}/article/one?ref=a#part-1`))[0]?.source, { timeout: 15_000 }).toBe('extension');
  // The page the link was on is not what 收藏此链接 saved.
  expect((await itemsOf(A)).filter((i) => i.url.startsWith(PAGES))).toHaveLength(1);
  await page.close();
});

test('工具栏弹窗（真实弹窗）保存：只有服务端确认后才说「已同步到账号里的「我的收藏」」', async () => {
  const page = await one.context.newPage();
  const url = `${PAGES}/article/popup?x=1#y`;
  await page.goto(url);
  const r = await popupSave(one, page, { title: '弹窗保存的文章', tags: '扩展，测试' });
  expect(r.out).toContain('已同步到账号里的「我的收藏」');
  expect((await itemsOf(A, url))[0]).toMatchObject({ title: '弹窗保存的文章', source: 'extension' });
  await page.keyboard.press('Escape');
  await page.close();
});

test('两次快速收藏（弹窗的保存命令同时两次，紧接着右键）：都持久化、都只创建一次', async () => {
  const replies = (await (await extensionPage(one)).evaluate(() =>
    Promise.all([
      chrome.runtime.sendMessage({ type: 'queue:save', opId: 'ext-quick-0000000000000001', capture: { title: '快速一', url: 'https://quick.example.org/one' } }),
      chrome.runtime.sendMessage({ type: 'queue:save', opId: 'ext-quick-0000000000000002', capture: { title: '快速二', url: 'https://quick.example.org/two' } }),
    ]),
  )) as { persisted: boolean; entry?: { state: string } }[];
  expect(replies.map((r) => r.persisted)).toEqual([true, true]);
  const page = await one.context.newPage();
  await page.goto(`${PAGES}/article/quick`);
  expect((await contextMenuSave(one, page, '#quick-3', '收藏此链接到 Nexus')).ok).toBe(true);
  await expect.poll(async () => (await itemsOf(A)).filter((i) => i.url.startsWith('https://quick.example.org/')).length, { timeout: 15_000 }).toBe(3);
  await expect.poll(async () => (await queue(one)).filter((e) => e.url.startsWith('https://quick.example.org/') && e.state === 'saved').length, { timeout: 15_000 }).toBe(3);
  await page.close();
});

test('后台 service worker 经 CDP 停止后：右键菜单把它唤醒，照常保存', async () => {
  expect(await stopWorker(one)).toBe(true);
  expect(await workerRunning(one)).toBe(false);
  const page = await one.context.newPage();
  await page.goto(`${PAGES}/article/wake`);
  expect((await contextMenuSave(one, page, '#wake', '收藏此链接到 Nexus')).ok).toBe(true);
  await expect.poll(async () => (await itemsOf(A, 'https://wake.example.org/after-stop')).length, { timeout: 20_000 }).toBe(1);
  expect(await workerRunning(one)).toBe(true);
  await page.close();
});

test('请求已到服务端、回答回来之前后台被停止：重启后用原 opId 重发，服务端只创建一次', async () => {
  const url = 'https://lost-answer.example.org/x?y=1#z';
  const opId = 'ext-lost-answer-0000000001';
  stack.proxy.hold = (req) => req.method === 'POST' && req.url === '/api/v2/items';
  const answered = command(one, { type: 'queue:save', opId, capture: { title: '回答丢失', url } }).catch((e: Error) => ({ error: e.message }));
  await expect.poll(() => stack.proxy.requests.filter((r) => r.opId === opId).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await itemsOf(A, url)).length, { timeout: 15_000 }).toBe(1);
  expect(await stopWorker(one)).toBe(true);
  stack.proxy.hold = null;
  for (const release of stack.proxy.held.splice(0)) release();
  await answered;
  expect((await queue(one)).find((e) => e.opId === opId)).toMatchObject({ state: 'pending' });
  // Woken by a message from one of its pages (what the popup or a new tab does).
  await command(one, { type: 'flush' });
  expect(await workerRunning(one)).toBe(true);
  await expect.poll(async () => (await queue(one)).find((e) => e.opId === opId)?.state, { timeout: 20_000 }).toBe('saved');
  expect(stack.proxy.requests.filter((r) => r.opId === opId).length).toBe(2);
  expect(await itemsOf(A, url)).toHaveLength(1);
});

test('离线时用弹窗保存（只在本机），之后换成账号 B：A 的保存不会用 B 的令牌发出', async () => {
  const url = `${PAGES}/article/offline?id=9#x`;
  stack.proxy.offline = true;
  const page = await one.context.newPage();
  await page.goto(url);
  const r = await popupSave(one, page, { title: 'A 离线时存的' });
  expect(r.out).toContain('已保存在此设备');
  await page.keyboard.press('Escape');
  const pending = (await queue(one)).find((e) => e.url === url)!;
  expect(pending).toMatchObject({ state: 'pending', account: aId });
  stack.proxy.offline = false;
  await pair(one, B, { switching: true });
  await command(one, { type: 'flush' });
  await pause(1500);
  expect(await itemsOf(B, url)).toEqual([]);
  // A's token was replaced when B connected: the save waits for A, it is not sent anywhere else.
  expect(await itemsOf(A, url)).toEqual([]);
  expect((await queue(one)).find((e) => e.opId === pending.opId)).toMatchObject({ state: 'pending', account: aId });
  // What is saved now goes to B.
  const other = await one.context.newPage();
  await other.goto(`${PAGES}/article/as-b`);
  expect((await contextMenuSave(one, other, '#path-a', '收藏此链接到 Nexus')).ok).toBe(true);
  await expect.poll(async () => (await itemsOf(B, 'https://same.example.org/a/page?v=1')).length, { timeout: 15_000 }).toBe(1);
  await other.close();
  await page.close();
});

test('门户里撤销此设备后再收藏：后台发送遇到 401 立即标记已撤销并提示重新连接；未发送的都成草稿（不删除、不换账号），重新连接后要确认才发送', async () => {
  const url = `${PAGES}/article/revoked?k=1#r`;
  const menuUrl = 'https://same.example.org/b/page?v=1';
  stack.proxy.offline = true;
  const page = await one.context.newPage();
  await page.goto(url);
  expect((await popupSave(one, page, { title: 'B 离线时存的' })).out).toContain('已保存在此设备');
  await page.keyboard.press('Escape');
  stack.proxy.offline = false;
  for (const d of (await (await B.api.get('/api/devices')).json()) as { id: string }[]) await B.api.delete(`/api/devices/${d.id}`);
  // A save right after: the background's own send gets 401 — it is known now, no new tab needed.
  expect((await contextMenuSave(one, page, '#path-b', '收藏此链接到 Nexus')).ok).toBe(true);
  const opt = await extensionPage(one);
  await expect.poll(async () => opt.evaluate(async () => ((await chrome.storage.local.get('server')).server as { revoked?: boolean }).revoked), { timeout: 15_000 }).toBe(true);
  expect(await opt.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
  expect(await opt.evaluate(() => chrome.action.getTitle({}))).toContain('授权已被撤销，请重新连接');
  await expect(opt.getByText('此设备的授权已失效')).toBeVisible({ timeout: 15_000 });
  // Nothing unsent was deleted, and each keeps the account it was saved for.
  await expect
    .poll(async () => (await queue(one)).filter((e) => e.state === 'draft').map((e) => e.url).sort(), { timeout: 15_000 })
    .toEqual([`${PAGES}/article/offline?id=9#x`, url, menuUrl].sort());
  expect(await itemsOf(B, url)).toEqual([]);
  // Connect again (as B): drafts are not sent by themselves…
  await pair(one, B, { prompt: false });
  await command(one, { type: 'flush' });
  await pause(1500);
  expect(await itemsOf(B, url)).toEqual([]);
  // …the popup asks about B's two (A's offline save is not offered to B), and only 保存到这个账号 sends them.
  // (The popup renders 「有 2 条授权前存下的草稿…」 as several text nodes: its button is waited for.)
  expect((await queue(one)).filter((e) => e.state === 'draft' && e.url !== `${PAGES}/article/offline?id=9#x`)).toHaveLength(2);
  expect((await openPopup(one, page, '^保存到这个账号$')).ok).toBe(true);
  expect((await uia(one, ['保存到这个账号'], { type: 'Button' })).ok).toBe(true);
  await expect.poll(async () => (await itemsOf(B, url)).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await itemsOf(B, menuUrl)).length, { timeout: 15_000 }).toBe(1);
  expect(await itemsOf(B, `${PAGES}/article/offline?id=9#x`)).toEqual([]);
  expect((await queue(one)).find((e) => e.url === `${PAGES}/article/offline?id=9#x`)).toMatchObject({ state: 'draft' });
  await page.keyboard.press('Escape');
  await page.close();
});

test('双 profile：两个独立配置的浏览器各连一个账号，各自的保存只进各自的账号，队列互不相见', async () => {
  two = await launch(channel(), 'two');
  await pair(two, A);
  const url = 'https://profiles.example.org/same?x=1#y';
  const p2 = await two.context.newPage();
  await p2.goto(`${PAGES}/article/profile-two`);
  expect((await contextMenuSave(two, p2, '#profiles', '收藏此链接到 Nexus')).ok).toBe(true);
  const p1 = await one.context.newPage();
  await p1.goto(`${PAGES}/article/profile-one`);
  expect((await contextMenuSave(one, p1, '#profiles', '收藏此链接到 Nexus')).ok).toBe(true);
  // The same address, saved in two profiles: one item in each account, none crossed over.
  await expect.poll(async () => (await itemsOf(A, url)).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await itemsOf(B, url)).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await queue(two!)).find((e) => e.url === url)?.state, { timeout: 15_000 }).toBe('saved');
  expect((await queue(two)).find((e) => e.url === url)?.account).toBe(aId);
  const mine = (await queue(one)).map((e) => e.opId);
  expect((await queue(two)).some((e) => mine.includes(e.opId))).toBe(false);
  await p1.close();
  await p2.close();
});
