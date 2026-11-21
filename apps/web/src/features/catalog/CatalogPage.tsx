import { catalogHost, catalogState, catalogToApp, LOCKED_CATEGORY, looksLikeUrl, planCatalogAdd, searchCatalog, toNavigableUrl, hostOf, type CatalogItem, type CatalogState } from '@nexus/shared';
import { ArrowLeft, Check, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { PageBackdrop } from '../../components/PageBackdrop';
import { toast } from '../../components/toast-store';
import { ToastHost } from '../../components/ToastHost';
import { dispatch, useConfig } from '../../data/config-store';
import { AppTile } from '../../icons/AppTile';
import { cn } from '../../lib/cn';
import { useViewport } from '../../lib/hooks';
import { usePinyin } from '../../lib/pinyin';
import { Button, Spinner, Tag } from '../settings/ui';
import { useCatalog } from './catalog-store';

const STATE_LABEL: Record<Exclude<CatalogState, 'new'>, string> = { added: '已添加', 'same-url': '已在收藏库' };

/** 首次使用: a short, skippable pick of common sites for an empty collection (nothing pre-selected). */
export const STARTER_IDS = ['google', 'bing', 'baidu', 'gmail', 'outlook', 'chatgpt', 'deepseek', 'github', 'youtube', 'bilibili', 'zhihu', 'notion'] as const;

function StarterPicks({ items, onAdd, onSkip }: { items: CatalogItem[]; onAdd(list: CatalogItem[]): void; onSkip(): void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const chosen = items.filter((i) => picked.has(i.id));
  return (
    <section aria-labelledby="nx-starter" className="mb-4 flex flex-col gap-3 rounded-xl bg-ink/[0.055] p-4 shadow-[inset_0_0_0_1px_rgba(239,234,225,0.06)]">
      <div className="flex flex-col gap-1">
        <h2 id="nx-starter" className="m-0 text-[15px] font-medium">
          从常用网站开始
        </h2>
        <p className="m-0 text-[13px] text-ink/56">你的收藏库还是空的。勾选几个常用网站一次加入，也可以跳过，之后随时回来。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((i) => {
          const on = picked.has(i.id);
          return (
            <button
              key={i.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (on) n.delete(i.id);
                  else n.add(i.id);
                  return n;
                })
              }
              className={cn('flex h-11 items-center gap-2 rounded-full border-0 pr-3.5 pl-1.5 text-[13.5px] transition-colors duration-150', on ? 'bg-amber/18 text-ink shadow-[inset_0_0_0_1px_rgba(230,192,138,0.45)]' : 'bg-ink/8 text-ink/80 hover:bg-ink/12')}
            >
              <AppTile target={{ kind: 'app', app: catalogToApp(i, [], LOCKED_CATEGORY.none) }} size={32} lazy />
              {i.name}
              {on && <Check className="size-3.5 text-amber-hi" />}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2.5">
        <Button variant="primary" disabled={!chosen.length} onClick={() => onAdd(chosen)}>
          {chosen.length ? `加入所选 ${chosen.length} 个` : '先勾选网站'}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          跳过
        </Button>
      </div>
    </section>
  );
}

/** Where 自定义添加 sends the user: the app editor, prefilled with what they typed. */
export function customAddPath(query: string): string {
  const q = query.trim();
  if (looksLikeUrl(q)) {
    const url = toNavigableUrl(q);
    return `/settings/apps?new=${encodeURIComponent(hostOf(url).replace(/^www\./, ''))}&url=${encodeURIComponent(url)}`;
  }
  return `/settings/apps?new=${encodeURIComponent(q.slice(0, 32))}`;
}

function CatalogCard({ item, state, selected, compact, onToggle, onAdd }: { item: CatalogItem; state: CatalogState; selected: boolean; compact: boolean; onToggle(): void; onAdd(): void }) {
  const app = useMemo(() => catalogToApp(item, [], LOCKED_CATEGORY.none), [item]);
  const done = state !== 'new';
  return (
    <li className="list-none">
      <div className={cn('flex items-center gap-3 rounded-xl px-3 transition-colors duration-150', compact ? 'min-h-[64px] py-2' : 'min-h-[68px] py-2.5', selected ? 'bg-amber/12 shadow-[inset_0_0_0_1px_rgba(230,192,138,0.35)]' : 'bg-ink/[0.045] hover:bg-ink/[0.07]')}>
        <label className={cn('grid flex-none place-items-center', compact ? 'size-11' : 'size-8', done ? 'cursor-default' : 'cursor-pointer')}>
          <input type="checkbox" className="size-4 accent-[#e6c08a]" aria-label={`选择 ${item.name}`} checked={selected} disabled={done} onChange={onToggle} />
        </label>
        <AppTile target={{ kind: 'app', app }} size={40} lazy />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14.5px] text-ink">{item.name}</span>
          <span className="truncate text-[12.5px] text-ink/52">
            {catalogHost(item)}
            {item.description && ` · ${item.description}`}
          </span>
        </div>
        {done ? (
          <Tag tone={state === 'added' ? 'amber' : 'neutral'}>
            <Check className="mr-1 size-3" />
            {STATE_LABEL[state]}
          </Tag>
        ) : (
          <Button size="sm" className={cn(compact && 'h-11 min-w-11 px-3')} aria-label={`添加 ${item.name}`} onClick={onAdd}>
            <Plus className="size-3.5" />
            {!compact && '添加'}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * 应用目录 (v0.4): browse and search the public templates, add one or many to 收藏库. Adding never
 * pins unless 同时固定到首页 is ticked; a template that is already in the collection (copied before,
 * or the same address saved by hand) shows 已添加 instead of creating a duplicate.
 */
export default function CatalogPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const config = useConfig();
  const pinyin = usePinyin((s) => s.fn);
  const { status, data, error, load } = useCatalog();
  const { w } = useViewport();
  const compact = w < 640;
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [group, setGroup] = useState<string>(LOCKED_CATEGORY.none);
  const [pin, setPin] = useState(false);
  const [skipStarter, setSkipStarter] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = useMemo(() => data?.items ?? [], [data]);
  const results = useMemo(() => searchCatalog(items, query, { category, pinyin, order: data?.categories }), [items, query, category, pinyin, data]);
  const states = useMemo(() => new Map(items.map((i) => [i.id, catalogState(i, config.apps)])), [items, config.apps]);
  const groups = config.categories.filter((k) => k.id !== LOCKED_CATEGORY.hosted);
  const groupLabel = groups.find((k) => k.id === group)?.label ?? '未分类';

  // A selection that has since been added (here or on another device) is dropped from the bar.
  const chosen = items.filter((i) => selected.has(i.id) && states.get(i.id) === 'new');

  const add = (list: CatalogItem[]) => {
    const plan = planCatalogAdd(list, config, { categoryId: group, pin });
    if (!plan.ops.length) {
      toast({ msg: '所选网站都已在收藏库中', tone: 'info' });
      return;
    }
    const r = dispatch(plan.ops);
    if (!r.ok) {
      toast({ msg: `添加失败：${r.error.message}`, tone: 'error' });
      return;
    }
    const names = plan.added.map((a) => a.item.name);
    const what = names.length === 1 ? `「${names[0]}」` : `${names.length} 个网站`;
    const extra = plan.notPinned.length ? `；首页已满，${plan.notPinned.length} 个未固定` : pin ? '，并已固定到首页' : '';
    toast({ msg: `已把${what}加入「${groupLabel}」${extra}`, tone: 'undo', undo: r.undo });
    setSelected((s) => new Set([...s].filter((id) => !plan.added.some((a) => a.item.id === id))));
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    if (query) setQuery('');
    else navigate('/');
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-base text-ink">
      <PageBackdrop />
      <div className="relative mx-auto flex h-full max-w-[1200px] flex-col">
        <header className={cn('flex items-center gap-3', compact ? 'px-4 pt-4 pb-2' : 'px-8 pt-7 pb-3')}>
          <Link to="/" aria-label="返回首页" className="grid size-11 flex-none place-items-center rounded-full text-ink/80 no-underline transition-colors duration-150 hover:bg-ink/8">
            <ArrowLeft className="size-[18px]" />
          </Link>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className={cn('m-0 font-medium tracking-[-0.01em]', compact ? 'text-[20px]' : 'text-[26px]')}>应用目录</h1>
            {!compact && <p className="m-0 text-[13.5px] text-ink/56">挑选常用网站加入收藏库。默认不会固定到首页；目录以后更新，也不会改动你已添加的条目。</p>}
          </div>
          <Link to="/settings/apps" className="flex h-11 flex-none items-center rounded-xl px-3.5 text-[13.5px] text-ink/80 no-underline transition-colors duration-150 hover:bg-ink/8">
            收藏库
          </Link>
        </header>

        <div className={cn('flex flex-col gap-3', compact ? 'px-4' : 'px-8')}>
          <div className="flex h-12 items-center gap-2.5 rounded-xl px-3.5" style={{ background: 'rgba(239,234,225,0.07)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.09)' }}>
            <Search className="size-4 flex-none text-ink/50" />
            <input
              ref={input}
              autoFocus={!compact}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              aria-label="搜索应用目录"
              placeholder="搜索名称、拼音、别名或域名"
              spellCheck={false}
              autoComplete="off"
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-[15px] text-ink caret-amber outline-none"
            />
            {query && (
              <button type="button" aria-label="清空搜索" onClick={() => setQuery('')} className="grid size-8 place-items-center rounded-full border-0 bg-transparent text-ink/60 hover:bg-ink/8">
                <X className="size-4" />
              </button>
            )}
            {!compact && <kbd className="rounded-md bg-ink/8 px-1.5 py-0.5 font-sans text-[11px] text-ink/50">Ctrl K</kbd>}
          </div>

          <div role="group" aria-label="按分类筛选" className="nx-scroll-hidden -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {[{ id: null as string | null, label: '全部', count: items.length }, ...(data?.categories ?? [])].map((c) => (
              <button
                key={c.id ?? 'all'}
                type="button"
                aria-pressed={category === c.id}
                onClick={() => setCategory(c.id)}
                className={cn('flex h-9 flex-none items-center gap-1.5 rounded-full border-0 px-3.5 text-[13px] transition-colors duration-150', category === c.id ? 'bg-amber text-on-amber' : 'bg-ink/8 text-ink/78 hover:bg-ink/13', compact && 'h-11')}
              >
                {c.label}
                <span className={cn('text-[11.5px] tabular-nums', category === c.id ? 'text-on-amber/70' : 'text-ink/42')}>{c.count}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-ink/70">
            <label className="flex items-center gap-2">
              添加到
              <select value={group} onChange={(e) => setGroup(e.target.value)} className="h-9 rounded-lg border-0 bg-ink/9 px-2.5 text-[13px] text-ink outline-none" aria-label="添加到分组">
                {groups.map((k) => (
                  <option key={k.id} value={k.id} className="bg-[#2a2824]">
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-9 items-center gap-2">
              <input type="checkbox" className="size-4 accent-[#e6c08a]" checked={pin} onChange={(e) => setPin(e.target.checked)} />
              同时固定到首页
            </label>
          </div>
        </div>

        <main aria-label="应用目录结果" aria-busy={status === 'loading'} className={cn('mt-3 flex-1 overflow-y-auto', compact ? 'px-4 pb-32' : 'px-8 pb-28')}>
          {status === 'loading' && (
            <p role="status" className="flex items-center gap-2 text-[13.5px] text-ink/60">
              <Spinner /> 正在加载应用目录…
            </p>
          )}
          {status === 'error' && (
            <div role="alert" className="flex flex-col items-start gap-3 rounded-xl bg-error/10 p-5">
              <p className="m-0 text-[14px]">{error}</p>
              <Button onClick={() => void load(true)}>
                <RefreshCw className="size-3.5" /> 重试
              </Button>
            </div>
          )}
          {status === 'ready' && !skipStarter && !query.trim() && !category && config.apps.length === 0 && (
            <StarterPicks items={STARTER_IDS.map((id) => items.find((i) => i.id === id)).filter((i): i is CatalogItem => !!i)} onAdd={add} onSkip={() => setSkipStarter(true)} />
          )}
          {status === 'ready' && results.length === 0 && (
            <div className="flex flex-col items-start gap-3 rounded-xl bg-ink/[0.045] p-5">
              <p className="m-0 text-[14.5px]">{query.trim() ? `目录里没有「${query.trim()}」` : '这个分类暂时没有网站'}</p>
              <p className="m-0 text-[13px] text-ink/56">可以直接把这个网站加进你的收藏库。</p>
              <Button variant="primary" onClick={() => navigate(customAddPath(query))}>
                <Plus className="size-3.5" /> 自定义添加
              </Button>
            </div>
          )}
          {results.length > 0 && (
            <ul className="m-0 grid gap-2 p-0" style={{ gridTemplateColumns: compact ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
              {results.map((item) => (
                <CatalogCard key={item.id} item={item} state={states.get(item.id) ?? 'new'} selected={selected.has(item.id)} compact={compact} onToggle={() => toggle(item.id)} onAdd={() => add([item])} />
              ))}
            </ul>
          )}
          {status === 'ready' && results.length > 0 && query.trim() && (
            <p className="mt-4 text-[13px] text-ink/52">
              没找到想要的？
              <Link to={customAddPath(query)} className="ml-1 text-amber-hi">
                自定义添加「{query.trim()}」
              </Link>
            </p>
          )}
        </main>

        {chosen.length > 0 && (
          <div role="region" aria-label="批量添加" className={cn('absolute right-0 bottom-0 left-0 flex items-center gap-3 border-t border-ink/8 backdrop-blur-[24px]', compact ? 'px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]' : 'px-8 py-3.5')} style={{ background: 'rgba(30,28,25,0.86)' }}>
            <span className="flex-1 text-[13.5px] text-ink/80">已选 {chosen.length} 个网站 · 加入「{groupLabel}」{pin ? '并固定到首页' : ''}</span>
            <Button variant="ghost" className={cn(compact && 'h-11')} onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
            <Button variant="primary" className={cn(compact && 'h-11')} onClick={() => add(chosen)}>
              添加 {chosen.length} 项
            </Button>
          </div>
        )}
        <ToastHost variant={compact ? 'mobile' : 'desktop'} bottom={chosen.length ? 96 : 24} />
      </div>
    </div>
  );
}
