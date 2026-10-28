import { appHref, displayUrl, LOCKED_CATEGORY, matchApps, type AppEntry, type Category } from '@nexus/shared';
import { ChevronDown, ChevronUp, Copy, Ellipsis, Eye, EyeOff, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ActionSheet, type SheetState } from '../../../components/ActionSheet';
import { toast } from '../../../components/toast-store';
import { useConfig } from '../../../data/config-store';
import { useServices, type ServiceView } from '../../../data/status';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { dotStyle, LEVEL_COLOR } from '../../home/status-style';
import { apply } from '../model';
import { Button, Dialog, PageHeader, Tag, useCompact } from '../ui';
import { AppEditor } from './AppEditor';

const GRID = 'grid grid-cols-[260px_minmax(0,1fr)_112px_64px_150px_104px] items-center';

function healthOf(a: AppEntry, views: Map<string, ServiceView>) {
  if (a.kind !== 'service') return { label: '—', sub: '', color: 'rgba(239,234,225,0.36)', dot: null };
  if (!a.health.enabled) return { label: '未开启', sub: '首页显示为未监测', color: 'rgba(239,234,225,0.56)', dot: dotStyle('off', 0.4) };
  const v = views.get(a.id);
  const every = a.health.intervalSec >= 60 ? `每 ${a.health.intervalSec / 60} 分钟` : `每 ${a.health.intervalSec} 秒`;
  if (!v || v.level === 'unknown') return { label: '未知', sub: v?.message ?? '等待首次检查', color: 'rgba(239,234,225,0.66)', dot: dotStyle('unknown') };
  return { label: v.levelLabel, sub: v.level === 'ok' ? every : v.message, color: v.level === 'ok' ? 'rgba(239,234,225,0.8)' : LEVEL_COLOR[v.level], dot: dotStyle(v.level) };
}

export function AppsPage() {
  const config = useConfig();
  const compact = useCompact();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { all } = useServices();
  const views = new Map(all.map((s) => [s.app.id, s]));
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [del, setDel] = useState<string | null>(null);
  const [cats, setCats] = useState<Category[] | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const editId = params.get('edit');
  const newName = params.get('new');
  const editorOpen = (editId !== null && config.apps.some((a) => a.id === editId)) || newName !== null;
  const closeEditor = () => navigate('/settings/apps', { replace: true });

  const hiddenN = config.apps.filter((a) => a.hidden).length;
  const matched = new Set(matchApps(config.apps, q, true).map((a) => a.id));
  const list = config.apps.filter((a) => matched.has(a.id) && (cat === 'all' || (cat === 'hidden' ? a.hidden : a.categoryId === cat)));
  const chips = [{ id: 'all', label: '全部', n: config.apps.length }, ...config.categories.map((c) => ({ id: c.id, label: c.label, n: config.apps.filter((a) => a.categoryId === c.id).length })), ...(hiddenN ? [{ id: 'hidden', label: '已隐藏', n: hiddenN }] : [])];
  const catLabel = (id: string) => config.categories.find((c) => c.id === id)?.label ?? '未分类';

  const pinned = (a: AppEntry) => (a.kind === 'site' ? config.pins.includes(a.id) : a.showInServices);
  const togglePin = (a: AppEntry) => {
    const on = pinned(a);
    if (a.kind === 'service') apply({ type: 'service.setShown', appId: a.id, shown: !on }, on ? `${a.name} 已从服务区移除` : `${a.name} 已显示在服务区`);
    else apply(on ? { type: 'pin.remove', appId: a.id } : { type: 'pin.add', appId: a.id }, on ? `已从首页移除 ${a.name}` : `已固定 ${a.name} 到首页`);
  };
  const toggleHidden = (a: AppEntry) => apply({ type: 'app.setHidden', appId: a.id, hidden: !a.hidden }, a.hidden ? `${a.name} 已恢复显示` : `已隐藏 ${a.name}`);
  const copy = (a: AppEntry) => {
    navigator.clipboard?.writeText(appHref(a)).then(
      () => toast({ msg: '已复制地址', tone: 'ok' }),
      () => toast({ msg: '无法访问剪贴板', tone: 'error' }),
    );
  };
  const edit = (a: AppEntry) => navigate(`/settings/apps?edit=${encodeURIComponent(a.id)}`);
  const pinLabel = (a: AppEntry) => (a.kind === 'service' ? (pinned(a) ? '从服务区移除' : '显示在服务区') : pinned(a) ? '从首页移除' : '固定到首页');

  const delApp = del ? config.apps.find((a) => a.id === del) : undefined;
  const confirmDelete = () => {
    if (!delApp) return;
    if (apply({ type: 'app.delete', appId: delApp.id }, `已删除 ${delApp.name}`)) {
      setDel(null);
      if (editorOpen) closeEditor();
    }
  };

  const dialogs = (
    <>
      <Dialog
        open={!!delApp}
        onOpenChange={(o) => !o && setDel(null)}
        title={delApp ? `删除「${delApp.name}」？` : ''}
        description={delApp && `${pinned(delApp) && delApp.kind === 'site' ? '它会从首页、' : '它会从'}全部应用和搜索结果中移除${delApp.kind === 'service' ? '，健康检查也会停止' : ''}。删除后 6 秒内可撤销。`}
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setDel(null)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" onClick={confirmDelete}>
              删除
            </Button>
          </>
        }
      />
      {cats && <CategoriesDialog cats={cats} setCats={setCats} />}
      <ActionSheet sheet={sheet} onClose={() => setSheet(null)} />
    </>
  );

  if (compact && editorOpen) {
    return (
      <>
        <AppEditor key={editId ?? 'new'} appId={editId} initialName={newName ?? ''} onClose={closeEditor} onDelete={setDel} />
        {dialogs}
      </>
    );
  }

  const toolbar = (
    <div className={cn('flex items-center gap-2', compact ? 'nx-scroll-hidden -mx-4 overflow-x-auto px-4' : 'flex-wrap')}>
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={cat === c.id}
          onClick={() => setCat(c.id)}
          className={cn('flex flex-none items-center gap-[7px] rounded-full border-0 px-[13px] text-[13px] whitespace-nowrap transition-colors duration-140', compact ? 'h-[34px] text-[13.5px]' : 'h-[34px]', cat === c.id ? 'bg-ink/14 text-ink' : 'bg-ink/5 text-ink/66 hover:text-ink')}
        >
          {c.label}
          <span className="text-[11.5px] opacity-60">{c.n}</span>
        </button>
      ))}
    </div>
  );

  const searchBox = (
    <div className={cn('box-border flex items-center gap-[9px] px-3', compact ? 'h-11 rounded-[14px] bg-ink/8 px-3.5' : 'h-9 w-[260px] rounded-[11px] bg-ink/6')}>
      <Search className="size-3.5 flex-none text-ink/50" />
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="名称、地址或内网 IP" aria-label="筛选应用" className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-[13.5px] text-ink caret-amber outline-none" style={{ fontSize: compact ? 16 : undefined }} />
    </div>
  );

  const empty = (
    <div className="flex flex-col items-center gap-2 px-5 py-14 text-center">
      <span className="text-[16px] font-medium">{q ? `没有匹配「${q}」的应用` : '这个分类下还没有应用'}</span>
      <span className="text-[13px] text-ink/50">{q ? '可按名称、外网地址或内网 IP 查找' : '新增应用时选择该分类，或在编辑中更改分类'}</span>
      <Button variant="text" className="mt-2.5 h-[38px] bg-amber/14" onClick={() => navigate(`/settings/apps?new=${encodeURIComponent(q)}`)}>
        新增应用
      </Button>
    </div>
  );

  if (compact) {
    return (
      <>
        {searchBox}
        {toolbar}
        <div className="flex flex-col divide-y divide-ink/6 overflow-hidden rounded-2xl bg-ink/6">
          {list.map((a) => {
            const h = healthOf(a, views);
            return (
              <div key={a.id} className="flex min-h-[62px] items-center">
                <button type="button" onClick={() => edit(a)} className={cn('flex min-h-[62px] min-w-0 flex-1 items-center gap-3 border-0 bg-transparent py-2 pr-1 pl-3.5 text-left text-ink active:bg-ink/8', a.hidden && 'opacity-55')}>
                  <AppTile target={{ kind: 'app', app: a }} size={38} lazy />
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="flex items-center gap-1.5 text-[15.5px]">
                      <span className="truncate">{a.name}</span>
                      {pinned(a) && a.kind === 'site' && <Pin className="size-3 flex-none text-amber" />}
                      {a.hidden && <Tag>已隐藏</Tag>}
                    </span>
                    <span className="flex items-center gap-1.5 truncate text-[12px] text-ink/50">
                      {h.dot && <span className="size-1.5 flex-none rounded-full" style={h.dot} />}
                      <span className="truncate">{a.kind === 'service' ? `${h.label} · ${displayUrl(appHref(a))}` : displayUrl(a.url)}</span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`${a.name} 的更多操作`}
                  onClick={() =>
                    setSheet({
                      header: { target: { kind: 'app', app: a }, name: a.name, sub: displayUrl(appHref(a)) },
                      items: [
                        { label: '编辑', icon: Pencil, onSelect: () => edit(a) },
                        { label: pinLabel(a), icon: pinned(a) ? PinOff : Pin, onSelect: () => togglePin(a) },
                        { label: a.hidden ? '取消隐藏' : '隐藏', icon: a.hidden ? Eye : EyeOff, onSelect: () => toggleHidden(a) },
                        { label: '复制地址', icon: Copy, onSelect: () => copy(a) },
                        { label: '删除', icon: Trash2, danger: true, onSelect: () => setDel(a.id) },
                      ],
                    })
                  }
                  className="grid size-12 flex-none place-items-center border-0 bg-transparent text-ink/60"
                >
                  <Ellipsis className="size-[18px]" />
                </button>
              </div>
            );
          })}
          {!list.length && empty}
        </div>
        <Button variant="text" size="lg" className="w-full rounded-2xl bg-amber/14 font-medium" onClick={() => navigate('/settings/apps?new=')}>
          <Plus className="size-[18px]" />
          新增应用
        </Button>
        <Button size="lg" className="w-full rounded-2xl" onClick={() => setCats(config.categories.map((c) => ({ ...c })))}>
          管理分类
        </Button>
        {dialogs}
      </>
    );
  }

  return (
    <div className="flex max-w-[1080px] flex-col gap-5">
      <PageHeader
        title="应用与服务"
        sub="网站与自托管服务都在这里管理。点任一行编辑；自托管服务可分别填写外网与内网地址。"
        actions={
          <>
            <Button className="h-10 rounded-xl px-4 text-[13.5px]" onClick={() => setCats(config.categories.map((c) => ({ ...c })))}>
              管理分类
            </Button>
            <Button variant="primary" className="h-10 rounded-xl pr-[18px] pl-3.5 text-[13.5px]" onClick={() => navigate('/settings/apps?new=')}>
              <Plus className="size-4" />
              新增应用
            </Button>
          </>
        }
      />
      <div className="flex items-center gap-2">
        {toolbar}
        <span className="flex-1" />
        {searchBox}
      </div>
      <div className="flex flex-col rounded-[20px] bg-ink/[0.045] shadow-[inset_0_0_0_1px_rgba(239,234,225,0.05)]">
        <div className={cn(GRID, 'h-[42px] border-b border-ink/7 pr-4 pl-5 text-[12px] text-ink/46')}>
          <span>应用</span>
          <span>地址</span>
          <span>分类</span>
          <span>首页</span>
          <span>健康检查</span>
          <span />
        </div>
        {list.map((a, i) => {
          const h = healthOf(a, views);
          const svc = a.kind === 'service';
          const on = pinned(a);
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              onClick={() => edit(a)}
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && edit(a)}
              className={cn(GRID, 'box-border min-h-[62px] cursor-pointer py-2 pr-4 pl-5 transition-colors duration-100 hover:bg-ink/[0.035]', i > 0 && 'border-t border-ink/6')}
            >
              <span className={cn('flex min-w-0 items-center gap-3', a.hidden && 'opacity-55')}>
                <AppTile target={{ kind: 'app', app: a }} size={34} lazy />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-[7px] text-[14.5px]">
                    <span className="truncate">{a.name}</span>
                    {a.hidden && <Tag>已隐藏</Tag>}
                  </span>
                  <span className="truncate text-[12px] text-ink/44">{svc ? `自托管 · ${a.description || '服务'}` : '网站'}</span>
                </span>
              </span>
              <span className="flex min-w-0 flex-col gap-[3px] pr-4 font-mono text-[12px] text-ink/74">
                <span className="flex min-w-0 items-center gap-[7px]">
                  <span className="truncate">{displayUrl(a.url)}</span>
                  {svc && a.lanUrl && a.prefer === 'ext' && <Tag tone="amber">默认</Tag>}
                </span>
                {svc && a.lanUrl && (
                  <span className="flex min-w-0 items-center gap-[7px] text-ink/50">
                    <span className="flex-none font-sans text-[11px]">内网</span>
                    <span className="truncate">{displayUrl(a.lanUrl)}</span>
                    {a.prefer === 'lan' && <Tag tone="amber">默认</Tag>}
                  </span>
                )}
                {svc && !a.lanUrl && <span className="font-sans text-[11.5px] text-warn">未填写内网地址</span>}
              </span>
              <span className="text-[13px] text-ink/70">{catLabel(a.categoryId)}</span>
              <span>
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={`${pinLabel(a)}：${a.name}`}
                  title={pinLabel(a)}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePin(a);
                  }}
                  className="grid size-[34px] place-items-center rounded-[10px] border-0 hover:!bg-ink/10"
                  style={{ background: on ? 'rgba(230,192,138,0.16)' : 'transparent', color: on ? '#e6c08a' : 'rgba(239,234,225,0.4)' }}
                >
                  <Pin className="size-[15px]" />
                </button>
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-[7px] text-[13px]" style={{ color: h.color }}>
                  {h.dot && <span className="size-[7px] flex-none rounded-full" style={h.dot} />}
                  {h.label}
                </span>
                {h.sub && <span className="truncate text-[11.5px] text-ink/42">{h.sub}</span>}
              </span>
              <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" className="bg-ink/7" onClick={() => edit(a)}>
                  编辑
                </Button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger aria-label={`${a.name} 的更多操作`} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-ink/75 hover:bg-ink/8 data-[state=open]:bg-ink/8">
                    <Ellipsis className="size-[15px]" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={6} className="z-20 w-[200px] animate-[nx-pop_.14s_var(--ease-soft)] rounded-[14px] p-1.5 text-ink" style={{ background: 'rgba(40,38,34,0.97)', boxShadow: '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)' }}>
                      {[
                        { label: pinLabel(a), icon: on ? PinOff : Pin, run: () => togglePin(a) },
                        { label: a.hidden ? '取消隐藏' : '隐藏', icon: a.hidden ? Eye : EyeOff, run: () => toggleHidden(a) },
                        { label: '复制地址', icon: Copy, run: () => copy(a) },
                      ].map((m) => (
                        <DropdownMenu.Item key={m.label} onSelect={m.run} className="flex h-9 cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] outline-none data-[highlighted]:bg-ink/8">
                          <m.icon className="size-3.5 opacity-80" />
                          {m.label}
                        </DropdownMenu.Item>
                      ))}
                      <DropdownMenu.Separator className="mx-2 my-1 h-px bg-ink/7" />
                      <DropdownMenu.Item onSelect={() => setDel(a.id)} className="flex h-9 cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] text-danger-ink outline-none data-[highlighted]:bg-ink/8">
                        <Trash2 className="size-3.5 opacity-80" />
                        删除
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </span>
            </div>
          );
        })}
        {!list.length && empty}
      </div>
      {editorOpen && <AppEditor key={editId ?? 'new'} appId={editId} initialName={newName ?? ''} onClose={closeEditor} onDelete={setDel} />}
      {dialogs}
    </div>
  );
}

function CategoriesDialog({ cats, setCats }: { cats: Category[]; setCats(c: Category[] | null): void }) {
  const config = useConfig();
  const empty = cats.some((c) => !c.label.trim());
  const removed = config.categories.filter((c) => !cats.some((x) => x.id === c.id));
  const moved = config.apps.filter((a) => removed.some((r) => r.id === a.categoryId)).length;
  const update = (fn: (c: Category[]) => void) => {
    const next = cats.map((c) => ({ ...c }));
    fn(next);
    setCats(next);
  };
  const save = () => {
    if (empty) return;
    if (apply({ type: 'categories.replace', categories: cats }, moved ? `分类已更新，${moved} 个应用移到未分类` : '分类已更新')) setCats(null);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && setCats(null)}
      width={520}
      title="管理分类"
      description="分类决定「全部应用」与本页的分组顺序。「我的服务」与「未分类」为固定分类。"
      footer={
        <>
          <Button className="h-10 px-[18px]" onClick={() => setCats(null)}>
            取消
          </Button>
          <Button variant="primary" className="h-10 px-5" disabled={empty} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex max-h-[360px] flex-col divide-y divide-ink/6 overflow-y-auto rounded-2xl bg-ink/4">
        {cats.map((c, i) => {
          const n = config.apps.filter((a) => a.categoryId === c.id).length;
          const isNew = !config.categories.some((x) => x.id === c.id);
          return (
            <div key={c.id} className="flex h-[54px] items-center gap-2 pr-2 pl-3">
              <input
                value={c.label}
                disabled={c.locked}
                maxLength={16}
                onChange={(e) => update((x) => (x[i]!.label = e.target.value))}
                aria-label="分类名称"
                className="box-border h-9 min-w-0 flex-1 rounded-[9px] border-0 px-2.5 text-[14px] text-ink caret-amber outline-none disabled:bg-transparent"
                style={{ background: c.locked ? 'transparent' : 'rgba(239,234,225,0.06)', boxShadow: !c.label.trim() ? 'inset 0 0 0 1.5px rgba(233,118,95,0.7)' : 'none' }}
              />
              <span className="w-14 flex-none text-[12px] text-ink/46">{isNew ? '新建' : `${n} 个应用`}</span>
              <button type="button" aria-label="上移" disabled={i === 0} onClick={() => update((x) => ([x[i - 1], x[i]] = [x[i]!, x[i - 1]!]))} className="grid size-[30px] place-items-center rounded-lg border-0 bg-transparent text-ink disabled:opacity-30">
                <ChevronUp className="size-[13px]" />
              </button>
              <button type="button" aria-label="下移" disabled={i === cats.length - 1} onClick={() => update((x) => ([x[i + 1], x[i]] = [x[i]!, x[i + 1]!]))} className="grid size-[30px] place-items-center rounded-lg border-0 bg-transparent text-ink disabled:opacity-30">
                <ChevronDown className="size-[13px]" />
              </button>
              <button
                type="button"
                aria-label="删除分类"
                title={c.locked ? '固定分类不能删除' : n ? `删除后 ${n} 个应用移到未分类` : '删除'}
                disabled={c.locked}
                onClick={() => update((x) => x.splice(i, 1))}
                className="grid size-[30px] place-items-center rounded-lg border-0 bg-transparent text-danger-ink disabled:opacity-25"
              >
                <Trash2 className="size-[13px]" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="text"
          onClick={() =>
            update((x) => {
              const j = x.findIndex((c) => c.id === LOCKED_CATEGORY.none);
              x.splice(j < 0 ? x.length : j, 0, { id: `c${Date.now().toString(36)}`, label: '新分类', locked: false });
            })
          }
        >
          <Plus className="size-[15px]" />
          新建分类
        </Button>
        <span className={cn('flex-1 text-[12.5px]', empty ? 'text-danger-ink' : 'text-[#f1c690]')}>{empty ? '分类名称不能为空' : moved ? `${moved} 个应用将移到「未分类」` : ''}</span>
      </div>
    </Dialog>
  );
}
