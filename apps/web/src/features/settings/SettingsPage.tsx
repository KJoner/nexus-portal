import '@fontsource/jetbrains-mono/400.css';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { PageBackdrop as Backdrop } from '../../components/PageBackdrop';
import { ToastHost } from '../../components/ToastHost';
import { useConfig, useConfigStore, useSaveState } from '../../data/config-store';
import { cn } from '../../lib/cn';
import { host } from '../../lib/host';
import { useViewport } from '../../lib/hooks';
import { formatHm } from '../../lib/time';
import { useWallpaper } from '../home/Wallpaper';
import { lookDiff, useLookDraft } from './look-draft';
import { attention, GROUPS, groupOf, groupSummary, isPage, pageOf, searchIndex, summaries, whereIs, type GroupId, type PageId } from './model';
import { AccountPage } from './pages/AccountPage';
import { AppearancePage } from './pages/AppearancePage';
import { AppsPage } from './pages/AppsPage';
import { DataPage } from './pages/DataPage';
import { DisplayPage } from './pages/DisplayPage';
import { HomeLayoutPage } from './pages/HomeLayoutPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { SearchPage } from './pages/SearchPage';
import { CompactContext, Spinner, useCompact } from './ui';

const PAGE_VIEW: Record<PageId, () => ReactNode> = {
  appearance: () => <AppearancePage />,
  display: () => <DisplayPage />,
  home: () => <HomeLayoutPage />,
  apps: () => <AppsPage />,
  search: () => <SearchPage />,
  account: () => <AccountPage />,
  data: () => <DataPage />,
  privacy: () => <PrivacyPage />,
};

/** The page a group opens on (its first page). */
const firstPage = (g: GroupId) => GROUPS.find((x) => x.id === g)!.pages[0]!;
const MAIN = GROUPS.filter((g) => !g.manage);
const MANAGE = GROUPS.filter((g) => g.manage);

/**
 * 一组里的几页（首页与外观：壁纸与主题 / 首页显示 / 快捷方式），用页内分页切换。每页仍是自己的地址，
 * 旧链接与书签照常打开（A08）；切换用 replace，手机的「返回」仍回到设置首页。
 */
function GroupTabs({ page }: { page: PageId }) {
  const group = groupOf(page);
  const compact = useCompact();
  if (group.pages.length < 2) return null;
  return (
    <div className={cn('flex items-center gap-3', compact && 'flex-col items-stretch gap-0')}>
      {!compact && <span className="text-[13px] text-ink/50">{group.label}</span>}
      <nav aria-label={`${group.label}的分页`} className={cn('flex gap-0.5 rounded-[12px] bg-ink/6 p-[3px]', compact ? 'w-full' : 'self-start')}>
        {group.pages.map((id) => (
          <Link
            key={id}
            to={`/settings/${id}`}
            replace
            aria-current={id === page ? 'page' : undefined}
            className={cn('flex items-center justify-center rounded-[9px] text-[13.5px] no-underline transition-colors duration-140', compact ? 'h-10 flex-1 px-2 text-[14px]' : 'h-9 px-4', id === page ? 'bg-ink/14 text-ink' : 'text-ink/62 hover:text-ink')}
          >
            {pageOf(id).label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function useSyncSummary(): string {
  const save = useSaveState();
  const revision = useConfigStore((s) => s.confirmed?.revision ?? 0);
  const space = useConfigStore((s) => s.space);
  if (save.kind === 'error') return `没有保存 · ${save.message}`;
  if (space === 'local') return `仅保存在${host.localWhere} · 登录后可同步`;
  if (save.kind === 'offline') return `离线 · ${save.pending ? `${save.pending} 项更改待同步` : '恢复连接后自动同步'}`;
  if (save.kind === 'saving') return '正在同步…';
  return `已同步到账号 · 修订 ${revision}`;
}

function SaveIndicator() {
  const save = useSaveState();
  const space = useConfigStore((s) => s.space);
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
      {save.kind === 'error' && (
        <Link to="/settings/data" className="flex items-center gap-2 text-danger-ink no-underline">
          <span className="size-[7px] rounded-full bg-danger-ink" />
          没有保存 · 查看
        </Link>
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
            {space === 'local' ? `已保存到${host.localWhere}` : '所有更改已保存'}
            {save.at ? ` · ${formatHm(save.at)}` : ''}
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
        <p className="m-0 text-[14px] leading-[1.7] text-ink/56">首页与外观、搜索、账号与同步、数据与备份、隐私与展示。开关类设置即时保存；壁纸与主题在预览确认后应用；网站编辑需要手动保存。</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {[...MAIN, ...MANAGE].map((g) => (
          <button key={g.id} type="button" onClick={() => onGo(firstPage(g.id))} className="flex items-start gap-4 rounded-[20px] border-0 bg-ink/[0.045] p-5 text-left text-ink shadow-[inset_0_0_0_1px_rgba(239,234,225,0.05)] transition-colors duration-140 hover:bg-ink/8">
            <span className="grid size-10 flex-none place-items-center rounded-xl bg-ink/8">
              <g.icon className="size-[18px] text-amber" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
              <span className="text-[16px] font-medium">{g.label}</span>
              <span className="text-[13px] leading-[1.6] text-ink/60">{groupSummary(g.id, sum)}</span>
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
  const counts: Partial<Record<GroupId, number>> = { apps: config.apps.length, search: config.engines.length };
  const here = page ? groupOf(page).id : null;
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
                  <span className="text-[11.5px] text-ink/46">{whereIs(h.page)}</span>
                </button>
              ))}
              {!hits.length && <span className="px-3 py-2.5 text-[13px] text-ink/50">没有匹配「{q}」的设置</span>}
            </>
          ) : (
            <>
              <NavItem current={page === null} onClick={() => go(null)} icon={<SlidersHorizontal className="size-4" />} label="概览" />
              <div className="mx-3 my-2 h-px bg-ink/6" />
              {MAIN.map((g) => (
                <NavItem key={g.id} current={here === g.id} onClick={() => go(firstPage(g.id))} icon={<g.icon className="size-4" />} label={g.label} count={counts[g.id]} />
              ))}
              <div className="mx-3 mt-3 mb-1 text-[11.5px] text-ink/42">管理</div>
              {MANAGE.map((g) => (
                <NavItem key={g.id} current={here === g.id} onClick={() => go(firstPage(g.id))} icon={<g.icon className="size-4" />} label={g.label} count={counts[g.id]} />
              ))}
            </>
          )}
          <span className="flex-1" />
          <span className="px-3 text-[12px] leading-[1.6] text-ink/42">按 esc 关闭面板与对话框</span>
        </nav>
        <div className="relative min-h-0">
          <div className="absolute inset-0 overflow-x-hidden overflow-y-auto" id="nx-settings-scroll">
            <div className="box-border flex flex-col gap-7 px-12 pt-9 pb-36">
              {page ? (
                <>
                  <GroupTabs page={page} />
                  {PAGE_VIEW[page]()}
                </>
              ) : (
                <Overview onGo={go} />
              )}
            </div>
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
                <span className="text-[12.5px] text-ink/50">{whereIs(h.page)}</span>
              </span>
              <ChevronRight className="size-4 text-ink/36" />
            </button>
          ))}
          {!hits.length && <div className="px-4 py-[18px] text-[14px] text-ink/50">没有匹配「{q}」的设置</div>}
        </div>
      ) : (
        <>
          {[MAIN, MANAGE].map((list, i) => (
            <div key={i} className="flex flex-col gap-2">
              {i > 0 && <span className="px-4 text-[13px] text-ink/50">管理</span>}
              <div className="flex flex-col divide-y divide-ink/7 overflow-hidden rounded-2xl bg-ink/6">
                {list.map((g) => (
                  <button key={g.id} type="button" onClick={() => navigate(`/settings/${firstPage(g.id)}`)} className="flex min-h-16 items-center gap-3.5 border-0 bg-transparent px-3.5 py-2.5 text-left text-ink active:bg-ink/8">
                    <span className="grid size-[34px] flex-none place-items-center rounded-[10px] bg-ink/9">
                      <g.icon className="size-[17px] text-amber" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="text-[16px]">{g.label}</span>
                      <span className="truncate text-[12.5px] text-ink/52">{groupSummary(g.id, sum)}</span>
                    </span>
                    <ChevronRight className="size-4 flex-none text-ink/36" />
                  </button>
                ))}
              </div>
            </div>
          ))}
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
  // An existing site's address and title are edited in 收藏库 (U2b): here only how it shows on the home page.
  const title = editing ? (editApp ? (editApp.kind === 'site' ? `首页显示 · ${editApp.name}` : `编辑 ${editApp.name}`) : '添加网站') : page ? groupOf(page).label : '';
  const back = editing ? { label: '网站与服务', to: '/settings/apps' } : page ? { label: '设置', to: '/settings' } : null;

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
          <button type="button" onClick={() => navigate('/settings/apps?new=')} aria-label="添加网站" className="grid size-11 place-items-center border-0 bg-transparent text-amber-hi">
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
              {!editing && <GroupTabs page={page} />}
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
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const current = isPage(page) ? page : null;
  // v0.5: the account moved from 数据、同步与安全 to 账号与同步; links the server still sends
  // (identity claim: /settings/data?linked=1 | ?auth_error=…; an extension's pairing: ?pair=…) land there.
  useEffect(() => {
    if (page === 'data' && (params.has('linked') || params.has('auth_error') || params.has('pair'))) navigate(`/settings/account?${params}`, { replace: true });
  }, [page, params, navigate]);
  const compact = !(w >= 900 && h >= 560);
  useEffect(() => {
    document.title = current ? `${whereIs(current)} · Nexus 设置` : 'Nexus 设置';
    return () => {
      document.title = 'Nexus';
    };
  }, [current]);
  return <CompactContext.Provider value={compact}>{compact ? <MobileShell page={current} /> : <DesktopShell page={current} />}</CompactContext.Provider>;
}
