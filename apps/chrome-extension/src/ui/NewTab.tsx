import { defaultConfig } from '@nexus/shared';
import { HomePage } from '@web/features/home/HomePage';
import { Wallpaper } from '@web/features/home/Wallpaper';
import { Button, Spinner } from '@web/features/settings/ui';
import { useMotionLevel, useViewport } from '@web/lib/hooks';
import { formatAgo } from '@web/lib/time';
import { RefreshCw, Settings } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { phaseOf, sync, useExt } from '../lib/sync';
import { ConnectForm } from './Connect';

const optionsUrl = () => chrome.runtime.getURL('options.html');

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

export function NewTab() {
  const phase = useExt(phaseOf);
  const server = useExt((s) => s.server);
  const router = useMemo(
    () =>
      createMemoryRouter([
        { path: '/', element: <HomePage /> },
        { path: '/settings/*', element: <LeaveForSettings /> },
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
      <Panel title="此设备的授权已失效" sub="授权可能已在 Nexus Portal 中被撤销，或访问密码已更改。本地缓存的导航已清除，请重新连接。">
        <ConnectForm initial={server?.origin ?? ''} />
      </Panel>
    );
  if (phase === 'empty') return <FirstSync />;
  return (
    <>
      <MotionRoot />
      <RouterProvider router={router} />
    </>
  );
}
