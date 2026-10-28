import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AppTile, type TileTarget } from '../icons/AppTile';
import { cn } from '../lib/cn';

export type MenuItem =
  | { label: string; icon: LucideIcon; onSelect: () => void; hint?: string; disabled?: boolean; danger?: boolean }
  | 'sep';

export interface MenuState {
  x: number;
  y: number;
  header: { target: TileTarget; name: string; sub: string };
  items: MenuItem[];
  /** Opened by keyboard (Shift+F10 / ContextMenu key): focus moves into the menu. */
  keyboard: boolean;
  origin: HTMLElement | null;
}

interface Props {
  menu: MenuState;
  onClose(refocus: boolean): void;
}

const WIDTH = 240;

export function ContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 280;
    setPos({ x: Math.max(8, Math.min(menu.x, window.innerWidth - WIDTH - 12)), y: Math.max(8, Math.min(menu.y, window.innerHeight - h - 12)) });
  }, [menu.x, menu.y]);

  useEffect(() => {
    if (!menu.keyboard) return;
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [menu]);

  const onKey = (e: KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      buttons[(i + d + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[24]"
        onClick={() => onClose(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose(false);
        }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={menu.header.name}
        onKeyDown={onKey}
        className="fixed z-[25] origin-top-left animate-[nx-pop_.14s_var(--ease-soft)] rounded-2xl p-1.5 backdrop-blur-[30px]"
        style={{ left: pos.x, top: pos.y, width: WIDTH, background: 'rgba(36,34,30,0.95)', boxShadow: '0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)' }}
      >
        <div className="flex items-center gap-2.5 px-2.5 pt-2 pb-2.5">
          <AppTile target={menu.header.target} size={28} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] font-medium">{menu.header.name}</span>
            <span className="truncate text-[11.5px] text-ink/46">{menu.header.sub}</span>
          </span>
        </div>
        {menu.items.map((m, i) =>
          m === 'sep' ? (
            <div key={`sep${i}`} className="mx-2.5 my-[5px] h-px bg-ink/8" />
          ) : (
            <button
              key={m.label}
              type="button"
              role="menuitem"
              disabled={m.disabled}
              onClick={() => {
                onClose(false);
                m.onSelect();
              }}
              className={cn(
                'flex h-[38px] w-full items-center gap-[11px] rounded-[10px] border-0 bg-transparent px-2.5 text-left text-[13.5px] hover:bg-ink/8 focus-visible:bg-ink/8 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent',
                m.danger ? 'text-danger-ink' : 'text-ink',
              )}
            >
              <m.icon className="size-[15px] flex-none opacity-80" />
              <span className="flex-1">{m.label}</span>
              {m.hint && <span className="text-[11.5px] text-ink/42">{m.hint}</span>}
            </button>
          ),
        )}
      </div>
    </>
  );
}

/** Menu coordinates from a contextmenu event, falling back to the element for keyboard-opened menus. */
export function menuPoint(e: { clientX: number; clientY: number; currentTarget: EventTarget; nativeEvent: Event }): { x: number; y: number; keyboard: boolean } {
  const pt = (e.nativeEvent as PointerEvent).pointerType;
  const keyboard = pt === '' || (e.clientX === 0 && e.clientY === 0);
  if (!keyboard) return { x: e.clientX, y: e.clientY, keyboard };
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + 12, y: r.bottom + 4, keyboard };
}
