import { Component, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { HomePage } from '../features/home/HomePage';
import { SettingsPlaceholder } from '../features/settings/SettingsPlaceholder';
import { useMotionLevel } from '../lib/hooks';
import { storage } from '../lib/storage';

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  { path: '/settings/*', element: <SettingsPlaceholder /> },
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

interface BoundaryState {
  error: Error | null;
}

/**
 * Last line of defence: a render error must never leave a blank page. Offers a reload and, if the
 * stored configuration is the cause, a way back to defaults without opening devtools.
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
          <h1 className="m-0 text-[20px] font-medium">首页加载出错</h1>
          <p className="m-0 text-[13.5px] leading-[1.7] text-ink/60">{this.state.error.message}</p>
          <div className="flex gap-2.5">
            <button type="button" onClick={() => location.reload()} className="h-10 rounded-xl border-0 bg-amber px-4 text-[13.5px] font-semibold text-on-amber">
              重新加载
            </button>
            <button
              type="button"
              onClick={() => {
                storage.remove('nexus.config.v1');
                location.reload();
              }}
              className="h-10 rounded-xl border-0 bg-ink/9 px-4 text-[13.5px] text-ink"
            >
              清除本地配置并重新加载
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
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}
