import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';

const DELAY = 480;
const SLOP = 10;

/**
 * Long press (480 ms, light haptic) for touch; right-click / Android long-press `contextmenu` maps to
 * the same handler. The click that follows a long press is swallowed so the app does not open.
 */
export function useLongPress(onLongPress: (id: string, el: HTMLElement) => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const [pressed, setPressed] = useState<string | null>(null);

  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
    setPressed(null);
  };

  const bind = (id: string) => ({
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      setPressed(id);
      const el = e.currentTarget;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        setPressed(null);
        navigator.vibrate?.(8);
        onLongPress(id, el);
      }, DELAY);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu(e: MouseEvent<HTMLElement>) {
      e.preventDefault();
      cancel();
      if (fired.current) return;
      fired.current = true;
      onLongPress(id, e.currentTarget);
    },
    /** Returns true when this click should be ignored (it ended a long press). */
    consumeClick(e: MouseEvent) {
      if (!fired.current) return false;
      e.preventDefault();
      fired.current = false;
      return true;
    },
  });

  return { bind, pressed };
}
