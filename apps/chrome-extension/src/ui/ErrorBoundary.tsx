import { Component, type ReactNode } from 'react';
import { clearCache } from '../lib/sync';

interface State {
  error: Error | null;
}

/** A render error never leaves a blank new tab: reload, or drop the cache if that is the cause. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
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
            <button type="button" onClick={() => void clearCache().finally(() => location.reload())} className="h-10 rounded-xl border-0 bg-ink/9 px-4 text-[13.5px] text-ink">
              清除本地缓存并重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
