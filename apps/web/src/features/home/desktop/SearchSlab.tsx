import type { Engine, SearchRow, SearchSection } from '@nexus/shared';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useConfig } from '../../../data/config-store';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { activateRow, rowTile, useSearchModel, type QuickActionId } from '../search-model';

export interface SearchSlabHandle {
  focus(): void;
}

interface Props {
  /** Body shown while the search is idle (the Dock). */
  dock: ReactNode;
  dockHeight: number;
  edit: boolean;
  maxPanel: number;
  onFocusSearch(): void;
  onAction(id: QuickActionId): void;
}

const keepFocus = (e: React.MouseEvent) => {
  if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
};

function panelHeight(sections: SearchSection[], max: number) {
  return Math.min(8 + sections.reduce((n, s) => n + 30 + s.rows.length * 46, 0) + 44 + 6, max);
}

export const SearchSlab = forwardRef<SearchSlabHandle, Props>(function SearchSlab({ dock, dockHeight, edit, maxPanel, onFocusSearch, onAction }, ref) {
  const config = useConfig();
  const defaultEngine = config.settings.search.defaultEngine;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const [engineId, setEngineId] = useState(defaultEngine);
  const [engMenu, setEngMenu] = useState(false);
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const engBtnRef = useRef<HTMLButtonElement>(null);
  const engMenuRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const kbMenu = useRef(false);

  useEffect(() => setEngineId(defaultEngine), [defaultEngine]);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const { engines, result, rows } = useSearchModel(q, engineId, 3);
  const engine = engines.find((e) => e.id === engineId) ?? engines[0] ?? config.engines[0]!;
  const shown = result.engine;

  useEffect(() => {
    if (engMenu && kbMenu.current) {
      engMenuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
      kbMenu.current = false;
    }
  }, [engMenu]);

  const close = () => {
    setQ('');
    setOpen(false);
    setEngMenu(false);
    setSel(-1);
    inputRef.current?.blur();
  };

  const cycle = (dir: number) => {
    const i = engines.findIndex((e) => e.id === engine.id);
    setEngineId(engines[(i + dir + engines.length) % engines.length]!.id);
    setSel(q.trim() ? 0 : -1);
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 1400);
  };

  const activate = (row: SearchRow, newTab: boolean) => {
    if (row.kind === 'action') close();
    activateRow(row, config, newTab, onAction);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      cycle(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      setSel((s) => (s + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      setSel((s) => (s <= 0 ? n - 1 : s - 1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const row = sel >= 0 ? rows[sel] : undefined;
      if (row) activate(row, e.ctrlKey || e.metaKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (engMenu) setEngMenu(false);
      else if (q) {
        setQ('');
        setSel(-1);
      } else close();
    }
  };

  const onEngMenuKey = (e: KeyboardEvent) => {
    const bs = [...(engMenuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      setEngMenu(false);
      engBtnRef.current?.focus();
    }
  };

  /** Closing when focus leaves the search zone keeps Tab → Dock working (R1.5 · 标准焦点顺序). */
  const onSlabBlur = (e: FocusEvent) => {
    const t = e.relatedTarget as HTMLElement | null;
    if (!t?.closest('[data-zone="search"]')) {
      setOpen(false);
      setEngMenu(false);
    }
  };

  const hasQ = !!q.trim();
  const isUrlFirst = result.sections[0]?.id === 'url';
  const bodyH = open ? panelHeight(result.sections, maxPanel) : dockHeight;
  const engLine = flash ? `已切换到 ${engine.name}` : result.prefixed ? `临时使用 ${shown.name}` : engine.kind === 'linkwarden' ? '正在搜索 Linkwarden 收藏' : `引擎 · ${engine.name}`;
  let idx = -1;

  return (
    <div
      onBlur={onSlabBlur}
      className="group/slab relative rounded-3xl backdrop-blur-[32px] backdrop-saturate-[1.15] transition-shadow duration-200 ease-soft"
      style={{
        background: 'rgba(26,25,22,0.48)',
        boxShadow: open
          ? '0 34px 90px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(230,192,138,0.34)'
          : edit
            ? '0 30px 80px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(230,192,138,0.28)'
            : '0 30px 80px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)',
      }}
    >
      <div data-zone="search" className="flex h-[66px] items-center gap-3 pr-3.5 pl-[13px]">
        <button
          ref={engBtnRef}
          type="button"
          onMouseDown={keepFocus}
          onClick={() => setEngMenu((v) => !v)}
          onKeyDown={(e) => {
            if (['ArrowDown', 'Enter', ' '].includes(e.key)) {
              e.preventDefault();
              kbMenu.current = true;
              setEngMenu(true);
            }
          }}
          aria-haspopup="listbox"
          aria-expanded={engMenu}
          aria-label={`搜索引擎：${engine.name}，按 Enter 更换`}
          title="切换搜索引擎（Alt+↑↓）"
          className={cn('flex h-10 flex-none items-center gap-1.5 rounded-xl border-0 pr-2 pl-2.5 transition-colors duration-140 hover:bg-ink/10', engMenu ? 'bg-ink/10' : 'bg-transparent')}
        >
          <AppTile target={{ kind: 'engine', engine: shown }} size={22} />
          <span className="text-[10px] text-ink/50">▾</span>
        </button>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(e.target.value.trim() ? 0 : -1);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            onFocusSearch();
          }}
          onKeyDown={onKey}
          placeholder={engine.kind === 'linkwarden' ? '在收藏中查找' : '搜索、输入网址，或打开应用'}
          role="combobox"
          aria-expanded={open}
          aria-controls="nx-results"
          aria-autocomplete="list"
          aria-activedescendant={open && sel >= 0 ? `nx-opt-${sel}` : undefined}
          aria-label="搜索"
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[18px] text-ink caret-amber outline-none"
        />
        <span className="flex flex-none items-center gap-2 text-[12px] text-ink/50">
          <span>{!open ? '' : hasQ ? (isUrlFirst ? '前往' : '打开') : '关闭'}</span>
          <kbd className="grid h-6 min-w-6 place-items-center rounded-[7px] px-1.5 font-sans text-[12px] text-ink/62 shadow-[inset_0_0_0_1px_rgba(239,234,225,0.2)]">{!open ? '/' : hasQ ? '↵' : 'esc'}</kbd>
        </span>
      </div>
      <div className="mx-[22px] h-px bg-ink/8" />
      <div className="relative overflow-hidden transition-[height] duration-320 ease-emph" style={{ height: bodyH }}>
        <div
          className="absolute inset-0 transition-[opacity,transform] ease-soft"
          style={{ opacity: open ? 0 : 1, transform: open ? 'translateY(-6px)' : 'none', pointerEvents: open ? 'none' : 'auto', transitionDuration: '140ms, 200ms' }}
        >
          {dock}
        </div>
        <div
          data-zone="search"
          onMouseDown={keepFocus}
          inert={!open}
          className="absolute inset-0 flex flex-col px-2 pt-2 transition-[opacity,transform] ease-soft"
          style={{ opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(6px)', pointerEvents: open ? 'auto' : 'none', transitionDuration: '200ms, 240ms', transitionDelay: '40ms' }}
        >
          <div id="nx-results" role="listbox" aria-label="搜索结果" className="nx-scroll-hidden min-h-0 flex-1 overflow-y-auto">
            {result.sections.map((sec) => (
              <div key={sec.id} role="group" aria-label={sec.title}>
                <div className="flex h-[30px] items-end px-3.5 pb-1.5 text-[11.5px] text-ink/46">{sec.title}</div>
                {sec.rows.map((row) => {
                  const my = ++idx;
                  const selected = my === sel;
                  const href = 'href' in row ? row.href : undefined;
                  return (
                    <a
                      key={row.key}
                      id={`nx-opt-${my}`}
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      href={href ?? '#'}
                      onMouseEnter={() => sel !== my && setSel(my)}
                      onClick={(e) => {
                        e.preventDefault();
                        activate(row, e.ctrlKey || e.metaKey || e.button === 1);
                      }}
                      className={cn('flex h-[46px] items-center gap-3.5 rounded-xl px-3.5 text-ink no-underline transition-colors duration-90', selected ? 'bg-ink/9' : 'bg-transparent')}
                    >
                      <AppTile target={rowTile(row, config, shown)} size={30} />
                      <span className="truncate text-[14.5px]">{row.title}</span>
                      <span className="truncate text-[12.5px] text-ink/46">{row.sub}</span>
                      <span className="flex-1" />
                      {row.meta && <span className="flex-none text-[12px] text-ink/46">{row.meta}</span>}
                      <span className="flex-none text-[12px] text-ink/62" style={{ opacity: selected ? 1 : 0 }}>
                        ↵
                      </span>
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-1 flex h-10 flex-none items-center gap-[18px] border-t border-ink/6 px-3.5 text-[11.5px] text-ink/42">
            <span>↑↓ 选择</span>
            <span>↵ 打开</span>
            <span>Alt ↑↓ 切换引擎</span>
            <span>esc 清空 / 关闭</span>
            <span className="flex-1" />
            <span className="transition-colors duration-200" style={{ color: flash ? '#e6c08a' : undefined }}>
              {engLine}
            </span>
          </div>
        </div>
      </div>

      <EngineMenu
        ref={engMenuRef}
        open={engMenu}
        engines={engines}
        current={engine.id}
        onKeyDown={onEngMenuKey}
        onPick={(id) => {
          setEngineId(id);
          setEngMenu(false);
          setSel(q.trim() ? 0 : -1);
          inputRef.current?.focus();
        }}
      />
    </div>
  );
});

interface EngineMenuProps {
  open: boolean;
  engines: Engine[];
  current: string;
  onPick(id: string): void;
  onKeyDown(e: KeyboardEvent): void;
}

const EngineMenu = forwardRef<HTMLDivElement, EngineMenuProps>(function EngineMenu({ open, engines, current, onPick, onKeyDown }, ref) {
  return (
    <div
      ref={ref}
      data-zone="search"
      role="listbox"
      aria-label="搜索引擎"
      inert={!open}
      onMouseDown={keepFocus}
      onKeyDown={onKeyDown}
      className="absolute top-[62px] left-2.5 z-[5] w-60 origin-top-left rounded-2xl p-1.5 backdrop-blur-[30px] transition-[opacity,transform] duration-200 ease-soft"
      style={{
        background: 'rgba(34,32,28,0.92)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
        opacity: open ? 1 : 0,
        transform: open ? 'none' : 'translateY(-4px) scale(.98)',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {engines.map((e) => (
        <button
          key={e.id}
          type="button"
          role="option"
          aria-selected={e.id === current}
          onClick={() => onPick(e.id)}
          className={cn('flex h-[42px] w-full items-center gap-3 rounded-[11px] border-0 px-2.5 text-left text-[14px] text-ink transition-colors duration-90 hover:bg-ink/8', e.id === current ? 'bg-ink/6' : 'bg-transparent')}
        >
          <AppTile target={{ kind: 'engine', engine: e }} size={24} />
          <span className="flex-1">{e.name}</span>
          {e.prefix && <span className="font-mono text-[11px] text-ink/36">{e.prefix}</span>}
          <span className="w-3 text-[12px] text-amber">{e.id === current ? '✓' : ''}</span>
        </button>
      ))}
      <div className="px-2.5 pt-2 pb-1 text-[11.5px] text-ink/42">在搜索框内按 Alt ↑↓ 快速切换</div>
    </div>
  );
});
