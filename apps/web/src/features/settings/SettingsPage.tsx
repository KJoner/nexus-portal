import '@fontsource/jetbrains-mono/400.css';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ToastHost } from '../../components/ToastHost';
import { useConfig, useConfigStore, useSaveState } from '../../data/config-store';
import { cn } from '../../lib/cn';
import { useViewport } from '../../lib/hooks';
import { formatHm } from '../../lib/time';
import { useWallpaper } from '../home/Wallpaper';
import { lookDiff, useLookDraft } from './look-draft';
import { attention, isPage, PAGES, searchIndex, summaries, type PageId } from './model';
import { AppearancePage } from './pages/AppearancePage';
import { AppsPage } from './pages/AppsPage';
import { DataPage } from './pages/DataPage';
import { HomeLayoutPage } from './pages/HomeLayoutPage';
import { SearchPage } from './pages/SearchPage';
import { CompactContext, Spinner } from './ui';

const PAGE_VIEW: Record<PageId, () => ReactNode> = {
  appearance: () => <AppearancePage />,
  home: () => <HomeLayoutPage />,
  apps: () => <AppsPage />,
  search: () => <SearchPage />,
  data: () => <DataPage />,
};

function useSyncSummary(): string {
  const save = useSaveState();
  const revision = useConfigStore((s) => s.confirmed?.revision ?? 0);
  if (save.kind === 'offline') return `离线 · ${save.pending ? `${save.pending} 项更改待同步` : '恢复连接后自动同步'}`;
  if (save.kind === 'saving') return '正在同步…';
  return `已同步到 Nexus 服务端 · 修订 ${revision}`;
}

/** The home wallpaper pushed back to atmosphere: blur 48, brightness 42 %, 62 % warm black (R2). */
function Backdrop() {
  const look = useConfig().settings.look;
  const wp = useWallpaper(look);
  return (
    <>
      <div aria-hidden className="absolute -inset-[60px] isolate" style={{ background: wp.kind === 'photo' ? '#a69e8e' : '#1b1a17', filter: 'blur(48px) brightness(.42)' }}>
        {wp.kind === 'photo' ? <img src={wp.uploaded?.placeholder ?? wp.src} alt="" loading="lazy" className="absolute inset-0 size-full object-cover grayscale" style={{ mixBlendMode: 'multiply' }} /> : <div className="absolute inset-0" style={{ background: wp.src }} />}
        {wp.kind === 'photo' && <div className="absolute inset-0" style={{ background: '#221f1b', mixBlendMode: 'lighten' }} />}
      </div>
      <div aria-hidden className="absolute inset-0" style={{ background: 'rgba(22,21,18,0.62)' }} />
    </>
  );
}

function SaveIndicator() {
  const save = useSaveState();
  const dirty = useLookDraft((s) => lookDiff(s.draft, useConfigStore.getState().snapshot.config.settings.look));
  const { page } = useParams();
  return (
    <span role="status" aria-live="polite" className="flex items-center gap-2 text-[12.5px] text-ink/56">
      {save.kind === 'saving' && (
        <>
          <Spinner />
          正在保存…
        </>
      )}
      {save.kind === 'offline' && (
        <>
          <span className="size-[7px] rounded-full bg-warn" />
          离线 · {save.pending ? `${save.pending} 项更改待同步` : '恢复连接后自动同步'}
        </>
      )}
      {save.kind === 'saved' &&
        (dirty && page === 'appearance' ? (
          '外观有未应用的更改'
        ) : (
          <>
            <Check className="size-3.5 text-ok" />
            所有更改已保存{save.at ? ` · ${formatHm(save.at)}` : ''}
          </>
        ))}
    </span>
  );
}

function Overview({ onGo }: { onGo(page: PageId, edit?: string): void }) {
  const config = useConfig();
  const wp = useWallpaper(config.settings.look);
  const sync = useSyncSummary();
  const sum = summaries(config, wp, sync);
  const attn = attention(config);
  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[28px] font-medium tracking-[-0.01em]">设置</h1>
        <p className="m-0 text-[14px] leading-[1.7] text-ink/56">调整首页的外观、快捷方式、应用和搜索。开关类设置即时保存；外观在预览确认后应用；应用编辑需要手动保存。</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {PAGES.map((p) => (
          <button key={p.id} type="button" onClick={() => onGo(p.id)} className="flex items-start gap-4 rounded-[20px] border-0 bg-ink/[0.045] p-5 text-left text-ink shadow-[inset_0_0_0_1px_rgba(239,234,225,0.05)] transition-colors duration-140 hover:bg-ink/8">
            <span className="grid size-10 flex-none place-items-center rounded-xl bg-ink/8">
              <p.icon className="size-[18px] text-amber" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
              <span className="text-[16px] font-medium">{p.label}</span>
              <span className="text-[13px] leading-[1.6] text-ink/60">{sum[p.id]}</span>
            </span>
            <ChevronRight className="mt-3 size-4 flex-none text-ink/40" />
          </button>
        ))}
      </div>
      {attn.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <span className="px-1 text-[12.5px] font-medium text-ink/52">需要注意</span>
          <div className="flex flex-col divide-y divide-ink/6 rounded-[20px] bg-ink/[0.045] shadow-[inset_0_0_0_1px_rgba(239,234,225,0.05)]">
            {attn.map((t) => (
              <div key={t.key} className="flex min-h-16 items-center gap-4 px-5 py-3">
                <span className="size-2 flex-none rounded-full" style={{ background: t.dot }} />
                <span className="flex flex-1 flex-col gap-[3px]">
                  <span className="text-[14.5px]">{t.title}</span>
                  <span className="text-[12.5px] text-ink/50">{t.sub}</span>
                </span>
                <button type="button" onClick={() => onGo('apps', t.appId)} className="h-[34px] rounded-[10px] border-0 bg-ink/9 px-3.5 text-[13px] text-ink hover:bg-ink/15">
                  {t.action}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DesktopShell({ page }: { page: PageId | null }) {
  const navigate = useNavigate();
  const config = useConfig();
  const [q, setQ] = useState('');
  const hits = searchIndex(q);
  const counts: Partial<Record<PageId, number>> = { home: config.pins.length, apps: config.apps.length, search: config.engines.length };
  const go = (p: PageId | null, edit?: string) => {
    setQ('');
    navigate(p ? `/settings/${p}${edit ? `?edit=${encodeURIComponent(edit)}` : ''}` : '/settings');
  };
  return (
    <div className="fixed inset-0 overflow-clip bg-base">
      <Backdrop />
      <div className="absolute inset-0 grid grid-cols-[264px_minmax(0,1fr)] grid-rows-[64px_minmax(0,1fr)]">
        <header className="col-span-2 flex items-center gap-4 border-b border-ink/6 pr-7 pl-5">
          <Link to="/" className="flex h-9 items-center gap-2 rounded-[10px] pr-3 pl-2 text-[13.5px] text-ink/78 no-underline transition-colors duration-140 hover:bg-ink/8">
            <ArrowLeft className="size-4" />
            返回首页
          </Link>
          <span className="h-[18px] w-px bg-ink/12" />
          <span className="flex items-center gap-[9px] text-[15px] font-semibold">
            <span className="size-2 rounded-full bg-amber" style={{ boxShadow: '0 0 12px rgba(230,192,138,0.7)' }} />
            Nexus 设置
          </span>
          <span className="flex-1" />
          <SaveIndicator />
        </header>
        <nav aria-label="设置分组" className="flex min-h-0 flex-col gap-1 border-r border-ink/6 px-4 py-5">
          <div className="mb-3 flex h-10 items-center gap-[9px] rounded-xl bg-ink/6 px-3">
            <Search className="size-3.5 flex-none text-ink/50" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits[0]) go(hits[0].page);
                if (e.key === 'Escape' && q) {
                  e.preventDefault();
                  setQ('');
                }
              }}
              placeholder="搜索设置"
              aria-label="搜索设置"
              className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-ink caret-amber outline-none"
            />
          </div>
          {q.trim() ? (
            <>
              {hits.map((h) => (
                <button key={h.label} type="button" onClick={() => go(h.page)} className="flex flex-col items-start gap-0.5 rounded-[11px] border-0 bg-transparent px-3 py-[9px] text-left text-ink hover:bg-ink/7">
                  <span className="text-[13.5px]">{h.label}</span>
                  <span className="text-[11.5px] text-ink/46">{PAGES.find((p) => p.id === h.page)!.label}</span>
                </button>
              ))}
              {!hits.length && <span className="px-3 py-2.5 text-[13px] text-ink/50">没有匹配「{q}」的设置</span>}
            </>
          ) : (
            <>
              <NavItem current={page === null} onClick={() => go(null)} icon={<SlidersHorizontal className="size-4" />} label="概览" />
              <div className="mx-3 my-2 h-px bg-ink/6" />
              {PAGES.map((p) => (
                <NavItem key={p.id} current={page === p.id} onClick={() => go(p.id)} icon={<p.icon className="size-4" />} label={p.label} count={counts[p.id]} />
              ))}
            </>
          )}
          <span className="flex-1" />
          <span className="px-3 text-[12px] leading-[1.6] text-ink/42">按 esc 关闭面板与对话框</span>
        </nav>
        <div className="relative min-h-0">
          <div className="absolute inset-0 overflow-x-hidden overflow-y-auto" id="nx-settings-scroll">
            <div className="box-border flex flex-col gap-7 px-12 pt-9 pb-36">{page ? PAGE_VIEW[page]() : <Overview onGo={go} />}</div>
          </div>
        </div>
      </div>
      <ToastHost variant="desktop" durationMs={6000} />
    </div>
  );
}

function NavItem({ current, onClick, icon, label, count }: { current: boolean; onClick(): void; icon: ReactNode; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      className={cn('flex h-[42px] items-center gap-3 rounded-xl border-0 px-3 text-left text-[14px] transition-colors duration-140 hover:bg-ink/7', current ? 'bg-ink/10 text-ink' : 'bg-transparent text-ink/68')}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="text-[12px] text-ink/42">{count}</span>}
    </button>
  );
}

function MobileRoot() {
  const navigate = useNavigate();
  const config = useConfig();
  const wp = useWallpaper(config.settings.look);
  const sync = useSyncSummary();
  const sum = summaries(config, wp, sync);
  const attn = attention(config);
  const [q, setQ] = useState('');
  const hits = searchIndex(q);
  return (
    <div className="flex animate-[nx-push_.32s_var(--ease-emph)] flex-col gap-5">
      <h1 className="mx-1 my-0 text-[32px] font-medium tracking-[-0.01em]">设置</h1>
      <div className="flex h-11 items-center gap-[9px] rounded-[14px] bg-ink/8 px-3.5">
        <Search className="size-4 flex-none text-ink/50" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索设置" aria-label="搜索设置" className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-[16px] text-ink caret-amber outline-none" />
      </div>
      {q.trim() ? (
        <div className="flex flex-col divide-y divide-ink/7 overflow-hidden rounded-2xl bg-ink/6">
          {hits.map((h) => (
            <button key={h.label} type="button" onClick={() => navigate(`/settings/${h.page}`)} className="flex min-h-14 items-center gap-3 border-0 bg-transparent px-4 py-2 text-left text-ink active:bg-ink/8">
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-[16px]">{h.label}</span>
                <span className="text-[12.5px] text-ink/50">{PAGES.find((p) => p.id === h.page)!.label}</span>
              </span>
              <ChevronRight className="size-4 text-ink/36" />
            </button>
          ))}
          {!hits.length && <div className="px-4 py-[18px] text-[14px] text-ink/50">没有匹配「{q}」的设置</div>}
        </div>
      ) : (
        <>
          <div className="flex flex-col divide-y divide-ink/7 overflow-hidden rounded-2xl bg-ink/6">
            {PAGES.map((p) => (
              <button key={p.id} type="button" onClick={() => navigate(`/settings/${p.id}`)} className="flex min-h-16 items-center gap-3.5 border-0 bg-transparent px-3.5 py-2.5 text-left text-ink active:bg-ink/8">
                <span className="grid size-[34px] flex-none place-items-center rounded-[10px] bg-ink/9">
                  <p.icon className="size-[17px] text-amber" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="text-[16px]">{p.label}</span>
                  <span className="truncate text-[12.5px] text-ink/52">{sum[p.id]}</span>
                </span>
                <ChevronRight className="size-4 flex-none text-ink/36" />
              </button>
            ))}
          </div>
          {attn.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="px-4 text-[13px] text-ink/50">需要注意</span>
              <div className="flex flex-col divide-y divide-ink/7 overflow-hidden rounded-2xl bg-ink/6">
                {attn.map((t) => (
                  <button key={t.key} type="button" onClick={() => navigate(`/settings/apps?edit=${t.appId}`)} className="flex min-h-[60px] items-center gap-3 border-0 bg-transparent px-4 py-2.5 text-left text-ink active:bg-ink/10">
                    <span className="size-2 flex-none rounded-full" style={{ background: t.dot }} />
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="text-[15px]">{t.title}</span>
                      <span className="text-[12.5px] text-ink/50">{t.sub}</span>
                    </span>
                    <ChevronRight className="size-4 text-ink/36" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <span className="px-4 text-[12.5px] leading-[1.6] text-ink/42">{sync}</span>
        </>
      )}
    </div>
  );
}

function MobileShell({ page }: { page: PageId | null }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const config = useConfig();
  const editing = page === 'apps' && (params.has('edit') || params.has('new'));
  const editApp = editing ? config.apps.find((a) => a.id === params.get('edit')) : undefined;
  const [scrolled, setScrolled] = useState(false);
  const title = editing ? (editApp ? `编辑 ${editApp.name}` : '新增应用') : page ? PAGES.find((p) => p.id === page)!.short : '';
  const back = editing ? { label: '应用', to: '/settings/apps' } : page ? { label: '设置', to: '/settings' } : null;

  useEffect(() => setScrolled(false), [page, editing]);

  return (
    <div className="nx-touch fixed inset-0 overflow-clip bg-base" style={{ height: '100dvh' }}>
      <Backdrop />
      <div
        className="absolute inset-x-0 z-5 flex h-12 items-center px-2 backdrop-blur-[24px] transition-colors duration-200"
        style={{ top: 'env(safe-area-inset-top)', background: scrolled ? 'rgba(27,26,23,0.72)' : 'transparent' }}
      >
        {back ? (
          <button type="button" onClick={() => navigate(back.to)} className="flex h-11 min-w-11 items-center gap-0.5 border-0 bg-transparent pr-2.5 pl-1 text-[16px] text-amber-hi">
            <ChevronLeft className="size-[22px]" />
            {back.label}
          </button>
        ) : (
          <Link to="/" className="flex h-11 items-center gap-0.5 pr-2.5 pl-1 text-[16px] text-amber-hi no-underline">
            <ChevronLeft className="size-[22px]" />
            首页
          </Link>
        )}
        <span className="absolute right-24 left-24 truncate text-center text-[16px] font-semibold transition-opacity duration-200" style={{ opacity: page ? 1 : scrolled ? 1 : 0 }}>
          {title || '设置'}
        </span>
        <span className="flex-1" />
        {page === 'apps' && !editing && (
          <button type="button" onClick={() => navigate('/settings/apps?new=')} aria-label="新增应用" className="grid size-11 place-items-center border-0 bg-transparent text-amber-hi">
            <Plus className="size-[22px]" />
          </button>
        )}
      </div>
      <div
        className="nx-scroll-hidden absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)}
        id="nx-settings-scroll"
      >
        <div className="box-border flex min-h-full flex-col gap-6 px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 56px)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 140px)' }}>
          {page ? (
            <div key={page + String(editing)} className="flex animate-[nx-push_.32s_var(--ease-emph)] flex-col gap-[22px]">
              {PAGE_VIEW[page]()}
            </div>
          ) : (
            <MobileRoot />
          )}
        </div>
      </div>
      <ToastHost variant="mobile" bottom="calc(env(safe-area-inset-bottom) + 24px)" durationMs={6000} />
    </div>
  );
}

export default function SettingsPage() {
  const { page } = useParams();
  const { w, h } = useViewport();
  const current = isPage(page) ? page : null;
  const compact = !(w >= 900 && h >= 560);
  useEffect(() => {
    document.title = current ? `${PAGES.find((p) => p.id === current)!.label} · Nexus 设置` : 'Nexus 设置';
    return () => {
      document.title = 'Nexus';
    };
  }, [current]);
  return <CompactContext.Provider value={compact}>{compact ? <MobileShell page={current} /> : <DesktopShell page={current} />}</CompactContext.Provider>;
}
