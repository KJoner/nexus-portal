import { canonicalUrl, ITEM_LIMITS, MAX_PINS, UNFILED, type FavoriteApp, type FavoritePatch, type Health, type Icon, type Item } from '@nexus/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../components/toast-store';
import { useConfig, useIsAdmin } from '../../data/config-store';
import { libraryApi, loadLibrary, useLibrary, type WriteOutcome } from '../../data/library';
import { AppTile } from '../../icons/AppTile';
import { cn } from '../../lib/cn';
import { useViewport } from '../../lib/hooks';
import { Button, Segmented, Spinner } from '../settings/ui';
import { useFavoriteDialogs } from './dialog-store';
import { asApp, pathLabel } from './model';
import { ChipsField, GroupSelect, IconField, Modal, Section, TextArea, TextField, ToggleRow } from './parts';

/**
 * 编辑收藏 (UI v2 · spec 01 §4, 02 N3, 03 §1–§2): every property of one favorite in one form — name,
 * address, group, pin, icon, tags, note, search aliases, how it opens, service options — and ONE
 * 保存 (libraryApi.saveFavorite: one transaction, field-level CAS). A field changed elsewhere since the
 * form opened (FIELD_CONFLICT) saves nothing: the form keeps what was typed and shows what is there
 * now, and the person chooses. A refused pin or any other refusal is said as it is — never a
 * 「已保存」 for half a save.
 */
interface Draft {
  title: string;
  url: string;
  folderId: string;
  pin: boolean;
  tags: string[];
  note: string;
  icon: Icon;
  aliases: string[];
  openIn: 'same' | 'new';
  hidden: boolean;
  service: boolean;
  lanUrl: string;
  prefer: 'ext' | 'lan';
  health: Health;
}

const FIELD_LABEL: Record<string, string> = { title: '名称', url: '网址', folderId: '分组', tags: '标签', note: '备注', iconRef: '图标', kind: '类型', extra: '更多选项', 'app.icon': '图标', 'app.aliases': '搜索别名', 'app.openIn': '打开方式', 'app.kind': '服务', 'app.lanUrl': '内网地址', 'app.prefer': '默认打开', 'app.health': '服务状态检查', 'app.hidden': '隐藏', 'app.description': '说明' };

export function draftOf(item: Item, pinned: boolean): Draft {
  const a = asApp(item);
  return {
    title: item.title,
    url: item.url,
    folderId: item.folderId || UNFILED,
    pin: pinned,
    tags: [...item.tags],
    note: item.note,
    icon: a.icon,
    aliases: [...a.aliases],
    openIn: a.openIn,
    hidden: a.hidden,
    service: a.kind === 'service',
    lanUrl: a.lanUrl,
    prefer: a.prefer,
    health: a.health,
  };
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** What changed between the form as opened and as it is now, as one patch. */
export function patchOf(from: Draft, to: Draft, item: Item): FavoritePatch {
  const p: FavoritePatch = {};
  if (to.title.trim() !== from.title) p.title = to.title.trim();
  if (to.url.trim() !== from.url) p.url = to.url.trim();
  if (to.folderId !== from.folderId) p.folderId = to.folderId;
  if (!same(to.tags, from.tags)) p.tags = to.tags;
  if (to.note !== from.note) p.note = to.note;
  if (to.pin !== from.pin) p.pin = to.pin;
  const app: FavoriteApp = {};
  if (!same(to.icon, from.icon)) app.icon = to.icon;
  if (!same(to.aliases, from.aliases)) app.aliases = to.aliases;
  if (to.openIn !== from.openIn) app.openIn = to.openIn;
  if (to.hidden !== from.hidden) app.hidden = to.hidden;
  if (to.service !== from.service) app.kind = to.service ? 'service' : 'site';
  if (to.lanUrl.trim() !== from.lanUrl) app.lanUrl = to.lanUrl.trim();
  if (to.prefer !== from.prefer) app.prefer = to.prefer;
  if (!same(to.health, from.health)) app.health = to.health;
  if (Object.keys(app).length) p.app = app;
  // A service (or any favorite with home-page presentation) is listed with the apps.
  if (to.service && item.kind === 'page') p.kind = 'app';
  return p;
}

export function validate(d: Draft): Partial<Record<'title' | 'url' | 'lanUrl' | 'note', string>> {
  const e: Partial<Record<'title' | 'url' | 'lanUrl' | 'note', string>> = {};
  if (!d.title.trim()) e.title = '请填写名称';
  else if ([...d.title.trim()].length > ITEM_LIMITS.title) e.title = `名称最多 ${ITEM_LIMITS.title} 个字`;
  if (!d.url.trim()) e.url = '请填写网址';
  else if (!canonicalUrl(d.url.trim())) e.url = '只能收藏 http 或 https 网址，且不能包含用户名或密码';
  if (d.lanUrl.trim() && !canonicalUrl(d.lanUrl.trim())) e.lanUrl = '内网地址也要是 http 或 https 网址';
  if ([...d.note].length > ITEM_LIMITS.note) e.note = `备注最多 ${ITEM_LIMITS.note} 个字`;
  return e;
}

/** Says what became of a refused save; null when it saved. */
export function refusal(r: WriteOutcome): string | null {
  if (r.ok) return null;
  switch (r.code) {
    case 'QUOTA_EXCEEDED':
      return `首页已经固定满 ${MAX_PINS} 个，这次没有保存任何修改。先在「首页快捷方式」里取消固定一个，或者不勾选「固定到首页」再保存。`;
    case 'NOT_PINNABLE':
      return '隐藏的收藏不能固定到首页，这次没有保存任何修改。';
    case 'ITEM_DELETED':
      return '这条收藏已经在别处被移到回收站，这次没有保存。可以在回收站里恢复后再修改。';
    case 'VALIDATION':
      return `有字段不符合要求：${r.message}。这次没有保存。`;
    case 'NOT_READY':
      return '我的收藏还在加载，请稍后再保存。';
    default:
      return `没有保存：${r.message}`;
  }
}

export function FavoriteEditor() {
  const id = useFavoriteDialogs((s) => s.edit);
  const hide = useFavoriteDialogs((s) => s.hideEdit);
  const item = useLibrary((s) => (id ? s.items[id] : undefined));
  const status = useLibrary((s) => s.status);
  const pins = useLibrary((s) => s.pins);
  const { w, h } = useViewport();
  const phone = !(w >= 900 && h >= 560);
  useEffect(() => {
    if (id && status === 'idle') void loadLibrary();
  }, [id, status]);
  if (!id) return null;
  if (!item)
    return (
      <Modal open onClose={hide} title="编辑收藏" width={520} phone={phone}>
        <div className="flex flex-col gap-3 p-7 text-[14px] text-ink/70">{status === 'loading' || status === 'idle' ? <span className="flex items-center gap-2"><Spinner /> 正在读取…</span> : '找不到这条收藏：它可能已在别处被删除。'}</div>
      </Modal>
    );
  return <EditorForm key={`${item.id}`} item={item} pinned={pins.includes(item.id)} phone={phone} onClose={hide} />;
}

function EditorForm({ item, pinned, phone, onClose }: { item: Item; pinned: boolean; phone: boolean; onClose(): void }) {
  const config = useConfig();
  const admin = useIsAdmin();
  const pinsUsed = useLibrary((s) => s.pins.length);
  const opened = useRef(draftOf(item, pinned));
  const [base, setBase] = useState<Item>(item);
  const [draft, setDraft] = useState<Draft>(opened.current);
  const [more, setMore] = useState(false);
  const [svcOpen, setSvcOpen] = useState(opened.current.service);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{ fields: string[]; current: Item } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const errors = useMemo(() => validate(draft), [draft]);
  const patch = patchOf(opened.current, draft, base);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setConfirmClose(false);
  };
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);

  const requestClose = () => {
    if (dirty && !confirmClose) return setConfirmClose(true);
    onClose();
  };

  const save = async (against: Item = base) => {
    setTried(true);
    if (Object.keys(errors).length) return;
    if (!dirty) return onClose();
    setBusy(true);
    setError('');
    const r = await libraryApi.saveFavorite(against, patchOf(opened.current, draft, against));
    setBusy(false);
    if (r.ok) {
      const forced = (r.answer as { healthForcedOff?: boolean } | undefined)?.healthForcedOff;
      toast(r.queued ? { msg: `已离线保存「${draft.title.trim()}」，联网后自动同步`, tone: 'warn' } : { msg: `已保存「${draft.title.trim()}」${forced ? '；服务状态检查只有管理员能开启，已保持关闭' : ''}`, tone: 'ok' });
      onClose();
      return;
    }
    if (r.code === 'FIELD_CONFLICT') {
      const current = (r.details?.item ?? null) as Item | null;
      const fields = ((r.details?.conflictFields ?? []) as string[]).filter(Boolean);
      if (current) {
        setConflict({ fields, current });
        return;
      }
    }
    setError(refusal(r) ?? '');
  };

  const head = asApp({ ...item, title: draft.title || item.title, url: draft.url || item.url, app: { ...(item.app ?? {}), icon: draft.icon, kind: draft.service ? 'service' : 'site' } });
  const pinFull = !pinned && draft.pin && pinsUsed >= MAX_PINS;

  const footer = (
    <footer className={cn('flex flex-none flex-wrap items-center gap-2.5 border-t border-ink/8', phone ? 'px-4 pt-3' : 'px-7 py-4')} style={phone ? { paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' } : undefined}>
      {confirmClose ? (
        <>
          <span role="alert" className="min-w-0 flex-1 text-[13px] text-ink/80">
            有未保存的修改，确定放弃吗？
          </span>
          <Button className={cn(phone && 'h-11')} onClick={() => setConfirmClose(false)}>
            继续编辑
          </Button>
          <Button variant="danger" className={cn(phone && 'h-11')} onClick={onClose}>
            放弃修改
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            className={cn('text-danger-ink', phone && 'h-11')}
            disabled={busy}
            onClick={() => {
              void libraryApi.remove(item).then((r) => {
                if (!r.ok) return toast({ msg: `没有移到回收站：${r.message}`, tone: 'error' });
                toast({ msg: `已把「${item.title}」移到回收站`, tone: 'info', action: { label: '撤销', run: () => void libraryApi.restore({ ...item, version: r.item?.version ?? item.version + 1 }) } });
                onClose();
              });
            }}
          >
            移到回收站
          </Button>
          <span className="flex-1" />
          <Button className={cn(phone ? 'h-11' : 'h-10 px-4')} disabled={busy} onClick={requestClose}>
            取消
          </Button>
          <Button variant="primary" className={cn(phone ? 'h-11 px-6' : 'h-10 px-6')} disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? <Spinner /> : '保存'}
          </Button>
        </>
      )}
    </footer>
  );

  return (
    <Modal open onClose={requestClose} title="编辑收藏" eyebrow={pathLabel(config.categories, item.folderId)} width={620} phone={phone} footer={footer} label={`编辑「${item.title}」`}>
      <div className={cn('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto', phone ? 'px-4 pt-4 pb-6' : 'px-7 pt-5 pb-6')}>
        <div className="flex items-center gap-3.5">
          <AppTile target={{ kind: 'app', app: head }} size={44} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[15px] font-medium">{draft.title || '未命名'}</span>
            <span className="truncate text-[12.5px] text-ink/52">{draft.url}</span>
          </div>
        </div>

        {conflict && (
          <div role="alert" className="flex flex-col gap-2.5 rounded-xl p-4" style={{ background: 'rgb(var(--nx-amber-rgb)/0.1)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-amber-rgb)/0.35)' }}>
            <span className="text-[14px] font-medium">这条收藏在别处被改过，这次没有保存</span>
            <span className="text-[13px] leading-[1.6] text-ink/72">
              不一致的字段：{conflict.fields.length ? conflict.fields.map((f) => FIELD_LABEL[f] ?? f).join('、') : '部分字段'}。别处现在的名称是「{conflict.current.title}」，网址 {conflict.current.url}，分组「{pathLabel(config.categories, conflict.current.folderId)}」。你填写的内容还在表单里。
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  const current = conflict.current;
                  setConflict(null);
                  setBase(current);
                  void save(current);
                }}
              >
                用我的修改覆盖
              </Button>
              <Button
                onClick={() => {
                  const current = conflict.current;
                  opened.current = draftOf(current, pinned);
                  setBase(current);
                  setDraft(opened.current);
                  setConflict(null);
                }}
              >
                载入别处的版本
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 rounded-xl px-4 py-3 text-[13px] leading-[1.6] text-danger-ink" style={{ background: 'rgb(var(--nx-error-rgb)/0.1)' }}>
            {error}
          </p>
        )}

        <div className={cn('grid gap-4', !phone && 'grid-cols-2')}>
          <TextField label="名称" required value={draft.title} onChange={(v) => set('title', v)} error={show('title')} phone={phone} maxLength={ITEM_LIMITS.title + 50} />
          <TextField label="网址" required value={draft.url} onChange={(v) => set('url', v)} error={show('url')} phone={phone} inputMode="url" mono={!phone} />
        </div>
        <GroupSelect categories={config.categories} value={draft.folderId} onChange={(v) => set('folderId', v)} phone={phone} />
        <ToggleRow
          label="固定到首页"
          sub={draft.hidden ? '隐藏的收藏不能固定到首页' : pinFull ? `首页已经固定满 ${MAX_PINS} 个，先取消固定一个` : draft.pin ? '打开新标签页就能看到它' : `${pinsUsed} / ${MAX_PINS} 已固定`}
          checked={draft.pin}
          disabled={draft.hidden || pinFull}
          onChange={(v) => set('pin', v)}
          phone={phone}
        />

        <Section title="更多选项" summary={[draft.tags.length ? `${draft.tags.length} 个标签` : '', draft.aliases.length ? `${draft.aliases.length} 个别名` : '', draft.note ? '有备注' : '', draft.openIn === 'new' ? '新标签页打开' : ''].filter(Boolean).join(' · ') || '图标、标签、备注、搜索别名、打开方式'} open={more} onToggle={() => setMore((v) => !v)}>
          <IconField icon={draft.icon} name={draft.title} url={draft.url} onChange={(i) => set('icon', i)} phone={phone} />
          <ChipsField label="标签" values={draft.tags} onChange={(v) => set('tags', v)} max={ITEM_LIMITS.tags} maxLength={ITEM_LIMITS.tag} placeholder="输入后按回车" phone={phone} />
          <TextArea label="备注" value={draft.note} onChange={(v) => set('note', v)} maxLength={ITEM_LIMITS.note} hint={show('note') ?? `${[...draft.note].length} / ${ITEM_LIMITS.note}`} phone={phone} />
          <ChipsField label="搜索别名" values={draft.aliases} onChange={(v) => set('aliases', v)} max={12} maxLength={32} placeholder="例如：jf、影音" hint="在首页搜索和快速打开里，用这些词也能找到它" phone={phone} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink/80">打开方式</span>
            <Segmented className="self-start" label="打开方式" value={draft.openIn} options={[{ value: 'same', label: '当前标签页' }, { value: 'new', label: '新标签页' }]} onChange={(v) => set('openIn', v)} />
          </div>
          <ToggleRow label="在首页与快速打开中隐藏" sub="隐藏后仍在我的收藏里，可随时取消" checked={draft.hidden} onChange={(v) => setDraft((d) => ({ ...d, hidden: v, pin: v ? false : d.pin }))} phone={phone} />
        </Section>

        <Section title="服务选项" summary={draft.service ? ['自托管服务', draft.lanUrl ? '有内网地址' : '', draft.health.enabled ? '检查服务状态' : ''].filter(Boolean).join(' · ') : '自己的服务：内网地址、默认打开、服务状态'} open={svcOpen} onToggle={() => setSvcOpen((v) => !v)}>
          <ToggleRow label="这是自己的服务" sub="例如 NAS、Jellyfin：可以填内网地址，在「服务」视图里找到它" checked={draft.service} onChange={(v) => set('service', v)} phone={phone} />
          {draft.service && (
            <>
              <TextField label="内网地址" value={draft.lanUrl} onChange={(v) => set('lanUrl', v)} placeholder="http://192.168.1.10:8096" error={show('lanUrl')} phone={phone} inputMode="url" mono={!phone} />
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink/80">默认打开</span>
                <Segmented className="self-start" label="默认打开" value={draft.prefer} options={[{ value: 'ext', label: '外网地址' }, { value: 'lan', label: '内网地址' }]} onChange={(v) => set('prefer', v)} />
              </div>
              {admin ? (
                <>
                  <ToggleRow label="检查服务状态" sub="由 Nexus 服务端定时访问这个地址，在首页显示运行状态" checked={draft.health.enabled} onChange={(v) => set('health', { ...draft.health, enabled: v })} phone={phone} />
                  {draft.health.enabled && (
                    <div className={cn('grid gap-4', !phone && 'grid-cols-[minmax(0,1fr)_auto]')}>
                      <TextField label="检查路径" value={draft.health.target} onChange={(v) => set('health', { ...draft.health, target: v })} placeholder="/api/health" mono phone={phone} />
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[13px] font-medium text-ink/80">间隔</span>
                        <Segmented label="检查间隔" value={draft.health.intervalSec} options={[{ value: 30, label: '30 秒' }, { value: 60, label: '1 分钟' }, { value: 300, label: '5 分钟' }]} onChange={(v) => set('health', { ...draft.health, intervalSec: v })} />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <span className="text-[12.5px] leading-[1.6] text-ink/52">服务状态检查由管理员开启：普通账号不能让服务端去访问任意地址。</span>
              )}
            </>
          )}
        </Section>
      </div>
    </Modal>
  );
}
