// 认证与 Service Worker 的端到端测试夹具：一个经 HTTP 提供的模拟身份服务，以及按需启停的生产构建
// Nexus 服务端（apps/server/dist）。只用合成账号、临时数据目录和本机端口（39410/39411）。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { fakeIdp, type FakeIdp } from '../apps/server/src/testing/fake-idp';

export const ROOT = resolve(import.meta.dirname, '..');
export const NEXUS_PORT = 39410;
export const IDP_PORT = 39411;
export const NEXUS = `http://127.0.0.1:${NEXUS_PORT}`;
/** A different host name than Nexus: cookies of the two never mix (they ignore ports). */
export const IDP_HOST = `localhost:${IDP_PORT}`;
export const ISSUER = `http://${IDP_HOST}/realms/accounts`;
export const PASSWORD = 'e2e-auth-password';
export const NEW_DIST = join(ROOT, 'apps/web/dist');
export const LEGACY_DIST = process.env.NEXUS_E2E_LEGACY_DIST?.trim() || join(ROOT, 'e2e-auth/.legacy-dist');

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The fake OpenID provider of the server tests (real RS256 tokens, PKCE and client checks), served
 * over HTTP so a real browser and the real server can use it: a sign-in page with one field (the
 * person's name; a new name is a new identity, i.e. registration), the end-session redirect, and
 * everything server-to-server (discovery, keys, tokens) answered by the fake itself.
 */
export async function startIdp(): Promise<{ idp: FakeIdp; close(): Promise<void> }> {
  const idp = await fakeIdp({ issuer: ISSUER });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', `http://${IDP_HOST}`);
        const body = Buffer.concat(chunks);
        if (req.method === 'GET' && url.pathname === '/realms/accounts/protocol/openid-connect/auth') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>账号中心（测试）</title><h1>账号中心（测试）</h1>` +
              `<form method="post" action="/__sign-in"><input type="hidden" name="q" value="${escapeHtml(url.search.slice(1))}">` +
              `<label>用户名 <input name="username" autocomplete="off"></label> <button type="submit">登录或注册</button></form></html>`,
          );
          return;
        }
        if (req.method === 'POST' && url.pathname === '/__sign-in') {
          const form = new URLSearchParams(body.toString('utf8'));
          const auth = new URL(`${ISSUER}/protocol/openid-connect/auth?${form.get('q') ?? ''}`);
          const sub = (form.get('username') ?? '').trim();
          // preferred_username as Keycloak's profile scope sends it (the login name; UI v2 I1).
          const code = idp.authorize(auth, { sub, email: `${sub}@example.test`, name: sub, preferredUsername: sub });
          const back = new URL(auth.searchParams.get('redirect_uri')!);
          back.searchParams.set('code', code);
          back.searchParams.set('state', auth.searchParams.get('state') ?? '');
          res.writeHead(302, { location: back.toString() });
          res.end();
          return;
        }
        if (req.method === 'GET' && url.pathname === '/realms/accounts/protocol/openid-connect/logout') {
          res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') ?? `${NEXUS}/` });
          res.end();
          return;
        }
        const headers = new Headers();
        for (const name of ['authorization', 'content-type', 'accept']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name] as string);
        const r = await idp.fetch(new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
      })().catch((e: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((ok) => server.listen(IDP_PORT, '127.0.0.1', ok));
  return { idp, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** A throw-away data directory (NEXUS_E2E_TMP, else the system temp directory). */
export function tempDir(): string {
  return mkdtempSync(join(process.env.NEXUS_E2E_TMP?.trim() || tmpdir(), 'na-e2e-auth-'));
}

export interface Nexus {
  log: string[];
  close(): Promise<void>;
}

/**
 * The production server bundle on a fixed origin, serving `webDist`. NODE_ENV is not `production`
 * only so the identity service may be plain http on this machine; the web app is the production
 * build either way (its Service Worker registers).
 */
export async function startNexus(webDist: string, dataDir: string): Promise<Nexus> {
  const log: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      NODE_ENV: 'e2e',
      HOST: '127.0.0.1',
      PORT: String(NEXUS_PORT),
      NEXUS_DATA_DIR: dataDir,
      NEXUS_WEB_DIST: webDist,
      NEXUS_PASSWORD: PASSWORD,
      NEXUS_SECRET: 'e2e-auth-secret-0123456789',
      NEXUS_PUBLIC_URL: NEXUS,
      NEXUS_OIDC_ISSUER: ISSUER,
      NEXUS_OIDC_CLIENT_ID: 'nexus-web',
      NEXUS_OIDC_CLIENT_SECRET: 'test-client-secret',
      NEXUS_REGISTRATION_MODE: 'open',
    },
  });
  child.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${NEXUS}/api/healthz`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (i > 150 || child.exitCode !== null) throw new Error(`Nexus 没有启动：\n${log.join('')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    log,
    async close() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

/** The app registers its worker 3 s after load; once one is active, this page must be under it. */
export async function underServiceWorker(page: Page) {
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), { timeout: 45_000 }).toBe(true);
  // 0.4.0 workers do not claim open pages: the next load is the first one they answer.
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
}

export const isControlled = (page: Page) => page.evaluate(() => !!navigator.serviceWorker.controller);

/** On the identity service's page (proof that the server handled the /auth/* navigation). */
export async function signInAtIdp(page: Page, name: string) {
  await page.waitForURL((u) => u.host === IDP_HOST, { timeout: 15_000 });
  await page.getByLabel('用户名').fill(name);
  await page.getByRole('button', { name: '登录或注册' }).click();
  await page.waitForURL((u) => u.origin === NEXUS, { timeout: 15_000 });
}

export const me = (page: Page) => page.evaluate(async () => {
  const r = await fetch('/api/v2/me');
  return r.ok ? ((await r.json()) as Record<string, unknown>) : { status: r.status };
});
