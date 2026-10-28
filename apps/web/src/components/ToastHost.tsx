import { X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '../lib/cn';
import { runUndo, useToastStore, type Toast, type ToastTone } from './toast-store';

const DOT: Record<ToastTone, string> = { ok: '#a7bf9f', warn: '#e3a35b', error: '#e9765f', info: 'rgba(239,234,225,0.5)', undo: '#e6c08a' };

interface Props {
  variant: 'desktop' | 'mobile';
  /** Mobile: distance from the bottom, so the toast sits just above the search bar. */
  bottom?: CSSProperties['bottom'];
  durationMs?: number;
}

/** role="status" toast. Undoable toasts stay for `durationMs`; hovering pauses the timer. */
export function ToastHost({ variant, bottom, durationMs = 5000 }: Props) {
  const current = useToastStore((s) => s.current);
  const dismiss = useToastStore((s) => s.dismiss);
  const [last, setLast] = useState<Toast | null>(current);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (current) setLast(current);
  }, [current]);

  const arm = () => {
    clearTimeout(timer.current);
    if (current) {
      const id = current.id;
      timer.current = setTimeout(() => dismiss(id), durationMs);
    }
  };
  useEffect(() => {
    arm();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const t = current ?? last;
  const shown = !!current;
  const act = t?.undo?.length ? { label: '撤销', run: () => t && runUndo(t) } : t?.action;
  const desktop = variant === 'desktop';

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={arm}
      className={cn(
        'fixed z-30 flex items-center backdrop-blur-[30px] transition-[opacity,transform,bottom] duration-200 ease-soft',
        desktop ? 'left-1/2 bottom-10 h-12 gap-3 whitespace-nowrap rounded-2xl pr-[7px] pl-[18px] text-[14px]' : 'right-4 left-4 min-h-12 gap-2.5 rounded-2xl pr-1 pl-4 text-[14px]',
        shown ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      style={{
        background: desktop ? 'rgba(36,34,30,0.92)' : 'rgba(40,38,34,0.94)',
        boxShadow: desktop ? '0 20px 50px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.07)' : '0 14px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.07)',
        transform: `${desktop ? 'translateX(-50%) ' : ''}${shown ? '' : `translateY(${desktop ? 10 : 8}px)`}`,
        bottom: desktop ? undefined : bottom,
      }}
    >
      {t && (
        <>
          <span className="size-[7px] flex-none rounded-full" style={{ background: DOT[t.tone] }} />
          <span className={cn(!desktop && 'min-w-0 flex-1')}>{t.msg}</span>
          {act && (
            <button
              type="button"
              tabIndex={shown ? 0 : -1}
              onClick={() => {
                dismiss(t.id);
                act.run();
              }}
              className={cn(
                'flex-none border-0',
                desktop ? 'h-[34px] rounded-[10px] bg-amber/16 px-3 text-[13.5px] text-amber-hi transition-colors duration-140 hover:bg-amber/26' : 'h-11 rounded-xl bg-transparent px-3.5 text-[14px] font-semibold text-amber-hi',
              )}
            >
              {act.label}
            </button>
          )}
          {desktop && (
            <button
              type="button"
              tabIndex={shown ? 0 : -1}
              aria-label="关闭提示"
              onClick={() => dismiss(t.id)}
              className="grid size-[34px] place-items-center rounded-[10px] border-0 bg-transparent text-ink/60 hover:bg-ink/8"
            >
              <X className="size-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
