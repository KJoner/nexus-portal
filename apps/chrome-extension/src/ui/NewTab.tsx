import { defaultConfig } from '@nexus/shared';
import { LegacyCatalogRedirect, LegacyLibraryRedirect } from '@web/features/favorites/redirects';
import { HomePage } from '@web/features/home/HomePage';
import { ThemeRoot } from '@web/lib/theme';
import { Wallpaper } from '@web/features/home/Wallpaper';
import { Button, Spinner } from '@web/features/settings/ui';
import { useMotionLevel, useViewport } from '@web/lib/hooks';
import { formatAgo } from '@web/lib/time';
import { RefreshCw, Settings } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { createMemoryRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import { writeSpace, type ExtSpace } from '../lib/local';
import { phaseOf, sync, useExt } from '../lib/sync';
import { ConnectForm } from './Connect';
import { ext } from '../lib/ext';

const SettingsPage = lazy(() => import('@web/features/settings/SettingsPage'));
const page = (el: ReactNode) => <Suspense fallback={<div className="fixed inset-0 bg-base" />}>{el}</Suspense>;

/** `newtab.html#/settings/favorites` opens that page (the popup's 「打开我的收藏」); old `#/library`, `#/catalog` too. */
const startAt = () => (location.hash.startsWith('#/') ? location.hash.slice(1) : '/');

/** Connecting an account happens in the options (pairing); the portal's sign-in page has no place here. */
function ToOptions() {
  useEffect(() => void ext.runtime.openOptionsPage(), []);
  return <Navigate to="/settings/account" replace />;
}

/**
 * v0.5: this extension's own collection. The home page, 收藏, 应用目录 and 设置 are the portal's
 * pages, editable here over the extension's IndexedDB — not handed to the website, which cannot
 * read the extension's data.
 */
function LocalNewTab() {
  const router = useMemo(
    () =>
      createMemoryRouter(
        [
          { path: '/', element: <HomePage /> },
          { path: '/settings/:page?', element: page(<SettingsPage />) },
          // UI v2: 收藏库 and 应用目录 are 我的收藏 (and its 添加收藏 › 应用商店), in this extension's own collection.
          { path: '/library', element: <LegacyLibraryRedirect /> },
          { path: '/catalog', element: <LegacyCatalogRedirect /> },
          { path: '/account/connect', element: <ToOptions /> },
          { path: '*', element: <HomePage /> },
        ],
        { initialEntries: [startAt()] },
      ),
    [],
  );
  // Already open and asked for another page (newtab.html#/catalog): follow it without a reload.
  useEffect(() => {
    const follow = () => void router.navigate(startAt());
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [router]);
  return (
    <>
      <MotionRoot />
      <ThemeRoot />
      <RouterProvider router={router} />
    </>
  );
}

const optionsUrl = () => ext.runtime.getURL('options.html');

/**
 * The home links to /settings/…: the extension's own settings for the gear (and `,`), the
 * portal's settings pages (editing an app, display and layout, wallpapers) for everything else —
 * in this tab, as in the portal.
 */
function LeaveForSettings() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const server = useExt.getState().server;
    window.location.assign(pathname === '/settings' || pathname === '/settings/' || !server ? optionsUrl() : `${server.origin}${pathname}${search}`);
  }, [pathname, search]);
  return null;
}

function MotionRoot() {
  const motion = useMotionLevel();
  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);
  return null;
}

/** Wallpaper and a centred card: pairing, reconnecting, or waiting for the first sync. */
function Panel({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  const { w, h } = useViewport();
  return (
    <div className="fixed inset-0 overflow-y-auto bg-base">
      <Wallpaper look={defaultConfig().settings.look} variant={w >= 900 && h >= 560 ? 'desktop' : 'mobile'} receded />
      <div className="relative grid min-h-full place-items-center p-6">
        <div className="flex w-full max-w-[460px] flex-col gap-5 rounded-3xl p-7 text-ink backdrop-blur-[30px]" style={{ background: 'rgba(30,28,25,0.78)', boxShadow: '0 40px 100px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.07)' }}>
          <div className="flex flex-col gap-2">
            <h1 className="m-0 text-[22px] font-medium tracking-[-0.01em]">{title}</h1>
            {sub && <p className="m-0 text-[13.5px] leading-[1.7] text-ink/62">{sub}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Paired, but nothing synced yet: never invented data, just what is happening. */
function FirstSync() {
  const server = useExt((s) => s.server)!;
  const error = useExt((s) => s.sync.error);
  const syncing = useExt((s) => s.syncing);
  const host = new URL(server.origin).host;
  return (
    <Panel title={error ? `暂时无法连接 ${host}` : '正在同步导航…'} sub={error ? `${error.message}。网络恢复后会自动重试；首次同步完成前，这里不会显示任何导航内容。` : `正在从 ${host} 下载导航配置。`}>
      <div className="flex flex-wrap gap-2.5">
        <Button variant="primary" className="h-10 px-5" disabled={syncing} onClick={() => void sync({ force: true })}>
          {syncing ? <Spinner className="border-on-amber/70 border-t-transparent" /> : <RefreshCw className="size-[15px]" />}
          重试
        </Button>
        <Button className="h-10" onClick={() => window.location.assign(optionsUrl())}>
          <Settings className="size-[15px]" />
          扩展设置
        </Button>
      </div>
      {error && <p className="m-0 text-[12.5px] text-ink/46">上次尝试：{formatAgo(error.at)}</p>}
    </Panel>
  );
}

export function NewTab({ space = 'account' }: { space?: ExtSpace }) {
  if (space === 'local') return <LocalNewTab />;
  return <AccountNewTab />;
}

const switchToLocal = () => void writeSpace(ext.storage.local as never, 'local').then(() => location.reload());

function AccountNewTab() {
  const phase = useExt(phaseOf);
  const server = useExt((s) => s.server);
  const router = useMemo(
    () =>
      createMemoryRouter([
        { path: '/', element: <HomePage /> },
        { path: '/settings/*', element: <LeaveForSettings /> },
        // 我的收藏 of an account lives in the portal: the new tab hands over to it, like the settings pages.
        { path: '/catalog', element: <LeaveForSettings /> },
        { path: '/library', element: <LeaveForSettings /> },
        { path: '*', element: <HomePage /> },
      ]),
    [],
  );
  if (phase === 'loading') return <div className="fixed inset-0 bg-base" />;
  if (phase === 'setup')
    return (
      <Panel title="连接 Nexus Portal" sub="新标签页会显示你在 Nexus Portal 中的导航。连接一次即可，之后打开新标签页直接使用本地缓存，后台自动同步。">
        <ConnectForm />
      </Panel>
    );
  if (phase === 'revoked')
    return (
      <Panel title="此设备的授权已失效" sub="授权已被撤销，请重新连接。可能是在 Nexus Portal 或 LiteSync 中退出了全部设备、账号被停用，或访问密码已更改。账号的缓存已清除；还没发送的收藏仍保存在扩展里，重新连接并确认账号后再发送。">
        <ConnectForm initial={server?.origin ?? ''} />
        <Button className="h-10 self-start" onClick={switchToLocal}>
          改用此扩展的本地收藏
        </Button>
      </Panel>
    );
  if (phase === 'empty') return <FirstSync />;
  return (
    <>
      <MotionRoot />
      <ThemeRoot />
      <RouterProvider router={router} />
    </>
  );
}
