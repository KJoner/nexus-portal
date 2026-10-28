import { useEffect, useState, useSyncExternalStore } from 'react';
import { useConfigStore } from '../data/config-store';

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    const m = window.matchMedia(query);
    m.addEventListener('change', cb);
    return () => m.removeEventListener('change', cb);
  };
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(subscribeMedia(query), () => window.matchMedia(query).matches, () => false);
}

export type MotionLevel = 'full' | 'reduced' | 'off';

/** 动画强度 setting, downgraded to 减弱 when the system asks for reduced motion. */
export function useMotionLevel(): MotionLevel {
  const setting = useConfigStore((s) => s.snapshot.config.settings.look.motion);
  const systemReduce = useMediaQuery('(prefers-reduced-motion: reduce)');
  if (setting === 'off') return 'off';
  return systemReduce || setting === 'reduced' ? 'reduced' : 'full';
}

function subscribeResize(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
let cached = { w: 0, h: 0 };
function readSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w !== cached.w || h !== cached.h) cached = { w, h };
  return cached;
}

export function useViewport(): { w: number; h: number } {
  return useSyncExternalStore(subscribeResize, readSize, () => ({ w: 1440, h: 900 }));
}

/**
 * Visual viewport geometry for iOS keyboards: the layout viewport does not shrink when the
 * keyboard opens, so the search bar follows `visualViewport` instead (R1.5 · 软键盘).
 */
export function useVisualViewport(active: boolean): { height: number; offsetTop: number } | null {
  const [vv, setVv] = useState<{ height: number; offsetTop: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!active || !v) {
      setVv(null);
      return;
    }
    const update = () => setVv({ height: v.height, offsetTop: v.offsetTop });
    update();
    v.addEventListener('resize', update);
    v.addEventListener('scroll', update);
    return () => {
      v.removeEventListener('resize', update);
      v.removeEventListener('scroll', update);
    };
  }, [active]);
  return vv;
}

/** Current time, ticking each second or at each minute boundary. */
export function useNow(seconds: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const d = new Date();
      setNow(d);
      t = setTimeout(tick, seconds ? 1000 - d.getMilliseconds() : 60_000 - d.getSeconds() * 1000 - d.getMilliseconds());
    };
    tick();
    const onVisible = () => document.visibilityState === 'visible' && setNow(new Date());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [seconds]);
  return now;
}
