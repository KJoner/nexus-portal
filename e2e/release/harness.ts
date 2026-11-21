/// <reference types="chrome" />
import { chromium, request, type APIRequestContext, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Release-package extension tests (NEX-05 · 生产扩展包实装): the zip `npm run package` produces,
 * unpacked unchanged and loaded into a real browser — no test build, no test hooks, no
 * pre-granted host access. What a person does in the browser's own UI (the site-access prompt,
 * the native context menu, the toolbar popup) goes through Windows UI Automation (uia.ps1).
 *
 * Everything runs on 127.0.0.1 with synthetic accounts: a test identity provider (idp.mts), a
 * Nexus server on a throw-away SQLite data directory, a proxy in front of it (to be "offline" or
 * to hold an answer while the background is stopped), and a page with links to save.
 */
export const ROOT = resolve(import.meta.dirname, '../..');
const EXT = join(ROOT, 'apps/chrome-extension');
export const BASE = Number(process.env.E2E_REL_BASE_PORT ?? 39540);
export const PORTS = { nexus: BASE + 1, idp: BASE + 2, proxy: BASE + 3, pages: BASE + 4 };
export const ORIGIN = `http://127.0.0.1:${PORTS.proxy}`;
const NEXUS = `http://127.0.0.1:${PORTS.nexus}`;
export const PAGES = `http://127.0.0.1:${PORTS.pages}`;
const IDP = `http://127.0.0.1:${PORTS.idp}`;
export const WORK = process.env.E2E_REL_WORK ?? mkdtempSync(join(tmpdir(), 'nexus-release-e2e-'));
mkdirSync(WORK, { recursive: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await wait(200);
  }
  throw new Error(`${url} 没有启动`);
}

// ── processes ──────────────────────────────────────────────────────────────
export interface Stack {
  stop(): Promise<void>;
  proxy: ProxyControl;
  dataDir: string;
}

export interface ProxyControl {
  /** Refuse every connection (server unreachable, as when offline). */
  offline: boolean;
  /** Hold the answers of matching requests (the request reaches the server, the answer does not leave). */
  hold: ((req: IncomingMessage) => boolean) | null;
  held: (() => void)[];
  requests: { method: string; path: string; opId?: string }[];
}

/** The test IdP, a Nexus server on a fresh data directory, the proxy and the page server. */
export async function startStack(): Promise<Stack> {
  const dataDir = mkdtempSync(join(WORK, 'data-'));
  const children: ChildProcess[] = [];
  children.push(spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'e2e/release/idp.mts'), String(PORTS.idp)], { cwd: ROOT, stdio: 'inherit' }));
  await until(`${IDP}/realms/accounts/.well-known/openid-configuration`);
  children.push(
    spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Not "production": only so that the test IdP may be plain http (allowHttp); the server is the built one.
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(PORTS.nexus),
        NEXUS_DATA_DIR: dataDir,
        NEXUS_WEB_DIST: join(ROOT, 'apps/web/dist'),
        NEXUS_PASSWORD: 'e2e-legacy-password',
        NEXUS_SECRET: 'e2e-release-secret-0123456789',
        NEXUS_PUBLIC_URL: ORIGIN,
        NEXUS_OIDC_ISSUER: `${IDP}/realms/accounts`,
        NEXUS_OIDC_CLIENT_ID: 'nexus-web',
        NEXUS_OIDC_CLIENT_SECRET: 'e2e-client-secret',
        NEXUS_REGISTRATION_MODE: 'open',
        NEXUS_MAIL_PROVIDER: 'log',
      },
    }),
  );
  await until(`${NEXUS}/api/healthz`);
  const proxy: ProxyControl = { offline: false, hold: null, held: [], requests: [] };
  const proxyServer = createServer((req, res) => forward(proxy, req, res));
  proxyServer.on('connection', (socket) => {
    if (proxy.offline) socket.destroy();
  });
  const pages = createServer(servePage);
  await Promise.all([listen(proxyServer, PORTS.proxy), listen(pages, PORTS.pages)]);
  return {
    proxy,
    dataDir,
    async stop() {
      for (const r of proxy.held.splice(0)) r();
      await Promise.all([close(proxyServer), close(pages)]);
      for (const c of children) c.kill();
      await wait(300);
    },
  };
}

const listen = (s: Server, port: number) => new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
const close = (s: Server) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())));

function forward(proxy: ProxyControl, req: IncomingMessage, res: ServerResponse) {
  if (proxy.offline) return req.socket.destroy();
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let opId: string | undefined;
    try {
      opId = body.length ? (JSON.parse(body.toString('utf8')) as { opId?: string }).opId : undefined;
    } catch {
      /* not JSON */
    }
    proxy.requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', opId });
    const holdIt = proxy.hold?.(req) ?? false;
    const up = httpRequest(`${NEXUS}${req.url}`, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${PORTS.nexus}` } }, (r) => {
      const send = () => {
        if (res.destroyed) return r.resume();
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      };
      if (holdIt) proxy.held.push(send);
      else send();
    });
    up.on('error', () => res.destroy());
    up.end(body);
  });
}

/** Pages with links to save: /article/<x> is an article page; its links include query strings and fragments. */
function servePage(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', PAGES).pathname;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>测试文章 ${path}</title>
<body style="font:16px system-ui;padding:40px"><h1>测试文章 ${path}</h1>
<p><a id="query" href="https://docs.example.org/guide/install?id=7&amp;x=1#step-2">安装指南（带查询与锚点）</a></p>
<p><a id="path-a" href="https://same.example.org/a/page?v=1">同一网址 A 路径</a></p>
<p><a id="path-b" href="https://same.example.org/b/page?v=1">同一网址 B 路径</a></p>
<p><a id="quick-3" href="https://quick.example.org/three">快速收藏三</a></p>
<p><a id="wake" href="https://wake.example.org/after-stop">后台停止后收藏</a></p>
<p><a id="profiles" href="https://profiles.example.org/same?x=1#y">两个配置收藏同一网址</a></p>
<p style="height:400px"></p></body></html>`);
}

// ── accounts ───────────────────────────────────────────────────────────────
export interface Account {
  sub: string;
  email: string;
  api: APIRequestContext;
}

/** A synthetic account, signed in to the portal (through the test IdP) for checks and approvals. */
export async function account(sub: string, email: string): Promise<Account> {
  await fetch(`${IDP}/test/user`, { method: 'POST', body: JSON.stringify({ sub, email, name: sub }) });
  const api = await request.newContext({ baseURL: NEXUS, extraHTTPHeaders: { 'X-Nexus-Client': '1' } });
  const r = await api.get('/auth/login?returnTo=%2F');
  if (!r.ok()) throw new Error(`登录失败：${r.status()}`);
  const me = (await (await api.get('/api/v2/me')).json()) as { account: { email: string } };
  if (me.account.email !== email) throw new Error(`登录成了 ${me.account.email}`);
  return { sub, email, api };
}

export async function itemsOf(a: Account, url?: string): Promise<{ id: string; url: string; title: string; source: string; deletedAt: number | null }[]> {
  if (url) return ((await (await a.api.get(`/api/v2/items?url=${encodeURIComponent(url)}`)).json()) as { items: never[] }).items;
  return ((await (await a.api.get('/api/v2/snapshot')).json()) as { items: never[] }).items;
}

// ── the release package ────────────────────────────────────────────────────
export type Channel = 'chromium' | 'chrome' | 'msedge';

/** The zip `npm run package` made (Edge: its own zip, without manifest.key), unpacked as a person would. */
export function unpacked(channel: Channel): string {
  const version = (JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8')) as { version: string }).version;
  const zip = join(EXT, 'release', `nexus-portal-${channel === 'msedge' ? 'edge' : 'chrome'}-v${version}.zip`);
  if (!existsSync(zip)) throw new Error(`${zip} 不存在：先运行 npm run package -w @nexus/chrome-extension`);
  const dir = join(WORK, `pkg-${channel}`);
  rmSync(dir, { recursive: true, force: true });
  execFileSync('pwsh', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { host_permissions?: unknown };
  if (manifest.host_permissions) throw new Error('这是测试构建（预授权了主机权限），不是发布包');
  return dir;
}

export interface Browser {
  context: BrowserContext;
  profile: string;
  extId: string;
  channel: Channel;
  worker(): Promise<Worker>;
  close(): Promise<void>;
}

/**
 * A fresh profile of the given browser with the release package installed. Branded Chrome no
 * longer loads unpacked extensions from the command line: it is installed over CDP there, as an
 * unpacked extension a person would load from 开发者模式.
 */
export async function launch(channel: Channel, name: string): Promise<Browser> {
  const pkg = unpacked(channel);
  const profile = mkdtempSync(join(WORK, `profile-${channel}-${name}-`));
  const cdp = channel === 'chrome';
  const context = await chromium.launchPersistentContext(profile, {
    channel,
    headless: false,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 860 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [...(cdp ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${pkg}`, `--load-extension=${pkg}`]), '--lang=zh-CN', '--no-first-run'],
  });
  if (cdp) {
    const session = await context.browser()!.newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked' as never, { path: pkg } as never);
    await session.detach();
  }
  const first = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  const extId = new URL(first.url()).host;
  const b: Browser = {
    context,
    profile,
    extId,
    channel,
    async worker() {
      // A Worker handle can outlive the worker itself (stopped over CDP): ask the browser.
      const live = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`));
      if (live && (await workerRunning(b))) return live;
      // Stopped: any extension event starts it again (here a message from one of its pages).
      const page = await extensionPage(b, 'options.html');
      const woke = context.waitForEvent('serviceworker', { timeout: 15_000 });
      await page.evaluate(() => chrome.runtime.sendMessage({ type: 'flush' }).catch(() => undefined));
      return woke;
    },
    async close() {
      await context.close();
    },
  };
  return b;
}

export async function extensionPage(b: Browser, path = 'options.html'): Promise<Page> {
  const existing = b.context.pages().find((p) => p.url().startsWith(`chrome-extension://${b.extId}/${path}`));
  if (existing) return existing;
  const p = await b.context.newPage();
  await p.goto(`chrome-extension://${b.extId}/${path}`);
  return p;
}

// ── what a person does in the browser's own UI (Windows UI Automation) ─────
export interface UiaResult {
  ok: boolean;
  out: string;
}
export function uia(b: Browser, names: string[], opts: { type?: string; action?: 'Invoke' | 'SetValue' | 'Toggle' | 'WaitText'; value?: string; timeoutMs?: number; match?: boolean } = {}): Promise<UiaResult> {
  const args = ['-NoProfile', '-File', join(ROOT, 'e2e/release/uia.ps1'), '-ProfileDir', b.profile, '-Names', names.join(','), '-Action', opts.action ?? 'Invoke', '-TimeoutMs', String(opts.timeoutMs ?? 15_000)];
  if (opts.type) args.push('-Type', opts.type);
  if (opts.value !== undefined) args.push('-Value', opts.value);
  if (opts.match) args.push('-Match');
  return new Promise((r) => execFile('pwsh', args, { timeout: (opts.timeoutMs ?? 15_000) + 20_000 }, (err, out, stderr) => r({ ok: !err, out: `${String(out)}${String(stderr)}`.trim() })));
}

/** What UIA sees in the browser's windows (for a failure message; the whole listing goes to WORK/uia-*.txt). */
export function uiaListing(b: Browser): Promise<string> {
  return new Promise((r) =>
    execFile('pwsh', ['-NoProfile', '-File', join(ROOT, 'e2e/release/uia.ps1'), '-ProfileDir', b.profile, '-Names', 'x', '-List'], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (_e, out) => {
      const file = join(WORK, `uia-${Date.now()}.txt`);
      writeFileSync(file, String(out));
      const keep = String(out)
        .split(/\r?\n/)
        .filter((l) => /收藏到 Nexus|保存到收藏库|正在读取|这个页面不能收藏|存为草稿|没有连接/.test(l));
      r(`(full listing: ${file})\n${keep.slice(0, 40).join('\n')}`);
    }),
  );
}

/** Connect the extension (options page): the site-access prompt is answered 允许 in the browser's own dialog. */
export async function pair(b: Browser, a: Account, opts: { switching?: boolean; prompt?: boolean } = {}): Promise<void> {
  const asks = opts.prompt ?? !opts.switching;
  const options = await extensionPage(b, 'options.html');
  await options.bringToFront();
  if (opts.switching) await options.getByRole('button', { name: '更换…' }).click();
  const scope = opts.switching ? options.getByRole('dialog') : options;
  await scope.getByLabel('Nexus Portal 地址').fill(ORIGIN);
  await scope.getByRole('button', { name: '连接', exact: true }).click();
  // First time for this address: Chrome / Edge ask. Already granted (switching account): no prompt.
  const prompt = uia(b, ['允许', 'Allow'], { type: 'Button', timeoutMs: asks ? 15_000 : 3000 });
  const shown = await scope
    .getByTestId('pair-code')
    .textContent({ timeout: 25_000 })
    .catch(async (e: unknown) => {
      // What the browser showed instead (its prompt, perhaps not answered): said, not guessed.
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n站点访问提示：${(await prompt).out}\n${await uiaListing(b)}`);
    });
  const code = shown!.trim();
  await prompt;
  const approved = await a.api.post(`/api/devices/pairing/${code}`, { data: { approve: true } });
  if (!approved.ok()) throw new Error(`批准失败：${approved.status()}`);
  await options.waitForFunction((label) => document.body.innerText.includes(`保存到 ${label}`), a.email, { timeout: 30_000 });
}

/** The save queue as stored (IndexedDB nexus-queue / saves), read from an extension page. */
export async function queue(b: Browser): Promise<{ opId: string; url: string; title: string; state: string; account: string | null; origin: string | null }[]> {
  const page = await extensionPage(b, 'options.html');
  return page.evaluate(
    () =>
      new Promise((resolveQueue, reject) => {
        const r = indexedDB.open('nexus-queue', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('saves', { keyPath: 'opId' });
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const g = r.result.transaction('saves', 'readonly').objectStore('saves').getAll();
          g.onsuccess = () => {
            r.result.close();
            resolveQueue(g.result);
          };
        };
      }),
  );
}

/** Stops the extension's service worker the way Chrome does when it is idle (CDP Target.closeTarget). */
export async function stopWorker(b: Browser): Promise<boolean> {
  const session = await b.context.browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = (await session.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
    if (!sw) return false;
    await session.send('Target.closeTarget', { targetId: sw.targetId });
    for (let i = 0; i < 50; i++) {
      const now = (await session.send('Target.getTargets')) as { targetInfos: { targetId: string }[] };
      if (!now.targetInfos.some((t) => t.targetId === sw.targetId)) return true;
      await wait(100);
    }
    return false;
  } finally {
    await session.detach();
  }
}

export async function workerRunning(b: Browser): Promise<boolean> {
  const session = await b.context.browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = (await session.send('Target.getTargets')) as { targetInfos: { type: string; url: string }[] };
    return targetInfos.some((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
  } finally {
    await session.detach();
  }
}

/** Right-click a link (or the page) and pick the extension's item in the browser's native context menu. */
export async function contextMenuSave(b: Browser, page: Page, selector: string | null, item: '收藏此链接到 Nexus' | '收藏当前页面到 Nexus'): Promise<UiaResult> {
  await page.bringToFront();
  if (selector) await page.click(selector, { button: 'right' });
  else await page.mouse.click(600, 500, { button: 'right' });
  const r = await uia(b, [item], { timeoutMs: 8000 });
  if (!r.ok) await page.keyboard.press('Escape');
  return r;
}

const pinned = new WeakSet<Browser>();
/**
 * The toolbar button (「收藏到 Nexus」), clicked the way a person does: that click is what grants
 * activeTab — the popup may read the current tab's address only then (chrome.action.openPopup()
 * from code grants nothing, and the popup rightly answers 「这个页面不能收藏」). Playwright's
 * Chromium does not pin new extensions: it is pinned first on the extension's details page.
 */
export async function clickToolbarButton(b: Browser, page: Page): Promise<UiaResult> {
  if (!pinned.has(b)) {
    // Its name carries the site-access state (「收藏到 Nexus」 + 「想要访问此网站」 on a second line): matched by its start.
    const shown = await uia(b, ['^收藏到 Nexus'], { type: 'Button', action: 'WaitText', timeoutMs: 2500 });
    if (!shown.ok && b.channel === 'msedge') {
      // Edge has no such switch on the details page: its 扩展 menu → 「将 … 固定到工具栏」.
      await page.bringToFront();
      const menu = await uia(b, ['^扩展$'], { type: 'Button', match: true });
      if (!menu.ok) return menu;
      const pin = await uia(b, ['^将 .+ 固定到工具栏$'], { type: 'Button', match: true, timeoutMs: 10_000 });
      if (!pin.ok) return pin;
      await pause(500);
    } else if (!shown.ok) {
      const details = await b.context.newPage();
      await details.goto(`${b.channel === 'msedge' ? 'edge' : 'chrome'}://extensions/?id=${b.extId}`);
      await details.bringToFront();
      // The details page's own switch, flipped the way a person does it.
      const pin = await uia(b, ['固定到工具栏', '在工具栏中显示'], { action: 'Toggle', timeoutMs: 10_000 });
      if (!pin.ok) return pin;
      await pause(500);
      await details.close();
    }
    pinned.add(b);
  }
  await page.bringToFront();
  return uia(b, ['^收藏到 Nexus'], { type: 'Button', match: true });
}

/**
 * Opens the popup with its toolbar button until `waitFor` (a regular expression) shows in it. A click
 * can land while the window is still coming to the front — no popup then — so it is tried again.
 */
export async function openPopup(b: Browser, page: Page, waitFor: string): Promise<UiaResult> {
  let ready: UiaResult = { ok: false, out: '' };
  const notes: string[] = [];
  for (let attempt = 0; attempt < 3 && !ready.ok; attempt++) {
    const opened = await clickToolbarButton(b, page);
    if (!opened.ok) return opened;
    // The popup's own document (titled 收藏到 Nexus) means it did open: its content may take a
    // moment, and clicking again would close it — so it is given time instead.
    const shown = await uia(b, ['^收藏到 Nexus$'], { type: 'Document', action: 'WaitText', timeoutMs: 5000 });
    ready = await uia(b, [waitFor], { action: 'WaitText', timeoutMs: shown.ok ? 20_000 : 3000 });
    if (!ready.ok) notes.push(`第 ${attempt + 1} 次点击：${shown.ok ? `弹窗已打开，但没有出现 ${waitFor}` : '弹窗没有打开'}\n${await uiaListing(b)}`);
  }
  return ready.ok ? ready : { ok: false, out: `${ready.out}\n${notes.join('\n')}` };
}

/** Saves the active tab through the toolbar popup (the real popup, opened by its button), driven through UIA. */
export async function popupSave(b: Browser, page: Page, fields: { title?: string; tags?: string } = {}): Promise<UiaResult> {
  const ready = await openPopup(b, page, '^保存到收藏库$');
  if (!ready.ok) return ready;
  if (fields.title !== undefined) await uia(b, ['标题'], { type: 'Edit', action: 'SetValue', value: fields.title });
  if (fields.tags !== undefined) await uia(b, ['标签'], { type: 'Edit', action: 'SetValue', value: fields.tags });
  const saved = await uia(b, ['保存到收藏库'], { type: 'Button' });
  if (!saved.ok) return saved;
  return uia(b, ['^已同步到收藏库', '^已保存在此设备', '^这个网址已在收藏库中', '^已存为草稿', '没有保存'], { action: 'WaitText', timeoutMs: 20_000 });
}

export const pause = wait;
