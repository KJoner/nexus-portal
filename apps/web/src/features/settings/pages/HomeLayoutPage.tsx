import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { DOCK_SIZE_MAX, DOCK_SIZE_MIN, hostOf, MAX_PINS, pinnedSites, shownServices, type AppEntry, type Settings } from '@nexus/shared';
import { ChevronDown, ChevronUp, GripVertical, Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useConfig } from '../../../data/config-store';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { dndAccessibility } from '../../../lib/dnd';
import { apply, patch } from '../model';
import { Button, Group, PageHeader, Row, Segmented, Switch, useCompact } from '../ui';

type Where = { label: string; tone: 'both' | 'one' | 'none' };
type Shortcuts = Settings['home']['shortcuts'];

/** Where the n-th pin shows up: first row / extension on desktop, first or later page on mobile. */
function whereOf(n: number, desktop: number, mobile: number, mobilePage: number, single: boolean): Where {
  const pc = n <= desktop ? '首排' : single ? null : '扩展区';
  const mob = n <= mobile ? '首页' : single ? null : `第 ${Math.ceil((n - mobile) / mobilePage) + 1} 页`;
  if (pc && mob) return { label: n <= desktop && n <= mobile ? '桌面 · 手机' : `桌面${pc} · 手机${mob}`, tone: 'both' };
  if (pc) return { label: '仅桌面', tone: 'one' };
  if (mob) return { label: '仅手机', tone: 'one' };
  return { label: '仅在全部应用中', tone: 'none' };
}

const MODE_SUB: Record<Shortcuts['mode'], string> = {
  single: '首页只显示第一排，其余固定的网站在「全部应用」中',
  expand: '其余固定的网站收在面板底部，点击「另有 N 个」展开',
  double: '扩展区始终展开显示',
};

const whereStyle = { both: 'bg-ink/7 text-ink/66', one: 'bg-warn/13 text-[#f1c690]', none: 'bg-error/13 text-[#f4b2a3]' };
const whereText = { both: 'text-ink/50', one: 'text-[#f1c690]', none: 'text-[#f4b2a3]' };

function PinRow({ app, index, count, where }: { app: AppEntry; index: number; count: number; where: Where }) {
  const compact = useCompact();
  const s = useSortable({ id: app.id });
  const move = (d: number) => apply({ type: 'pin.move', appId: app.id, toIndex: index + d });
  const remove = () => apply({ type: 'pin.remove', appId: app.id }, `已从首页移除 ${app.name}`);
  if (compact) {
    return (
      <div className="flex min-h-[58px] items-center gap-3 py-1.5 pr-1.5 pl-1">
        <button type="button" onClick={remove} aria-label={`从首页移除 ${app.name}`} className="grid size-11 flex-none place-items-center border-0 bg-transparent">
          <span className="grid size-[22px] place-items-center rounded-full bg-error">
            <span className="h-0.5 w-2.5 rounded-[1px] bg-white" />
          </span>
        </button>
        <AppTile target={{ kind: 'app', app }} size={36} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15.5px]">{app.name}</span>
          <span className={cn('text-[12px]', whereText[where.tone])}>{where.label}</span>
        </span>
        <button type="button" disabled={index === 0} onClick={() => move(-1)} aria-label={`上移 ${app.name}`} className="grid size-11 place-items-center border-0 bg-transparent text-ink disabled:opacity-30">
          <ChevronUp className="size-[18px]" />
        </button>
        <button type="button" disabled={index === count - 1} onClick={() => move(1)} aria-label={`下移 ${app.name}`} className="grid size-11 place-items-center border-0 bg-transparent text-ink disabled:opacity-30">
          <ChevronDown className="size-[18px]" />
        </button>
      </div>
    );
  }
  return (
    <div
      ref={s.setNodeRef}
      className={cn('flex h-[60px] items-center gap-3.5 pr-3.5 pl-2.5 transition-colors duration-140', s.isDragging && 'relative z-10 bg-ink/6 opacity-50')}
      style={{ transform: DndCSS.Translate.toString(s.transform), transition: s.transition }}
    >
      <button ref={s.setActivatorNodeRef} type="button" {...s.listeners} {...s.attributes} data-dnd-id={app.id} data-dnd-name={app.name} aria-label={`拖动排序 ${app.name}`} className="grid h-9 w-7 flex-none cursor-grab touch-none place-items-center border-0 bg-transparent text-ink/40">
        <GripVertical className="size-4" />
      </button>
      <span className="w-[18px] flex-none text-[12px] text-ink/40 tabular-nums">{index + 1}</span>
      <AppTile target={{ kind: 'app', app }} size={34} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14.5px]">{app.name}</span>
        <span className="truncate text-[12px] text-ink/46">{hostOf(app.url)}</span>
      </span>
      <span className={cn('flex h-6 flex-none items-center rounded-[7px] px-[9px] text-[11.5px]', whereStyle[where.tone])}>{where.label}</span>
      <button type="button" disabled={index === 0} onClick={() => move(-1)} aria-label={`上移 ${app.name}`} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-ink hover:bg-ink/8 disabled:opacity-30">
        <ChevronUp className="size-[15px]" />
      </button>
      <button type="button" disabled={index === count - 1} onClick={() => move(1)} aria-label={`下移 ${app.name}`} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-ink hover:bg-ink/8 disabled:opacity-30">
        <ChevronDown className="size-[15px]" />
      </button>
      <Button size="sm" onClick={remove}>
        移除
      </Button>
    </div>
  );
}

function AddShortcut() {
  const config = useConfig();
  const navigate = useNavigate();
  const compact = useCompact();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = config.apps.filter((a) => a.kind === 'site' && !a.hidden && !config.pins.includes(a.id) && (!q.trim() || (a.name + a.url).toLowerCase().includes(q.trim().toLowerCase())));
  const catLabel = (id: string) => config.categories.find((c) => c.id === id)?.label ?? '未分类';

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const add = (a: AppEntry) => {
    if (apply({ type: 'pin.add', appId: a.id }, `已固定 ${a.name}`)) setQ('');
  };

  return (
    <div ref={ref} className={cn('relative flex items-center gap-3', compact ? 'min-h-[52px] px-4' : 'h-14 px-3.5')}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={cn('flex items-center gap-2 border-0 bg-transparent text-amber-hi', compact ? 'h-11 text-[15.5px]' : 'h-9 rounded-[10px] pr-3.5 pl-2.5 text-[13.5px] hover:bg-amber/10')}>
        <Plus className="size-4" />
        添加快捷方式
      </button>
      {!compact && <span className="text-[12px] text-ink/42">最多 {MAX_PINS} 个</span>}
      {open && (
        <div
          className={cn('absolute z-5 animate-[nx-pop_.14s_var(--ease-soft)] rounded-2xl p-2', compact ? 'right-2 bottom-full left-2 mb-1' : 'top-[52px] left-3 w-[340px]')}
          style={{ background: 'rgba(40,38,34,0.97)', boxShadow: '0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)' }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && list[0] && add(list[0])}
            placeholder="筛选未固定的应用"
            aria-label="筛选未固定的应用"
            className="box-border h-[38px] w-full rounded-[10px] border-0 bg-ink/7 px-3 text-[13.5px] text-ink caret-amber outline-none"
            style={{ fontSize: compact ? 16 : undefined }}
          />
          <div className="mt-1.5 max-h-[252px] overflow-y-auto">
            {list.map((a) => (
              <button key={a.id} type="button" onClick={() => add(a)} className="flex h-11 w-full items-center gap-3 rounded-[10px] border-0 bg-transparent px-2.5 text-left text-[13.5px] text-ink hover:bg-ink/8">
                <AppTile target={{ kind: 'app', app: a }} size={26} lazy />
                <span className="flex-1 truncate">{a.name}</span>
                <span className="text-[12px] text-ink/42">{catLabel(a.categoryId)}</span>
              </button>
            ))}
            {!list.length && (
              <div className="px-2.5 py-3.5 text-[13px] text-ink/50">
                没有可添加的应用 ·{' '}
                <button type="button" onClick={() => navigate('/settings/apps?new=')} className="border-0 bg-transparent p-0 text-[13px] text-amber-hi underline">
                  新增应用
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Preview({ device }: { device: 'pc' | 'mobile' }) {
  const config = useConfig();
  const { home } = config.settings;
  const pins = pinnedSites(config);
  const services = shownServices(config);
  const mobileCap = Math.max(0, home.mobileRows * 4 - services.length);
  const rest = home.shortcuts.mode === 'single' ? [] : pins.slice(home.dockSize);
  if (device === 'pc') {
    const items = [...pins.slice(0, home.dockSize).map((a) => ({ a, sep: false })), ...services.map((a) => ({ a, sep: false }))];
    return (
      <div className="box-border w-[416px] rounded-2xl px-3 pt-3.5 pb-3" style={{ background: 'rgba(26,25,22,0.6)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)' }}>
        <div className="flex h-[30px] items-center border-b border-ink/8 px-1.5 text-[11px] text-ink/46">搜索、输入网址，或打开应用</div>
        <div className="flex justify-center gap-[3px] pt-3.5">
          {items.map(({ a }, i) => (
            <span key={a.id} className="flex items-start">
              {i === Math.min(pins.length, home.dockSize) && services.length > 0 && <span className="mx-[3px] mt-1 h-[22px] w-px bg-ink/16" />}
              <span className="flex w-9 flex-col items-center gap-[5px]">
                <AppTile target={{ kind: 'app', app: a }} size={30} />
                {home.labels.desktop && <span className="max-w-9 truncate text-[8.5px] text-ink/70">{a.name}</span>}
              </span>
            </span>
          ))}
          <span className="mx-[3px] mt-1 h-[22px] w-px bg-ink/16" />
          <span className="flex w-9 flex-col items-center gap-[5px]">
            <AppTile target={{ kind: 'all' }} size={30} />
            {home.labels.desktop && <span className="text-[8.5px] text-ink/70">全部应用</span>}
          </span>
        </div>
        {rest.length > 0 &&
          (home.shortcuts.mode === 'double' ? (
            <div className="grid grid-cols-9 justify-items-center gap-y-2 pt-3">
              {rest.slice(0, 9 * home.shortcuts.pageRows).map((a) => (
                <AppTile key={a.id} target={{ kind: 'app', app: a }} size={26} />
              ))}
            </div>
          ) : (
            <div className="pt-2 text-center text-[9px] text-ink/40">⌄ 另有 {rest.length} 个</div>
          ))}
      </div>
    );
  }
  const grid = [...pins.slice(0, mobileCap), ...services].slice(0, home.mobileRows * 4);
  const empty = home.mobileRows * 4 - grid.length;
  return (
    <div className="box-border w-[208px] rounded-[22px] px-2.5 py-3" style={{ background: 'rgba(26,25,22,0.6)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)' }}>
      <div className="grid grid-cols-4 justify-items-center gap-y-2.5">
        {grid.map((a) => (
          <span key={a.id} className="flex flex-col items-center gap-1">
            <AppTile target={{ kind: 'app', app: a }} size={36} />
            {home.labels.mobile && <span className="max-w-11 truncate text-[8.5px] text-ink/70">{a.name}</span>}
          </span>
        ))}
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className="flex flex-col items-center gap-1">
            <span className="box-border size-9 rounded-[11px] border-[1.5px] border-dashed border-ink/22" />
            {home.labels.mobile && <span className="text-[8.5px] text-ink/40">空位</span>}
          </span>
        ))}
      </div>
      <div className="mt-3 h-[26px] rounded-[9px] bg-ink/9" />
    </div>
  );
}

export function HomeLayoutPage() {
  const config = useConfig();
  const compact = useCompact();
  const { home } = config.settings;
  const [device, setDevice] = useState<'pc' | 'mobile'>('pc');
  const pins = pinnedSites(config);
  const services = shownServices(config);
  const mobileCap = Math.max(0, home.mobileRows * 4 - services.length);
  const hidden = config.apps.filter((a) => a.hidden);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const { shortcuts } = home;
  const single = shortcuts.mode === 'single';
  const rest = single ? [] : pins.slice(home.dockSize);
  const setShortcuts = (v: Partial<Shortcuts>) => patch('home', { shortcuts: { ...shortcuts, ...v } });

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    apply({ type: 'pin.move', appId: String(e.active.id), toIndex: pins.findIndex((a) => a.id === e.over!.id) });
  };

  const content = (
    <div className="flex min-w-0 flex-col gap-7">
      <PageHeader
        title="首页与快捷方式"
        sub={`桌面与手机共用同一个顺序：桌面首排显示前 ${home.dockSize} 个，手机首页显示前 ${mobileCap} 个${single ? '' : '，其余在桌面扩展区和手机后续页面'}。改动即时保存。`}
      />
      <Group
        title={compact ? `首页网站 · 手机显示前 ${mobileCap} 个` : '固定的网站'}
        extra={
          !compact && (
            <>
              <span className="text-[12px] text-ink/40">{pins.length} 个</span>
              <span className="flex-1" />
              <span className="text-[12px] text-ink/40">拖动 ⋮⋮ 或用 ↑↓ 排序</span>
            </>
          )
        }
      >
        <DndContext accessibility={dndAccessibility} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={pins.map((a) => a.id)} strategy={verticalListSortingStrategy}>
            {pins.map((a, i) => (
              <PinRow key={a.id} app={a} index={i} count={pins.length} where={whereOf(i + 1, home.dockSize, mobileCap, home.mobileRows * 4, single)} />
            ))}
          </SortableContext>
        </DndContext>
        {!pins.length && <div className="px-5 py-7 text-[13.5px] text-ink/50">首页还没有固定的网站。添加后会出现在 Dock 与手机首页。</div>}
        <AddShortcut />
      </Group>
      {compact && <p className="m-0 -mt-4 px-4 text-[12.5px] leading-[1.6] text-ink/46">用 − 移除、↑↓ 调整顺序；也可在首页长按图标。</p>}

      <Group title="快捷方式区域">
        <Row label="显示方式" sub={MODE_SUB[shortcuts.mode]} stacked>
          <Segmented<Shortcuts['mode']>
            label="快捷方式显示方式"
            value={shortcuts.mode}
            options={[
              { value: 'single', label: '单排' },
              { value: 'expand', label: '可展开' },
              { value: 'double', label: '固定展开' },
            ]}
            onChange={(mode) => setShortcuts({ mode })}
          />
        </Row>
        {!compact && !single && (
          <Row label="扩展区每页行数" sub="屏幕较矮时会自动减少行数，避免面板超出窗口">
            <Segmented
              label="扩展区每页行数"
              value={shortcuts.pageRows}
              options={[
                { value: 1, label: '1 行' },
                { value: 2, label: '2 行' },
                { value: 3, label: '3 行' },
              ]}
              onChange={(pageRows) => setShortcuts({ pageRows })}
            />
          </Row>
        )}
        {!single && (
          <Row label="显示分页指示" sub={compact ? '手机首页下方的页码圆点' : '多页时显示页码与前后翻页按钮；也可用滚轮或 PageUp/PageDown 翻页'}>
            <Switch label="显示分页指示" checked={shortcuts.pager} onChange={(pager) => setShortcuts({ pager })} />
          </Row>
        )}
        {shortcuts.mode === 'expand' && (
          <Row label="记住展开状态" sub="每个浏览器分别记住；关闭时每次打开首页都是收起的">
            <Switch label="记住展开状态" checked={shortcuts.remember} onChange={(remember) => setShortcuts({ remember })} />
          </Row>
        )}
      </Group>

      <Group title={compact ? '布局' : '布局偏好'}>
        {!compact && (
          <Row label="首排网站数量" sub={`桌面首排 ${DOCK_SIZE_MIN}–${DOCK_SIZE_MAX} 个；超过 ${DOCK_SIZE_MAX} 个会挤压搜索面板宽度`}>
            <div className="flex items-center gap-0.5 rounded-[11px] bg-ink/6 p-[3px]">
              <button type="button" aria-label="减少" disabled={home.dockSize <= DOCK_SIZE_MIN} onClick={() => patch('home', { dockSize: home.dockSize - 1 })} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-ink hover:bg-ink/10 disabled:opacity-30">
                <Minus className="size-3.5" />
              </button>
              <span aria-live="polite" className="w-8 text-center text-[14px] tabular-nums">
                {home.dockSize}
              </span>
              <button type="button" aria-label="增加" disabled={home.dockSize >= DOCK_SIZE_MAX} onClick={() => patch('home', { dockSize: home.dockSize + 1 })} className="grid size-8 place-items-center rounded-[9px] border-0 bg-transparent text-ink hover:bg-ink/10 disabled:opacity-30">
                <Plus className="size-3.5" />
              </button>
            </div>
          </Row>
        )}
        <Row label={compact ? '首页行数' : '手机首页行数'} sub={`${home.mobileRows * 4} 个位置，其中 ${services.length} 个给服务；3 行时仍在屏幕下 45% 内`} stacked>
          <Segmented
            label="手机首页行数"
            value={home.mobileRows}
            options={[
              { value: 2, label: '2 行' },
              { value: 3, label: '3 行' },
            ]}
            onChange={(v) => patch('home', { mobileRows: v })}
          />
        </Row>
        <Row label="显示我的服务" sub="在 Dock 与手机首页显示自托管服务及其状态角标">
          <Switch label="显示我的服务" checked={home.showServices} onChange={(v) => patch('home', { showServices: v })} />
        </Row>
        <Row label="桌面显示图标名称" sub="关闭后只显示图标，悬停时显示名称">
          <Switch label="桌面显示图标名称" checked={home.labels.desktop} onChange={(v) => patch('home', { labels: { ...home.labels, desktop: v } })} />
        </Row>
        <Row label="手机显示图标名称" sub="两端可以分别设置">
          <Switch label="手机显示图标名称" checked={home.labels.mobile} onChange={(v) => patch('home', { labels: { ...home.labels, mobile: v } })} />
        </Row>
        <Row label="搜索时显示最近使用" sub="聚焦搜索框且未输入时显示最近 3 项">
          <Switch label="搜索时显示最近使用" checked={home.showRecent} onChange={(v) => patch('home', { showRecent: v })} />
        </Row>
      </Group>
      {compact && <p className="m-0 -mt-4 px-4 text-[12.5px] leading-[1.6] text-ink/46">桌面 Dock 数量在电脑上调整，两端共用同一顺序。</p>}

      <Group title="已隐藏的应用">
        {hidden.map((a) => (
          <div key={a.id} className={cn('flex items-center gap-3.5', compact ? 'min-h-[52px] px-4' : 'h-[58px] pr-3.5 pl-5')}>
            <AppTile target={{ kind: 'app', app: a }} size={30} style={{ opacity: 0.6 }} />
            <span className="flex-1 text-[14px] text-ink/75">{a.name}</span>
            <Button size="sm" onClick={() => apply({ type: 'app.setHidden', appId: a.id, hidden: false }, `${a.name} 已恢复显示`)}>
              恢复显示
            </Button>
          </div>
        ))}
        {!hidden.length && <div className="px-5 py-5 text-[13.5px] text-ink/50">没有隐藏的应用。在首页或应用列表中{compact ? '长按' : '右键'}即可隐藏。</div>}
      </Group>
    </div>
  );

  if (compact) return content;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_456px] items-start gap-10">
      {content}
      <aside className="sticky top-0 flex flex-col gap-3.5">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-medium text-ink/70">首页预览</span>
          <span className="flex-1" />
          <Segmented<'pc' | 'mobile'>
            size="sm"
            label="预览设备"
            value={device}
            options={[
              { value: 'pc', label: '桌面' },
              { value: 'mobile', label: '手机' },
            ]}
            onChange={setDevice}
          />
        </div>
        <div className="grid min-h-[400px] place-items-center rounded-[20px] py-6" style={{ background: 'rgba(0,0,0,0.18)' }}>
          <Preview device={device} />
        </div>
        <span className="text-[12px] leading-[1.6] text-ink/46">
          {device === 'pc'
            ? `首排：前 ${home.dockSize} 个网站${home.showServices ? ` + ${services.length} 个服务` : ''} + 全部应用${rest.length ? ` · 扩展区 ${rest.length} 个` : ''}`
            : `手机首页：${home.mobileRows} 行 × 4 列${pins.length > mobileCap && home.shortcuts.mode !== 'single' ? `，其余 ${pins.length - mobileCap} 个左右滑动或上拉查看` : '；不足时显示空位，点按可添加'}`}
        </span>
      </aside>
    </div>
  );
}
