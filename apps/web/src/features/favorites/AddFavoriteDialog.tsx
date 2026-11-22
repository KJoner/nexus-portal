import { canonicalUrl, catalogState, catalogToApp, hostOf, ITEM_LIMITS, looksLikeUrl, MAX_PINS, toNavigableUrl, UNFILED, type CatalogItem, type CatalogState, type CreateFavoritesAnswer, type FavoriteInput, type Item } from '@nexus/shared';
import { ArrowLeft, Grid2x2, Link2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from '../../components/toast-store';
import { useConfig } from '../../data/config-store';
import { libraryApi, loadLibrary, useLibrary, type WriteOutcome } from '../../data/library';
import { AppTile } from '../../icons/AppTile';
import { cn } from '../../lib/cn';
import { useViewport, useVisualViewport } from '../../lib/hooks';
import { Button, Segmented, Spinner } from '../settings/ui';
import { useCatalog } from '../catalog/catalog-store';
import { openEditFavorite, useFavoriteDialogs, type AddRequest } from './dialog-store';
import { asApp, pathLabel } from './model';
import { ChipsField, GroupSelect, Modal, Section, TextArea, TextField, ToggleRow } from './parts';
import { StorePicker } from './StorePicker';

/**
 * 添加收藏 (UI v2 · spec 01 §5, 02 N3, 05 N3): one dialog, two sources. A desktop shows the manual
 * form (left, ~390 px) next to 应用商店 (right); as soon as a store site is picked the left becomes
 * the list of what will be added and there is ONE primary action, 「添加 N 个网站」 — 返回手动填写
 * brings the unsent form back as it was. A phone shows the two as tabs with the action fixed at the
 * bottom. Where favorites go (分组) and whether they are pinned are chosen explicitly; a pin over the
 * home page's limit is explained before sending and never drops a favorite (libraryApi.addFavorites:
 * one transaction; offline it waits with its opId). After adding: back where you were, with 撤销.
 */
interface Manual {
  url: string;
  title: string;
  titleTouched: boolean;
  tags: string[];
  note: string;
  aliases: string[];
  openIn: 'same' | 'new';
  service: boolean;
  lanUrl: string;
  prefer: 'ext' | 'lan';
}

const blank = (req: AddRequest): Manual => {
  const raw = req.url.trim();
  const url = raw ? (looksLikeUrl(raw) ? toNavigableUrl(raw) : raw) : '';
  return { url, title: req.title.slice(0, ITEM_LIMITS.title), titleTouched: !!req.title, tags: [], note: '', aliases: [], openIn: 'same', service: false, lanUrl: '', prefer: 'ext' };
};
const nameFromUrl = (url: string) => {
  const h = hostOf(url).replace(/^www\./, '');
  return h ? h.split('.').slice(0, -1).join('.') || h : '';
};

function liveCatalogState(item: CatalogItem, apps: ReturnType<typeof asApp>[]): CatalogState {
  return catalogState(item, apps);
}

/** Says what an add did (and what it could not), in one line. */
function addedMessage(a: CreateFavoritesAnswer | undefined, group: string, n: number): string {
  if (!a) return `已添加到「${group}」`;
  const created = a.results.filter((r) => r.result === 'created').length;
  const updated = a.results.filter((r) => r.result === 'updated').length;
  const skipped = a.results.filter((r) => r.result === 'skipped').length;
  const parts = [created ? (n === 1 && created === 1 ? `已添加「${a.results[0]!.item.title}」到「${group}」` : `已添加 ${created} 个到「${group}」`) : '', updated ? `更新了 ${updated} 个已有的` : '', skipped ? `${skipped} 个已在我的收藏，已跳过` : ''].filter(Boolean);
  const notPinned = a.pin?.notPinned?.length ?? 0;
  if (notPinned) parts.push(`首页已满，${notPinned} 个只加入收藏、没有固定`);
  return parts.join('，') || '没有新加内容';
}

export function AddFavoriteDialog() {
  const req = useFavoriteDialogs((s) => s.add);
  const hide = useFavoriteDialogs((s) => s.hideAdd);
  if (!req) return null;
  return <AddForm req={req} onClose={hide} />;
}

function AddForm({ req, onClose }: { req: AddRequest; onClose(): void }) {
  const config = useConfig();
  const status = useLibrary((s) => s.status);
  const itemsById = useLibrary((s) => s.items);
  const pins = useLibrary((s) => s.pins);
  const { data } = useCatalog();
  const { w, h } = useViewport();
  const phone = !(w >= 900 && h >= 560);
  const vv = useVisualViewport(phone);
  const [tab, setTab] = useState(req.tab);
  const [manual, setManual] = useState<Manual>(() => blank(req));
  const [query, setQuery] = useState(req.q);
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogItem[]>([]);
  const [folderId, setFolderId] = useState(() => (req.folderId && config.categories.some((c) => c.id === req.folderId) ? req.folderId : UNFILED));
  const [pin, setPin] = useState(false);
  const [more, setMore] = useState(false);
  const [svc, setSvc] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<Item | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (status === 'idle') void loadLibrary();
  }, [status]);

  const live = useMemo(() => Object.values(itemsById).filter((i) => i.deletedAt === null), [itemsById]);
  const liveApps = useMemo(() => [...live.map(asApp), ...config.apps], [live, config.apps]);
  const stateOf = (item: CatalogItem) => liveCatalogState(item, liveApps);
  const group = pathLabel(config.categories, folderId);
  const storeMode = selected.length > 0;
  const n = storeMode ? selected.length : 1;
  const pinRoom = Math.max(0, MAX_PINS - pins.length);
  const pinShort = pin && n > pinRoom;

  const urlError = !manual.url.trim() ? '请填写网址' : !canonicalUrl(manual.url.trim()) ? '只能收藏 http 或 https 网址，且不能包含用户名或密码' : undefined;
  const titleError = !manual.title.trim() ? '请填写名称' : [...manual.title.trim()].length > ITEM_LIMITS.title ? `名称最多 ${ITEM_LIMITS.title} 个字` : undefined;
  const lanError = manual.lanUrl.trim() && !canonicalUrl(manual.lanUrl.trim()) ? '内网地址也要是 http 或 https 网址' : undefined;
  const manualDirty = !!(manual.url.trim() || (manual.titleTouched && manual.title.trim()) || manual.tags.length || manual.note || manual.aliases.length);
  const dirty = manualDirty || selected.length > 0;

  const setM = (patch: Partial<Manual>) => {
    setManual((m) => ({ ...m, ...patch }));
    setConfirmClose(false);
    setDuplicate(null);
    setError('');
  };
  const onUrl = (v: string) => {
    setManual((m) => {
      const next = { ...m, url: v };
      const navigable = looksLikeUrl(v.trim()) ? toNavigableUrl(v.trim()) : '';
      // A pasted address fills an empty name — never over what the person typed.
      if (!m.titleTouched && navigable) next.title = nameFromUrl(navigable);
      return next;
    });
    setDuplicate(null);
    setError('');
  };
  const requestClose = () => {
    if (dirty && !confirmClose && !busy) return setConfirmClose(true);
    if (!busy) onClose();
  };

  const finish = (r: WriteOutcome, count: number) => {
    const answer = r.ok ? (r.answer as CreateFavoritesAnswer | undefined) : undefined;
    if (r.ok && r.queued) {
      toast({ msg: `已离线保存，联网后添加到「${group}」`, tone: 'warn' });
      onClose();
      return;
    }
    const created = answer?.results.filter((x) => x.result === 'created').map((x) => x.item) ?? [];
    toast({
      msg: addedMessage(answer, group, count) + (answer?.healthForcedOff ? '；服务状态检查只有管理员能开启' : ''),
      tone: created.length ? 'info' : 'ok',
      ...(created.length && created.length === answer?.results.length ? { action: { label: '撤销', run: () => void Promise.all(created.map((i) => libraryApi.remove(i))).then(() => toast({ msg: '已撤销这次添加', tone: 'ok' })) } } : {}),
    });
    onClose();
  };

  const submitManual = async (policy: 'prompt' | 'update' | 'create' = 'prompt') => {
    setTried(true);
    if (urlError || titleError || lanError) return;
    setBusy(true);
    setError('');
    const url = toNavigableUrl(manual.url.trim());
    const app = { openIn: manual.openIn, ...(manual.aliases.length ? { aliases: manual.aliases } : {}), ...(manual.service ? { kind: 'service' as const, lanUrl: manual.lanUrl.trim(), prefer: manual.prefer } : {}) };
    const item: FavoriteInput = { kind: 'app', title: manual.title.trim(), url, folderId, tags: manual.tags, note: manual.note, app };
    const r = await libraryApi.addFavorites({ source: 'manual', folderId, pin, duplicatePolicy: policy, items: [item] });
    setBusy(false);
    if (!r.ok && r.code === 'DUPLICATE') {
      setDuplicate((r.details?.item ?? null) as Item | null);
      return;
    }
    if (!r.ok) return setError(`没有添加：${r.message}`);
    finish(r, 1);
  };

  const submitStore = async () => {
    if (!selected.length) return;
    setBusy(true);
    setError('');
    const items: FavoriteInput[] = selected.map((c) => {
      const a = catalogToApp(c, [], folderId);
      return { kind: 'app', title: a.name, url: a.url, folderId, catalogId: c.id, app: { kind: 'site', icon: a.icon, aliases: a.aliases, ...(a.description ? { description: a.description } : {}), openIn: a.openIn, catalogVersion: c.version } };
    });
    const r = await libraryApi.addFavorites({ source: 'catalog', folderId, pin, duplicatePolicy: 'skip', items });
    setBusy(false);
    if (!r.ok) return setError(`没有添加：${r.message}。所选网站都还在，可以再试一次。`);
    finish(r, items.length);
  };

  const toggle = (c: CatalogItem) => setSelected((s) => (s.some((x) => x.id === c.id) ? s.filter((x) => x.id !== c.id) : [...s, c]));
  const viewExisting = (c: CatalogItem) => {
    const canon = canonicalUrl(c.url);
    const hit = live.find((i) => i.catalogId === c.id) ?? live.find((i) => canonicalUrl(i.url) === canon) ?? live.find((i) => hostOf(i.url).replace(/^www\./, '') === hostOf(c.url).replace(/^www\./, ''));
    if (hit) openEditFavorite(hit.id);
    else toast({ msg: `「${c.name}」已在首页的收藏里`, tone: 'info' });
  };
  const toManual = (q: string) => {
    const t = q.trim();
    if (looksLikeUrl(t)) onUrl(t);
    else if (t) setM({ title: t.slice(0, ITEM_LIMITS.title), titleTouched: true });
    setSelected([]);
    setTab('manual');
  };

  const targetControls = (
    <div className="flex flex-col gap-4">
      <GroupSelect categories={config.categories} value={folderId} onChange={setFolderId} label="保存到分组" phone={phone} />
      <ToggleRow
        label="同时固定到首页"
        sub={pinShort ? `首页最多固定 ${MAX_PINS} 个，还能固定 ${pinRoom} 个：${pinRoom ? `前 ${pinRoom} 个会固定，` : ''}其余只加入收藏、不会丢` : pin ? '打开新标签页就能看到' : `${pins.length} / ${MAX_PINS} 已固定`}
        checked={pin}
        onChange={setPin}
        phone={phone}
      />
    </div>
  );

  const manualForm = (
    <div className="flex flex-col gap-4">
      {duplicate && (
        <div role="alert" className="flex flex-col gap-2.5 rounded-xl p-3.5" style={{ background: 'rgb(var(--nx-amber-rgb)/0.1)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-amber-rgb)/0.35)' }}>
          <span className="text-[13.5px] leading-[1.6]">
            这个网址已在我的收藏：「{duplicate.title}」，在「{pathLabel(config.categories, duplicate.folderId)}」。
          </span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void submitManual('update')}>
              更新原有的
            </Button>
            <Button size="sm" onClick={() => void submitManual('create')}>
              另存一条
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openEditFavorite(duplicate.id)}>
              查看原有的
            </Button>
          </div>
        </div>
      )}
      <TextField label="网址" required value={manual.url} onChange={onUrl} onBlur={() => manual.url.trim() && !/^https?:\/\//i.test(manual.url.trim()) && looksLikeUrl(manual.url.trim()) && onUrl(toNavigableUrl(manual.url.trim()))} placeholder="https://example.com" error={tried ? urlError : undefined} inputMode="url" phone={phone} autoFocus={!phone && tab === 'manual' && !req.url} />
      <TextField label="名称" required value={manual.title} onChange={(v) => setM({ title: v, titleTouched: true })} placeholder="给这个收藏起个名字" error={tried ? titleError : undefined} phone={phone} maxLength={ITEM_LIMITS.title + 50} />
      {targetControls}
      <Section title="更多选项" summary="标签、备注、搜索别名、打开方式" open={more} onToggle={() => setMore((v) => !v)}>
        <ChipsField label="标签" values={manual.tags} onChange={(v) => setM({ tags: v })} max={ITEM_LIMITS.tags} maxLength={ITEM_LIMITS.tag} placeholder="输入后按回车" phone={phone} />
        <TextArea label="备注" value={manual.note} onChange={(v) => setM({ note: v })} maxLength={ITEM_LIMITS.note} phone={phone} />
        <ChipsField label="搜索别名" values={manual.aliases} onChange={(v) => setM({ aliases: v })} max={12} maxLength={32} placeholder="例如：jf、影音" phone={phone} />
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink/80">打开方式</span>
          <Segmented className="self-start" label="打开方式" value={manual.openIn} options={[{ value: 'same', label: '当前标签页' }, { value: 'new', label: '新标签页' }]} onChange={(v) => setM({ openIn: v })} />
        </div>
      </Section>
      <Section title="服务选项" summary="自己的服务：内网地址、默认打开" open={svc} onToggle={() => setSvc((v) => !v)}>
        <ToggleRow label="这是自己的服务" sub="例如 NAS、Jellyfin；服务状态检查可在保存后由管理员开启" checked={manual.service} onChange={(v) => setM({ service: v })} phone={phone} />
        {manual.service && (
          <>
            <TextField label="内网地址" value={manual.lanUrl} onChange={(v) => setM({ lanUrl: v })} placeholder="http://192.168.1.10:8096" error={tried ? lanError : undefined} inputMode="url" phone={phone} />
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink/80">默认打开</span>
              <Segmented className="self-start" label="默认打开" value={manual.prefer} options={[{ value: 'ext', label: '外网地址' }, { value: 'lan', label: '内网地址' }]} onChange={(v) => setM({ prefer: v })} />
            </div>
          </>
        )}
      </Section>
    </div>
  );

  const selection = (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[14px] font-medium">已选择 {selected.length} 个网站</span>
        <button type="button" onClick={() => setSelected([])} className="flex h-9 items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12.5px] text-ink/70 hover:bg-ink/8">
          <ArrowLeft className="size-3.5" />
          返回手动填写
        </button>
      </div>
      <ul aria-label="将要添加的网站" className="m-0 flex flex-col gap-1.5 p-0">
        {selected.map((c) => (
          <li key={c.id} className="flex min-h-12 list-none items-center gap-3 rounded-xl px-3 py-1.5" style={{ background: 'rgb(var(--nx-ink-rgb)/0.045)' }}>
            <AppTile target={{ kind: 'app', app: catalogToApp(c, [], UNFILED) }} size={30} lazy />
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{c.name}</span>
            <button type="button" aria-label={`不添加 ${c.name}`} onClick={() => toggle(c)} className="grid size-9 place-items-center rounded-lg border-0 bg-transparent text-ink/55 hover:bg-ink/8 hover:text-ink">
              <X className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {targetControls}
    </div>
  );

  const primary = storeMode ? (
    <Button variant="primary" className={cn('w-full', phone ? 'h-12 text-[15px]' : 'h-11 text-[14px]')} disabled={busy} onClick={() => void submitStore()}>
      {busy ? <Spinner /> : `添加 ${selected.length} 个网站`}
    </Button>
  ) : (
    <Button variant="primary" className={cn('w-full', phone ? 'h-12 text-[15px]' : 'h-11 text-[14px]')} disabled={busy} onClick={() => void submitManual()}>
      {busy ? <Spinner /> : '添加这个收藏'}
    </Button>
  );

  const confirmBar = confirmClose && (
    <div role="alert" className="flex flex-wrap items-center gap-2.5">
      <span className="min-w-0 flex-1 text-[13px] text-ink/80">{selected.length ? `已选择的 ${selected.length} 个网站还没有添加，` : '填写的内容还没有保存，'}确定关闭吗？</span>
      <Button size="sm" onClick={() => setConfirmClose(false)}>
        继续添加
      </Button>
      <Button size="sm" variant="danger" onClick={onClose}>
        关闭
      </Button>
    </div>
  );
  const errorLine = error && (
    <p role="alert" className="m-0 text-[13px] leading-[1.6] text-danger-ink">
      {error}
    </p>
  );

  if (phone) {
    const storeTab = tab === 'store';
    return (
      <Modal open onClose={requestClose} title="添加收藏" eyebrow="把喜欢的，留在手边" width={0} phone label="添加收藏">
        <div className="flex flex-none gap-1 px-4 pt-3" role="tablist" aria-label="添加方式">
          {(
            [
              ['manual', '添加网址', Link2],
              ['store', '应用商店', Grid2x2],
            ] as const
          ).map(([k, label, Icon]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border-0 text-[14px]', tab === k ? 'bg-ink/12 text-ink' : 'bg-transparent text-ink/62')}>
              <Icon className="size-4" />
              {label}
              {k === 'store' && selected.length > 0 && <span className="rounded-full bg-amber px-1.5 text-[11px] text-on-amber">{selected.length}</span>}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-4" role="tabpanel">
          {storeTab ? <StorePicker query={query} onQuery={setQuery} category={category} onCategory={setCategory} selected={selected.map((s) => s.id)} onToggle={toggle} stateOf={stateOf} onViewExisting={viewExisting} onManual={toManual} phone /> : storeMode ? selection : manualForm}
        </div>
        <div className="flex flex-none flex-col gap-3 border-t border-ink/8 px-4 pt-3" style={{ paddingBottom: `calc(env(safe-area-inset-bottom) + 12px${vv ? ` + ${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px` : ''})` }}>
          {storeTab && storeMode && <span className="text-[12.5px] text-ink/62">加入「{group}」{pin ? '并固定到首页' : ''}</span>}
          {storeTab && selected.length === 0 ? (
            <Button variant="primary" className="h-12 w-full text-[15px]" disabled>
              选择想添加的网站
            </Button>
          ) : (
            primary
          )}
          {confirmBar}
          {errorLine}
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={requestClose} title="添加收藏" eyebrow="把喜欢的，留在手边" width={Math.min(1120, w - 48)} phone={false} label="添加收藏">
      <div className="grid min-h-0 flex-1 grid-cols-[390px_minmax(0,1fr)]" style={{ maxHeight: 'min(720px, calc(100dvh - 160px))' }}>
        <section aria-label={storeMode ? '将要添加的网站' : '添加网址'} className="flex min-h-0 flex-col border-r border-ink/8">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pt-5 pb-4">
            {!storeMode && (
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-[10px] bg-amber/14 text-amber">
                  <Link2 className="size-[17px]" />
                </span>
                <div className="flex flex-col">
                  <span className="text-[15px] font-medium">添加网址</span>
                  <span className="text-[12.5px] text-ink/52">网页、网站，或你自己的服务。</span>
                </div>
              </div>
            )}
            {storeMode ? selection : manualForm}
          </div>
          <div className="flex flex-none flex-col gap-2.5 border-t border-ink/8 px-7 py-4">
            {primary}
            {!confirmBar && !errorLine && <span className="text-center text-[12px] text-ink/50">保存到「我的收藏」，随时可以编辑。</span>}
            {confirmBar}
            {errorLine}
          </div>
        </section>
        <section aria-label="应用商店" className="flex min-h-0 flex-col gap-3 px-7 pt-5 pb-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-[10px] bg-amber/14 text-amber">
              <Grid2x2 className="size-[17px]" />
            </span>
            <div className="flex flex-1 flex-col">
              <span className="text-[15px] font-medium">应用商店</span>
              <span className="text-[12.5px] text-ink/52">精选网站，添加快捷入口。{data ? `共 ${data.items.length} 个` : ''}</span>
            </div>
          </div>
          <StorePicker query={query} onQuery={setQuery} category={category} onCategory={setCategory} selected={selected.map((s) => s.id)} onToggle={toggle} stateOf={stateOf} onViewExisting={viewExisting} onManual={toManual} phone={false} autoFocus={tab === 'store'} />
        </section>
      </div>
    </Modal>
  );
}
