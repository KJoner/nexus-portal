import { validateEngine, type Engine } from '@nexus/shared';
import { Check, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../../../components/toast-store';
import { useConfig } from '../../../data/config-store';
import { useRecentStore } from '../../../data/recent';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { apply, patch } from '../model';
import { Button, Dialog, Field, Group, NotYet, PageHeader, Row, Segmented, Switch, Tag, useCompact } from '../ui';

type Draft = Pick<Engine, 'id' | 'name' | 'urlTemplate' | 'prefix'> & { isNew: boolean };

function EngineForm({ draft, setDraft, engines }: { draft: Draft; setDraft(d: Draft | null): void; engines: Engine[] }) {
  const [tried, setTried] = useState(false);
  const v = validateEngine(draft, engines);
  const e = (k: keyof typeof v.errors) => (tried ? v.errors[k] : undefined);
  const save = () => {
    if (!v.ok) return setTried(true);
    const existing = engines.find((x) => x.id === draft.id);
    const engine: Engine = { ...(existing ?? { builtin: false, kind: 'web', icon: '' }), id: draft.id, name: draft.name.trim(), urlTemplate: draft.urlTemplate.trim(), prefix: draft.prefix.trim().toLowerCase() } as Engine;
    if (apply({ type: 'engine.upsert', engine }, draft.isNew ? `已添加 ${engine.name}` : `已保存 ${engine.name}`)) setDraft(null);
  };
  return (
    <div className="flex flex-col gap-3.5 bg-ink/3 px-5 pt-[18px] pb-5">
      <span className="text-[14px] font-medium">{draft.isNew ? '添加自定义引擎' : `编辑 ${draft.name}`}</span>
      <div className="grid grid-cols-[180px_minmax(0,1fr)_110px] items-start gap-3">
        <Field label="名称" placeholder="例如 MDN" value={draft.name} error={e('name')} onChange={(ev) => setDraft({ ...draft, name: ev.target.value })} />
        <Field label="搜索网址 · 用 %s 代替搜索词" mono placeholder="https://example.com/search?q=%s" value={draft.urlTemplate} error={e('url')} onChange={(ev) => setDraft({ ...draft, urlTemplate: ev.target.value })} />
        <Field label="前缀（可选）" mono placeholder="mdn" value={draft.prefix} error={e('prefix')} onChange={(ev) => setDraft({ ...draft, prefix: ev.target.value.trim() })} />
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={() => setDraft(null)}>取消</Button>
        <Button variant="primary" onClick={save}>
          {draft.isNew ? '添加' : '保存'}
        </Button>
      </div>
    </div>
  );
}

export function SearchPage() {
  const config = useConfig();
  const compact = useCompact();
  const s = config.settings.search;
  const E = config.engines;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const history = useRecentStore((st) => st.items.filter((x) => x.kind === 'search').length);
  const clearSearches = useRecentStore((st) => st.clearSearches);

  const setDefault = (e: Engine) => e.id !== s.defaultEngine && apply({ type: 'settings.patch', section: 'search', patch: { defaultEngine: e.id } }, `默认搜索引擎已改为 ${e.name}`);
  const offOf = (e: Engine) => e.kind === 'linkwarden' && !s.linkwarden;

  const clearDialog = (
    <Dialog
      open={clearOpen}
      onOpenChange={setClearOpen}
      title="清除搜索历史？"
      description={`${history} 条记录将从本浏览器删除，此操作无法撤销。`}
      footer={
        <>
          <Button className="h-10 px-[18px]" onClick={() => setClearOpen(false)}>
            取消
          </Button>
          <Button
            variant="danger-solid"
            className="h-10 px-5"
            onClick={() => {
              clearSearches();
              setClearOpen(false);
              toast({ msg: `已清除 ${history} 条搜索历史`, tone: 'ok' });
            }}
          >
            清除
          </Button>
        </>
      }
    />
  );

  const toggles = (
    <>
      <Row label={<>搜索建议 <NotYet /></>} sub="输入时向当前搜索引擎请求联想词，需要经由 Nexus 服务端转发" disabled>
        <Switch label="搜索建议" checked={false} disabled />
      </Row>
      <Row label="记录搜索历史" sub="聚焦搜索框时在「最近」中显示；只保存在本浏览器，不会上传">
        <Switch label="记录搜索历史" checked={s.history} onChange={(v) => patch('search', { history: v })} />
      </Row>
    </>
  );

  if (compact) {
    return (
      <>
        <Group title="默认搜索引擎">
          <div role="radiogroup" aria-label="默认搜索引擎" className="flex flex-col divide-y divide-ink/7">
            {E.map((e) => (
              <button key={e.id} type="button" role="radio" aria-checked={s.defaultEngine === e.id} disabled={offOf(e)} onClick={() => setDefault(e)} className="flex min-h-14 items-center gap-3 border-0 bg-transparent px-4 py-2 text-left text-ink active:bg-ink/8 disabled:opacity-45">
                <AppTile target={{ kind: 'engine', engine: e }} size={30} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[15.5px]">{e.name}</span>
                  <span className="truncate text-[12px] text-ink/50">{offOf(e) ? '需先开启 Linkwarden 收藏搜索' : e.prefix ? `前缀 ${e.prefix} ␣` : '无前缀'}</span>
                </span>
                {s.defaultEngine === e.id && <Check className="size-[18px] text-amber" />}
              </button>
            ))}
          </div>
        </Group>
        <p className="m-0 -mt-4 px-4 text-[12.5px] leading-[1.6] text-ink/46">排序与自定义引擎在电脑上编辑更方便；这里的顺序即首页引擎胶囊的顺序。</p>
        <Group>
          {toggles}
          <Row label="在结果中显示应用" sub="把匹配的应用与服务排在网页搜索之前">
            <Switch label="在结果中显示应用" checked={s.showApps} onChange={(v) => patch('search', { showApps: v })} />
          </Row>
        </Group>
        <Button size="lg" className="w-full rounded-2xl bg-ink/6 text-[#f4b2a3]" disabled={!history} onClick={() => setClearOpen(true)}>
          清除搜索历史{history ? `（${history} 条）` : ''}
        </Button>
        {clearDialog}
      </>
    );
  }

  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <PageHeader title="搜索" sub="列表顺序即首页引擎菜单与 Alt ↑↓ 的切换顺序。在搜索框输入「前缀 + 空格」可临时改用对应引擎。" />
      <Group title="搜索引擎">
        {E.map((e, i) => {
          const off = offOf(e);
          const isDef = s.defaultEngine === e.id;
          return (
            <div key={e.id} className="box-border flex min-h-[62px] items-center gap-3.5 py-2 pr-3.5 pl-4">
              <button type="button" role="radio" aria-checked={isDef} aria-label={`设为默认：${e.name}`} disabled={off} onClick={() => setDefault(e)} className="grid size-8 flex-none place-items-center rounded-full border-0 bg-transparent disabled:opacity-40">
                <span className="box-border grid size-[18px] place-items-center rounded-full" style={{ border: isDef ? '2px solid #e6c08a' : '2px solid rgba(239,234,225,0.3)' }}>
                  {isDef && <span className="size-2 rounded-full bg-amber" />}
                </span>
              </button>
              <AppTile target={{ kind: 'engine', engine: e }} size={30} style={{ opacity: off ? 0.45 : 1 }} />
              <span className={cn('flex min-w-0 flex-1 flex-col gap-[3px]', off && 'opacity-45')}>
                <span className="flex items-center gap-2 text-[14.5px]">
                  {e.name}
                  {isDef && <Tag tone="amber">默认</Tag>}
                  {off && <span className="text-[11.5px] text-ink/44">需先开启下方的 Linkwarden 收藏搜索</span>}
                </span>
                <span className="truncate font-mono text-[11.5px] text-ink/50">{e.kind === 'linkwarden' ? '由 Nexus 服务端只读查询 Linkwarden' : e.urlTemplate}</span>
              </span>
              <span title="输入前缀加空格切换" className="flex h-6 flex-none items-center rounded-[7px] px-2 font-mono text-[11.5px] text-ink/72 shadow-[inset_0_0_0_1px_rgba(239,234,225,0.16)]">
                {e.prefix ? `${e.prefix} ␣` : '—'}
              </span>
              <button type="button" aria-label={`上移 ${e.name}`} disabled={i === 0} onClick={() => apply({ type: 'engine.move', engineId: e.id, toIndex: i - 1 })} className="grid size-[30px] place-items-center rounded-[9px] border-0 bg-transparent text-ink hover:bg-ink/8 disabled:opacity-30">
                <ChevronUp className="size-3.5" />
              </button>
              <button type="button" aria-label={`下移 ${e.name}`} disabled={i === E.length - 1} onClick={() => apply({ type: 'engine.move', engineId: e.id, toIndex: i + 1 })} className="grid size-[30px] place-items-center rounded-[9px] border-0 bg-transparent text-ink hover:bg-ink/8 disabled:opacity-30">
                <ChevronDown className="size-3.5" />
              </button>
              <span className="flex w-24 flex-none justify-end gap-1">
                {e.builtin ? (
                  <span className="flex h-[30px] items-center px-2.5 text-[12px] text-ink/40">内置</span>
                ) : (
                  <>
                    <button type="button" aria-label={`编辑 ${e.name}`} onClick={() => setDraft({ id: e.id, name: e.name, urlTemplate: e.urlTemplate, prefix: e.prefix, isNew: false })} className="grid size-[30px] place-items-center rounded-[9px] border-0 bg-transparent text-ink hover:bg-ink/8">
                      <Pencil className="size-3.5" />
                    </button>
                    <button type="button" aria-label={`删除 ${e.name}`} onClick={() => apply({ type: 'engine.delete', engineId: e.id }, `已删除 ${e.name}`)} className="grid size-[30px] place-items-center rounded-[9px] border-0 bg-transparent text-danger-ink hover:bg-error/12">
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
        {draft ? (
          <EngineForm draft={draft} setDraft={setDraft} engines={E} />
        ) : (
          <div className="flex h-14 items-center px-3.5">
            <Button variant="text" className="h-9 text-[13.5px]" onClick={() => setDraft({ id: `eng-${Date.now().toString(36)}`, name: '', urlTemplate: '', prefix: '', isNew: true })}>
              <Plus className="size-4" />
              添加自定义引擎
            </Button>
          </div>
        )}
      </Group>

      <Group title="建议与历史">
        {toggles}
        <Row label="历史保留时长" sub="超过时长的记录不再显示" disabled={!s.history}>
          <Segmented
            label="历史保留时长"
            value={s.historyDays}
            options={[
              { value: 7, label: '7 天', disabled: !s.history },
              { value: 30, label: '30 天', disabled: !s.history },
              { value: 90, label: '90 天', disabled: !s.history },
            ]}
            onChange={(v) => patch('search', { historyDays: v })}
          />
        </Row>
        <Row label="清除搜索历史" sub={`本浏览器当前 ${history} 条`}>
          <Button variant="danger" disabled={!history} onClick={() => setClearOpen(true)}>
            清除…
          </Button>
        </Row>
      </Group>

      <Group title="结果来源">
        <Row label="在结果中显示应用" sub="输入时把匹配的应用与服务排在网页搜索之前">
          <Switch label="在结果中显示应用" checked={s.showApps} onChange={(v) => patch('search', { showApps: v })} />
        </Row>
        <Row label={<>Linkwarden 收藏搜索 <NotYet /></>} sub="在结果中混排收藏，并可把「我的收藏」设为引擎；查询经 Nexus 服务端转发，令牌不进入浏览器" disabled>
          <Switch label="Linkwarden 收藏搜索" checked={s.linkwarden} disabled />
        </Row>
      </Group>
      {clearDialog}
    </div>
  );
}
