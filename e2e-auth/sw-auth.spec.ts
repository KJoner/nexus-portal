import { expect, test, type Page } from '@playwright/test';
import { IDP_HOST, isControlled, LEGACY_DIST, me, NEW_DIST, NEXUS, PASSWORD, removeDir, signInAtIdp, startIdp, startNexus, tempDir, underServiceWorker } from './harness';

/**
 * NEX-01 · RA-2：生产构建（apps/web/dist 的 Service Worker + apps/server/dist）在真实浏览器里，
 * 页面已被 Service Worker 控制之后，统一登录的每一步都必须真实到达服务端。用到达模拟身份服务的
 * 登录页、回到 Nexus 后服务端建立的会话来证明——缓存的应用壳既不能跳到身份服务，也不能建会话。
 */
test.describe.configure({ mode: 'serial' });

let idp: Awaited<ReturnType<typeof startIdp>>;
test.beforeAll(async () => {
  idp = await startIdp();
});
test.afterAll(async () => {
  await idp?.close();
});

/**
 * v0.5 登录同步（/account/connect）：先确认页面在 Service Worker 控制下，再点「登录或创建账号」；
 * 身份服务回到 /account/connect?return=1（服务端的回调，不是应用壳），选「使用账号里的收藏」（两边
 * 都空时是「开启同步」），回到原来的页面且已登录。
 */
async function signInWithButton(page: Page, name: string) {
  expect(await isControlled(page)).toBe(true);
  const from = new URL(page.url()).pathname;
  await page.goto(`${NEXUS}/account/connect?from=${encodeURIComponent(from)}`);
  await page.getByRole('button', { name: '登录或创建账号' }).click();
  await signInAtIdp(page, name);
  await expect(page).toHaveURL(`${NEXUS}/account/connect?return=1`);
  await page.getByRole('button', { name: /使用账号里的收藏|开启同步/ }).click();
  await expect(page).toHaveURL(`${NEXUS}${from}`);
  await expect.poll(() => me(page)).toMatchObject({ product: 'nexus', session: 'oidc' });
}

/** 设置 › 账号与同步 › 退出此设备（动作 A）：回到此浏览器自己的本地收藏（UI v2：顶栏状态写「仅此设备」）。 */
async function signOutHere(page: Page) {
  await page.goto(`${NEXUS}/settings/account`);
  await page.getByRole('button', { name: '退出', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByText('仅此设备').first()).toBeVisible();
}

test('新版：Service Worker 接管后，旧管理员绑定、退出重登、注册与回调都由服务端处理', async ({ page }) => {
  const data = tempDir();
  const nexus = await startNexus(NEW_DIST, data);
  try {
    await page.goto(`${NEXUS}/`);
    await underServiceWorker(page);
    await page.reload();
    expect(await isControlled(page)).toBe(true);

    // 旧管理员绑定：访问密码登录 → /auth/link/start → 身份服务 → /auth/callback
    await page.goto(`${NEXUS}/account/connect`);
    await page.getByRole('button', { name: '管理员访问密码登录' }).click();
    await page.getByLabel('访问密码').fill(PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: /使用账号里的收藏|开启同步/ }).click();
    await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
    await page.goto(`${NEXUS}/settings/account`);
    expect(await isControlled(page)).toBe(true);
    await page.getByRole('button', { name: /绑定/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '前往账号中心' }).click();
    await signInAtIdp(page, 'owner');
    await expect(page).toHaveURL(`${NEXUS}/settings/account?linked=1`);
    expect(await me(page)).toMatchObject({ role: 'admin', session: 'oidc', identityLinked: true, account: { id: 'legacy-admin', username: 'owner' } });

    // 退出此设备 → 用统一账号重新登录：仍是管理员
    await signOutHere(page);
    await signInWithButton(page, 'owner');
    expect(await me(page)).toMatchObject({ role: 'admin', session: 'oidc' });

    // 注册：一个新身份第一次进入（开放注册）得到自己的账号。UI v2（v12.0.3 N3）起新账号在创建时放入 8 个常用网站，
    // 所以不再是空收藏（onboarding 为 ready）；收藏条数在 apps/server 的 favorites.test.ts 里逐项核对。
    await signOutHere(page);
    await signInWithButton(page, 'newcomer');
    expect(await me(page)).toMatchObject({ role: 'user', session: 'oidc', onboarding: { state: 'ready' }, account: { email: 'newcomer@example.test', username: 'newcomer' } });
    // UI v2 I1：账号与同步显示身份服务给的登录用户名（只读）；顶栏状态胶囊仍然不写邮箱、昵称或用户名（C11）
    await page.goto(`${NEXUS}/settings/account`);
    await expect(page.getByText('登录用户名')).toBeVisible();
    await expect(page.getByText('newcomer', { exact: true })).toBeVisible();
    await page.goto(`${NEXUS}/`);
    const pill = page.getByRole('link', { name: /^保存状态：/ });
    await expect(pill).toBeVisible();
    const words = `${await pill.textContent()} ${await pill.getAttribute('aria-label')} ${await pill.getAttribute('title')}`;
    expect(words).not.toContain('newcomer');

    // 回调地址被重放：intent 已经用过，服务端拒绝（应用壳不可能回答这个结果）
    await page.goto(`${NEXUS}/auth/callback?code=replayed&state=replayed`);
    await expect(page).toHaveURL(`${NEXUS}/?auth_error=state`);
  } finally {
    await nexus.close();
    removeDir(data);
  }
});

test('离线或服务端不可达：认证明确不可用，普通页面的离线壳保留', async ({ page, context }) => {
  const data = tempDir();
  let nexus = await startNexus(NEW_DIST, data);
  try {
    await page.goto(`${NEXUS}/`);
    await underServiceWorker(page);
    await signInWithButton(page, 'traveller');
    await page.goto(`${NEXUS}/library`);
    // UI v2：/library 是旧链接，落到「我的收藏」
    await expect(page.getByRole('heading', { name: '我的收藏' }).first()).toBeVisible();

    // 服务端停了：认证导航得到「暂时无法登录」（503），不是应用壳；我的收藏仍从离线壳打开
    await nexus.close();
    for (const path of ['/auth/login?returnTo=%2F', '/auth/callback?code=x&state=y', '/auth/link/start']) {
      const res = await page.goto(`${NEXUS}${path}`);
      expect(res?.status(), path).toBe(503);
      await expect(page.getByRole('heading', { name: '暂时无法登录' })).toBeVisible();
      await expect(page.getByText('这次登录没有完成')).toBeVisible();
    }
    await page.goto(`${NEXUS}/library`);
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(await isControlled(page)).toBe(true);

    // 服务端恢复，退出后断网：登录页直接说明需要联网，而不是跳到浏览器的错误页
    nexus = await startNexus(NEW_DIST, data);
    await signOutHere(page);
    await context.setOffline(true);
    await page.goto(`${NEXUS}/account/connect`);
    await page.getByRole('button', { name: '登录或创建账号' }).click();
    await expect(page.getByRole('alert')).toContainText('当前设备离线');
    expect(new URL(page.url()).host).not.toBe(IDP_HOST);
    await context.setOffline(false);
  } finally {
    await context.setOffline(false);
    await nexus.close();
    removeDir(data);
  }
});

test('旧版 Service Worker 已安装后升级：先复现旧行为，部署新版后自动接管，认证恢复正常', async ({ page }) => {
  const data = tempDir();
  let nexus = await startNexus(LEGACY_DIST, data);
  try {
    await page.goto(`${NEXUS}/`);
    await underServiceWorker(page);

    // 旧结果（NEX-01）：/auth/login 被 0.4.0 的 Service Worker 用缓存的应用壳回答，没有到达服务端
    // （v0.5 起应用壳在任何路径都先显示本地首页，所以看到的是首页而不是身份服务）
    await page.goto(`${NEXUS}/auth/login?returnTo=%2F`);
    await expect(page.getByLabel('搜索', { exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/auth/login');

    // 同一地址部署新版本（同一数据目录）；不关闭任何标签页
    await nexus.close();
    nexus = await startNexus(NEW_DIST, data);
    await page.goto(`${NEXUS}/`);
    const started = Date.now();
    await expect
      .poll(
        async () => {
          await page.goto(`${NEXUS}/auth/login?returnTo=%2F`);
          return new URL(page.url()).host;
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(IDP_HOST);
    test.info().annotations.push({ type: '新版接管耗时', description: `${Date.now() - started} ms` });

    // 升级后的完整流程：登录 → 回调 → 首页
    await page.goto(`${NEXUS}/`);
    await underServiceWorker(page);
    await signInWithButton(page, 'upgraded');
    expect(await me(page)).toMatchObject({ role: 'user', session: 'oidc' });
  } finally {
    await nexus.close();
    removeDir(data);
  }
});
