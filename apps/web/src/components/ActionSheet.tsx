import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { AppTile, type TileTarget } from '../icons/AppTile';
import { cn } from '../lib/cn';

export interface SheetItem {
  label: string;
  icon: LucideIcon;
  onSelect(): void;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
}

export interface SheetState {
  header: { target: TileTarget; name: string; sub: string };
  items: SheetItem[];
}

interface Props {
  sheet: SheetState | null;
  onClose(): void;
}

/** Bottom action sheet: every action in the thumb zone, destructive ones in coral (R1.5 · M2). */
export function ActionSheet({ sheet, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const open = !!sheet;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Focus the sheet itself so screen readers land in it without a focus ring on the first action.
    panel.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div aria-hidden={!open} inert={!open} className="fixed inset-0 z-40" style={{ pointerEvents: open ? 'auto' : 'none' }}>
      <div className="absolute inset-0 transition-opacity duration-240" style={{ background: 'rgba(10,9,8,0.46)', opacity: open ? 1 : 0 }} onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={sheet?.header.name}
        tabIndex={-1}
        className="absolute right-2.5 left-2.5 flex flex-col gap-2 outline-none transition-transform duration-380 ease-emph"
        style={{ bottom: 'max(30px, calc(env(safe-area-inset-bottom) + 8px))', transform: open ? 'none' : 'translateY(calc(100% + 60px))' }}
      >
        {sheet && (
          <>
            <div className="overflow-hidden rounded-3xl backdrop-blur-[36px]" style={{ background: 'rgba(40,38,34,0.92)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)' }}>
              <div className="flex items-center gap-3 border-b border-ink/7 px-[18px] pt-4 pb-3.5">
                <AppTile target={sheet.header.target} size={44} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[16px] font-medium">{sheet.header.name}</span>
                  <span className="truncate text-[12.5px] text-ink/50">{sheet.header.sub}</span>
                </span>
              </div>
              {sheet.items.map((m) => (
                <button
                  key={m.label}
                  type="button"
                  disabled={m.disabled}
                  onClick={() => {
                    onClose();
                    m.onSelect();
                  }}
                  className={cn('flex h-[54px] w-full items-center gap-3.5 border-0 border-t border-ink/5 bg-transparent px-[18px] text-left text-[15.5px] active:bg-ink/8 disabled:opacity-40', m.danger ? 'text-danger-ink' : 'text-ink')}
                >
                  <m.icon className="size-[18px] flex-none opacity-80" />
                  <span className="flex-1">{m.label}</span>
                  {m.hint && <span className="text-[12.5px] text-ink/42">{m.hint}</span>}
                </button>
              ))}
            </div>
            <button type="button" onClick={onClose} className="h-14 rounded-[20px] border-0 text-[16px] font-semibold text-ink backdrop-blur-[36px] active:bg-[rgba(60,56,50,0.95)]" style={{ background: 'rgba(40,38,34,0.92)' }}>
              取消
            </button>
          </>
        )}
      </div>
    </div>
  );
}
