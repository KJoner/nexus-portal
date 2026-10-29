import { hostOf, validateEngine, type Engine, type LinkwardenStatus } from '@nexus/shared';
import { Check, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '../../../components/toast-store';
import { linkwardenApi, useConfig } from '../../../data/config-store';
import { useRecentStore } from '../../../data/recent';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { apply, patch } from '../model';
import { Button, Dialog, Field, Group, PageHeader, Row, Segmented, Spinner, Switch, Tag, useCompact } from '../ui';

/** Read-only Linkwarden connection: verified by the server before saving; the token never returns. */
function LinkwardenCard({ status, setStatus }: { status: LinkwardenStatus | null; setStatus(s: LinkwardenStatus): void }) {
  const config = useConfig();
  const compact = useCompact();
  const svc = config.apps.find((a) => a.icon.source === 'builtin' && a.icon.ref === 'linkwarden');
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connected = !!status?.configured;
  const showForm = !connected || editing;

  useEffect(() => {
    setBaseUrl(status?.baseUrl || svc?.lanUrl || svc?.url || '');
  }, [status?.baseUrl, svc?.lanUrl, svc?.url]);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await linkwardenApi.connect(baseUrl, token));
      setToken('');
      setEditing(false);
      toast({ msg: '已连接 Linkwarden', tone: 'ok' });
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    try {
      setStatus(await linkwardenApi.disconnect());
      const s = config.settings.search;
      apply({ type: 'settings.patch', section: 'search', patch: { linkwarden: false, defaultEngine: s.defaultEngine === 'links' ? 'google' : s.defaultEngine } });
      toast({ msg: '已断开 Linkwarden，令牌已从服务端删除', tone: 'ok' });
    } catch (e) {
      toast({ msg: e instanceof Error ? e.message : '断开失败', tone: 'error' });
    }
  };

  if (!status) return <div className={cn('text-[13px] text-ink/50', compact ? 'px-4 py-3' : 'px-5 py-4')}>正在读取连接状态…</div>;
  return (
    <div className={cn('flex flex-col gap-3', compact ? 'px-4 pt-1 pb-4' : 'mx-5 mb-4 rounded-[14px] bg-ink/4 px-3.5 py-3')}>
      {connected && (
        <div className="flex items-center gap-3.5">
          <span className="size-[7px] flex-none rounded-full" style={{ background: status.lastError ? '#e3a35b' : '#a7bf9f' }} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13.5px]">已连接 {hostOf(status.baseUrl)}</span>
            <span className={cn('truncate text-[11.5px]', status.lastError ? 'text-[#f1c690]' : 'font-mono text-ink/50')}>{status.lastError ?? `API 令牌 ••••••••${status.tokenLast4}`}</span>
          </span>
          {!editing && (
            <>
              <Button size="sm" onClick={() => setEditing(true)}>
                更换令牌
              </Button>
              <Button size="sm" variant="ghost" className="text-danger-ink" onClick={() => void disconnect()}>
                断开
              </Button>
            </>
          )}
        </div>
      )}
      {showForm && (
        <>
          <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')}>
            <Field label="Linkwarden 地址" mono placeholder="https://links.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ fontSize: compact ? 16 : undefined }} />
            <Field label={connected ? '新的访问令牌' : '访问令牌'} mono type="password" autoComplete="off" placeholder="eyJhbGciOi…" value={token} onChange={(e) => setToken(e.target.value)} style={{ fontSize: compact ? 16 : undefined }} />
          </div>
          {error && <span className="text-[12.5px] text-danger-ink">{error}</span>}
          <span className="text-[12px] leading-[1.6] text-ink/46">在 Linkwarden「设置 › Access Tokens」中新建令牌。Nexus 只用它做只读搜索；令牌加密保存在服务端，浏览器不保存、也读不到。</span>
          <div className="flex justify-end gap-2">
            {editing && <Button onClick={() => (setEditing(false), setError(''), setToken(''))}>取消</Button>}
            <Button variant="primary" disabled={busy || !baseUrl.trim() || (!connected && !token.trim())} onClick={() => void connect()}>
              {busy && <Spinner className="border-on-amber/70 border-t-transparent" />}
              {busy ? '正在验证…' : connected ? '验证并保存' : '连接'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

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
  const [lw, setLw] = useState<LinkwardenStatus | null>(null);
  useEffect(() => {
    linkwardenApi.status().then(setLw, () => setLw({ configured: false, baseUrl: '', tokenLast4: '', lastOkAt: null, lastError: '无法读取连接状态' }));
  }, []);
  const lwToggle = (
    <Row label="Linkwarden 收藏搜索" sub={lw?.configured ? '在结果中混排收藏，并可把「我的收藏」设为引擎；查询经 Nexus 服务端转发' : '先在下方连接 Linkwarden'} disabled={!lw?.configured && !s.linkwarden}>
      <Switch
        label="Linkwarden 收藏搜索"
        checked={s.linkwarden}
        disabled={!lw?.configured && !s.linkwarden}
        onChange={(v) => apply({ type: 'settings.patch', section: 'search', patch: { linkwarden: v, defaultEngine: !v && s.defaultEngine === 'links' ? 'google' : s.defaultEngine } })}
      />
    </Row>
  );
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
      <Row label="搜索建议" sub="输入时经 Nexus 服务端向当前引擎（Google、Bing、DuckDuckGo）请求联想词；输入内容会发送给该引擎">
        <Switch label="搜索建议" checked={s.suggest} onChange={(v) => patch('search', { suggest: v })} />
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
        <Group title="Linkwarden">
          {lwToggle}
          <LinkwardenCard status={lw} setStatus={setLw} />
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
        {lwToggle}
        <LinkwardenCard status={lw} setStatus={setLw} />
      </Group>
      {clearDialog}
    </div>
  );
}
