import { useEffect, useState, type CSSProperties } from 'react';

export interface Near {
  /** Pointer in the top band (navigation, status, settings). */
  top: boolean;
  /** Pointer near the bottom-left corner (wallpaper credit and actions). */
  bottomLeft: boolean;
}

const NONE: Near = { top: false, bottomLeft: false };

/**
 * Where a mouse pointer is, for elements set to 悬停时显示. Touch input never counts: phones use
 * their own settings, not hover.
 */
export function useProximity(enabled: boolean): Near {
  const [near, setNear] = useState<Near>(NONE);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let x = -1;
    let y = -1;
    const update = () => {
      raf = 0;
      const next = { top: y >= 0 && y < 92, bottomLeft: y > window.innerHeight - 96 && x >= 0 && x < 640 };
      setNear((n) => (n.top === next.top && n.bottomLeft === next.bottomLeft ? n : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      x = e.clientX;
      y = e.clientY;
      schedule();
    };
    const onLeave = () => {
      x = -1;
      y = -1;
      schedule();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [enabled]);
  return enabled ? near : NONE;
}

/**
 * 显示方式 → render props. `hover` elements stay in the tab order and appear on focus, so
 * keyboard users are never locked out.
 */
export function reveal(mode: 'show' | 'hover' | 'hide', near: boolean): { hidden: boolean; className: string; style: CSSProperties | undefined } {
  if (mode === 'hide') return { hidden: true, className: '', style: undefined };
  if (mode === 'show') return { hidden: false, className: '', style: undefined };
  return { hidden: false, className: 'transition-opacity duration-200 ease-soft hover:!opacity-100 focus-within:!opacity-100', style: { opacity: near ? 1 : 0 } };
}
