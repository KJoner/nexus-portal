import { catalogHost, catalogToApp, searchCatalog, UNFILED, type CatalogItem, type CatalogState } from '@nexus/shared';
import { Check, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { AppTile } from '../../icons/AppTile';
import { cn } from '../../lib/cn';
import { usePinyin } from '../../lib/pinyin';
import { useCatalog } from '../catalog/catalog-store';
import { Button, Spinner } from '../settings/ui';

/**
 * 应用商店 (UI v2 · spec 01 §5, 02 N3): a source of 添加收藏, not a destination. Search by name,
 * pinyin, alias or domain; the catalog's categories only filter (where a favorite goes is chosen as
 * a 分组). Each site says whether it is 已添加 (view the one you have) or 已选择; nothing is added
 * from here directly — the dialog has one 「添加 N 个网站」.
 */
export function StorePicker({ query, onQuery, category, onCategory, selected, onToggle, stateOf, onViewExisting, onManual, phone, autoFocus }: {
  query: string;
  onQuery(q: string): void;
  category: string | null;
  onCategory(c: string | null): void;
  selected: readonly string[];
  onToggle(item: CatalogItem): void;
  stateOf(item: CatalogItem): CatalogState;
  onViewExisting(item: CatalogItem): void;
  onManual(q: string): void;
  phone: boolean;
  autoFocus?: boolean;
}) {
  const { status, data, error, load } = useCatalog();
  const pinyin = usePinyin((s) => s.fn);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const items = useMemo(() => data?.items ?? [], [data]);
  const results = useMemo(() => searchCatalog(items, query, { category, pinyin, order: data?.categories }), [items, query, category, pinyin, data]);
  const picked = new Set(selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex h-11 flex-none items-center gap-2.5 rounded-[10px] px-3.5" style={{ background: 'rgb(var(--nx-ink-rgb)/0.05)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.1)' }}>
        <Search className="size-4 flex-none text-ink/50" aria-hidden />
        <input
          ref={input}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          aria-label="搜索应用商店"
          placeholder="搜索应用、别名或网址"
          spellCheck={false}
          autoComplete="off"
          className={cn('h-full min-w-0 flex-1 border-0 bg-transparent text-ink caret-amber outline-none', phone ? 'text-[16px]' : 'text-[14px]')}
        />
        {query && (
          <button type="button" aria-label="清空搜索" onClick={() => onQuery('')} className="grid size-8 place-items-center rounded-full border-0 bg-transparent text-ink/60 hover:bg-ink/8">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div role="group" aria-label="按分类筛选（分类只用来筛选，不是你的分组）" className="nx-scroll-hidden -mx-1 flex flex-none gap-1.5 overflow-x-auto px-1 pb-0.5">
        {[{ id: null as string | null, label: '全部', count: items.length }, ...(data?.categories ?? [])].map((c) => (
          <button
            key={c.id ?? 'all'}
            type="button"
            aria-pressed={category === c.id}
            onClick={() => onCategory(c.id)}
            className={cn('flex flex-none items-center gap-1 rounded-full border-0 px-3 text-[12.5px] transition-colors duration-150', phone ? 'h-10' : 'h-8', category === c.id ? 'bg-amber/16 text-ink shadow-[inset_0_0_0_1px_rgb(var(--nx-amber-rgb)/0.45)]' : 'bg-ink/6 text-ink/72 hover:bg-ink/10')}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div aria-busy={status === 'loading'} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {status === 'loading' && (
          <p role="status" className="m-0 flex items-center gap-2 py-3 text-[13.5px] text-ink/60">
            <Spinner /> 正在加载应用商店…
          </p>
        )}
        {status === 'error' && (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-xl p-4" style={{ background: 'rgb(var(--nx-error-rgb)/0.1)' }}>
            <p className="m-0 text-[13.5px]">{error}</p>
            <Button onClick={() => void load(true)}>
              <RefreshCw className="size-3.5" /> 重试
            </Button>
            <span className="text-[12.5px] text-ink/56">也可以在「添加网址」里手动添加。</span>
          </div>
        )}
        {status === 'ready' && results.length === 0 && (
          <div className="flex flex-col items-start gap-2.5 rounded-xl p-4" style={{ background: 'rgb(var(--nx-ink-rgb)/0.04)' }}>
            <p className="m-0 text-[14px]">{query.trim() ? `应用商店里没有「${query.trim()}」` : '这个分类暂时没有网站'}</p>
            <Button variant="primary" onClick={() => onManual(query)}>
              <Plus className="size-3.5" /> 使用此网址手动添加
            </Button>
          </div>
        )}
        {results.length > 0 && (
          <ul aria-label="应用商店的网站" className={cn('m-0 grid gap-2 p-0', phone ? 'grid-cols-1' : 'grid-cols-2')}>
            {results.map((item) => {
              const state = stateOf(item);
              const done = state !== 'new';
              const on = picked.has(item.id);
              return (
                <li key={item.id} className="list-none">
                  <div className={cn('flex items-center gap-3 rounded-xl px-3 transition-colors duration-150', phone ? 'min-h-16 py-2' : 'min-h-[68px] py-2.5', on ? 'bg-amber/12 shadow-[inset_0_0_0_1px_rgb(var(--nx-amber-rgb)/0.42)]' : 'bg-ink/[0.04] shadow-[inset_0_0_0_1px_rgb(var(--nx-ink-rgb)/0.07)] hover:bg-ink/[0.07]')}>
                    <AppTile target={{ kind: 'app', app: catalogToApp(item, [], UNFILED) }} size={36} lazy />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[14px] text-ink">{item.name}</span>
                      <span className="truncate text-[12.5px] text-ink/52">{catalogHost(item)}</span>
                    </div>
                    {done ? (
                      <button type="button" onClick={() => onViewExisting(item)} className={cn('flex flex-none items-center gap-1 rounded-lg border-0 px-2.5 text-[12px] text-amber-hi', phone ? 'h-11' : 'h-8')} style={{ background: 'rgb(var(--nx-amber-rgb)/0.12)' }} aria-label={`${item.name} 已添加，查看原条目`}>
                        <Check className="size-3.5" />
                        已添加
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={on ? `取消选择 ${item.name}` : `选择 ${item.name}`}
                        onClick={() => onToggle(item)}
                        className={cn('flex flex-none items-center justify-center gap-1 rounded-lg border-0 text-[12px]', phone ? 'h-11 min-w-11 px-3' : 'h-8 px-2.5', on ? 'bg-amber text-on-amber' : 'bg-ink/8 text-ink/80 hover:bg-ink/14')}
                      >
                        {on ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
                        {on ? '已选择' : '选择'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {status === 'ready' && results.length > 0 && query.trim() && (
          <p className="mt-3 mb-0 text-[12.5px] text-ink/52">
            没找到想要的？
            <button type="button" onClick={() => onManual(query)} className="ml-1 border-0 bg-transparent p-0 text-[12.5px] text-amber-hi underline underline-offset-2">
              使用「{query.trim()}」手动添加
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
