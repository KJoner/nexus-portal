import { defaultConfig } from '@nexus/shared';
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { toast } from '../components/toast-store';
import { onSyncRejected, startLocal, startSync, useConfigStore } from '../data/config-store';
import { localImageHook, localWallpaperHook } from '../data/local/assets';
import { webLocalTransport } from '../data/local/web';
import { forgetSignIn, signInIntent, takeNotice } from '../data/workspace';
import { AUTH_ERRORS, LoginPage } from '../features/auth/LoginPage';
import { HomePage } from '../features/home/HomePage';
import { Wallpaper } from '../features/home/Wallpaper';
import { configureHost } from '../lib/host';
import { useMotionLevel, useViewport } from '../lib/hooks';
import { preloadPinyin } from '../lib/pinyin';
import { storage } from '../lib/storage';

const SettingsPage = lazy(() => import('../features/settings/SettingsPage'));
const CatalogPage = lazy(() => import('../features/catalog/CatalogPage'));
const LibraryPage = lazy(() => import('../features/library/LibraryPage'));
const ConnectPage = lazy(() => import('../features/account/ConnectPage'));

/**
 * v0.5 (U1): which collection this page shows is decided before the first render (workspace.ts).
 * A local collection's pictures come from IndexedDB, so the host hooks are set now — they never
 * change afterwards (stable hook order).
 */
const SPACE = useConfigStore.getState().space;
if (SPACE === 'local') {
  const store = webLocalTransport().store;
  configureHost({ useImage: localImageHook(store), useWallpaperFile: localWallpaperHook(store) });
}

const lazyPage = (el: ReactNode) => <Suspense fallback={<div className="fixed inset-0 bg-base" />}>{el}</Suspense>;

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/settings/:page?', element: lazyPage(<SettingsPage />) },
  { path: '/library', element: lazyPage(<LibraryPage />) },
  { path: '/catalog', element: lazyPage(<CatalogPage />) },
  { path: '/account/connect', element: lazyPage(<ConnectPage />) },
  { path: '*', element: <HomePage /> },
]);

/** Writes the effective motion level to <html data-motion> for the CSS fallbacks. */
function MotionRoot() {
  const motion = useMotionLevel();
  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);
  return null;
}

/** Before the first data arrives: wallpaper and nothing private, never a blank page. */
function BootScreen() {
  const { w, h } = useViewport();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1200);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="fixed inset-0 overflow-clip bg-base">
      <Wallpaper look={defaultConfig().settings.look} variant={w >= 900 && h >= 560 ? 'desktop' : 'mobile'} receded={false} />
      {slow && <p className="absolute right-0 bottom-10 left-0 m-0 text-center text-[13px] text-ink/60">{SPACE === 'local' ? '正在读取此浏览器的收藏…' : '正在连接 Nexus…'}</p>}
    </div>
  );
}

/**
 * The identity service sends a cancelled or failed sign-in back to `/?auth_error=…`. Started from a
 * local collection (登录同步), that is not a reason to show a login page: the person returns to where
 * they were, with what they had, and is told what happened.
 */
function returnFromSignIn(): void {
  const params = new URLSearchParams(location.search);
  const code = params.get('auth_error');
  const intent = signInIntent();
  if (!code) return;
  forgetSignIn();
  toast({ msg: `${AUTH_ERRORS[code] ?? '没有完成登录。'}此浏览器的收藏没有任何改动。`, tone: code === 'access_denied' ? 'info' : 'warn' });
  params.delete('auth_error');
  const rest = params.toString();
  history.replaceState(null, '', `${intent?.from ?? location.pathname}${rest ? `?${rest}` : ''}`);
}

function SpaceGate({ children }: { children: ReactNode }) {
  const auth = useConfigStore((s) => s.auth);
  const ready = useConfigStore((s) => s.ready);
  useEffect(() => {
    onSyncRejected((msg) => toast({ msg, tone: 'error' }));
    if (SPACE === 'local') {
      returnFromSignIn();
      void startLocal(webLocalTransport()).then(() => {
        // Files nothing refers to any more (replaced icons, an undone restore), a day after.
        setTimeout(() => void webLocalTransport().store.sweep().catch(() => undefined), 5000);
      });
    } else startSync();
    preloadPinyin();
    const notice = takeNotice();
    if (notice) setTimeout(() => toast({ msg: notice, tone: 'ok' }), 400);
  }, []);
  // An account whose sign-in ended: its collection stays hidden (and its unsent changes kept for it).
  if (SPACE === 'account' && auth === 'anonymous') return <LoginPage reauth />;
  if (!ready) return <BootScreen />;
  return children;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * Last line of defence: a render error must never leave a blank page. Offers a reload and, if the
 * cached configuration is the cause, a way back without opening devtools.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 grid place-items-center bg-base p-6 text-ink">
        <div className="flex max-w-md flex-col gap-4 rounded-[20px] bg-ink/[0.045] p-7">
          <h1 className="m-0 text-[20px] font-medium">页面加载出错</h1>
          <p className="m-0 text-[13.5px] leading-[1.7] text-ink/60">{this.state.error.message}</p>
          <div className="flex flex-wrap gap-2.5">
            <button type="button" onClick={() => location.reload()} className="h-10 rounded-xl border-0 bg-amber px-4 text-[13.5px] font-semibold text-on-amber">
              重新加载
            </button>
            <button
              type="button"
              onClick={() => {
                // Every account's cache in this browser (v0.4 keys them per account), and the old one.
                // Never the local collection (IndexedDB `nexus-local`): that is the person's data, not a cache.
                try {
                  for (const k of Object.keys(localStorage)) if (k.startsWith('nexus.cache.')) storage.remove(k);
                } catch {
                  /* storage disabled */
                }
                location.reload();
              }}
              className="h-10 rounded-xl border-0 bg-ink/9 px-4 text-[13.5px] text-ink"
            >
              清除账号缓存并重新加载
            </button>
          </div>
          <p className="m-0 text-[12px] leading-[1.6] text-ink/50">清除的只是可以重新下载的账号缓存；此浏览器的本地收藏不受影响。</p>
        </div>
      </div>
    );
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <MotionRoot />
      <SpaceGate>
        <RouterProvider router={router} />
      </SpaceGate>
    </ErrorBoundary>
  );
}
