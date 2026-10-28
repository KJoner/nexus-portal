import { defaultConfig } from '@nexus/shared';
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { toast } from '../components/toast-store';
import { onSyncRejected, startSync, useConfigStore } from '../data/config-store';
import { LoginPage } from '../features/auth/LoginPage';
import { HomePage } from '../features/home/HomePage';
import { Wallpaper } from '../features/home/Wallpaper';
import { useMotionLevel, useViewport } from '../lib/hooks';
import { storage } from '../lib/storage';

const SettingsPage = lazy(() => import('../features/settings/SettingsPage'));

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  {
    path: '/settings/:page?',
    element: (
      <Suspense fallback={<div className="fixed inset-0 bg-base" />}>
        <SettingsPage />
      </Suspense>
    ),
  },
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

/** First visit before the server answers: wallpaper and nothing private, never a blank page. */
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
      {slow && <p className="absolute right-0 bottom-10 left-0 m-0 text-center text-[13px] text-ink/60">正在连接 Nexus…</p>}
    </div>
  );
}

function SyncGate({ children }: { children: ReactNode }) {
  const auth = useConfigStore((s) => s.auth);
  const ready = useConfigStore((s) => s.ready);
  useEffect(() => {
    onSyncRejected((msg) => toast({ msg, tone: 'error' }));
    startSync();
  }, []);
  if (auth === 'anonymous') return <LoginPage />;
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
          <div className="flex gap-2.5">
            <button type="button" onClick={() => location.reload()} className="h-10 rounded-xl border-0 bg-amber px-4 text-[13.5px] font-semibold text-on-amber">
              重新加载
            </button>
            <button
              type="button"
              onClick={() => {
                storage.remove('nexus.cache.v2');
                location.reload();
              }}
              className="h-10 rounded-xl border-0 bg-ink/9 px-4 text-[13.5px] text-ink"
            >
              清除本地缓存并重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <MotionRoot />
      <SyncGate>
        <RouterProvider router={router} />
      </SyncGate>
    </ErrorBoundary>
  );
}
