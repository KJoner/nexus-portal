import { hostOf, LOCKED_CATEGORY, MAX_PINS, newAppId, slug, TONES, validateApp, type AppEntry, type Op } from '@nexus/shared';
import { ChevronDown, Upload, X } from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { testHealth, useConfig, uploadIcon } from '../../../data/config-store';
import { BUILTIN_GLYPHS, libraryIconUrl } from '../../../icons/glyphs';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { apply } from '../model';
import { Button, NotYet, Row, Segmented, Spinner, Switch, useCompact } from '../ui';

export function blankApp(name = ''): AppEntry {
  return {
    id: '',
    kind: 'site',
    name,
    description: '',
    url: '',
    lanUrl: '',
    prefer: 'ext',
    categoryId: LOCKED_CATEGORY.none,
    hidden: false,
    showInServices: true,
    aliases: [],
    icon: { source: 'auto', ref: '', letter: '', tone: 0 },
    openIn: 'same',
    health: { enabled: false, target: '/', intervalSec: 60 },
  };
}

interface Props {
  /** Existing app id, or null for a new one. */
  appId: string | null;
  initialName?: string;
  onClose(): void;
  onDelete(id: string): void;
}

type FieldKey = 'name' | 'url' | 'lanUrl' | 'health' | 'letter';

/** 别名 (v0.2): several short names an app can also be found by; Enter or a comma adds one. */
function AliasEditor({ aliases, onChange }: { aliases: string[]; onChange(next: string[]): void }) {
  const compact = useCompact();
  const [text, setText] = useState('');
  const full = aliases.length >= 12;
  const add = () => {
    const next = [...aliases];
    for (const part of text.split(/[,，、]/)) {
      const a = part.trim().slice(0, 32);
      if (a && next.length < 12 && !next.some((x) => x.toLowerCase() === a.toLowerCase())) next.push(a);
    }
    if (next.length !== aliases.length) onChange(next);
    setText('');
  };
  return (
    <div className={cn('flex flex-col gap-2', compact && 'px-4 py-3')}>
      <span className="flex items-baseline gap-2 text-[13px] text-ink/72">
        别名
        <span className="text-[12px] text-ink/42">可选 · 搜索时用这些简称也能找到它，最多 12 个</span>
      </span>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl px-2 py-1.5" style={{ background: 'rgba(239,234,225,0.06)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.08)' }}>
        {aliases.map((a, i) => (
          <span key={a} className="flex h-7 items-center gap-1 rounded-lg bg-ink/10 pr-1 pl-2.5 text-[13px]">
            {a}
            <button type="button" aria-label={`删除别名 ${a}`} onClick={() => onChange(aliases.filter((_, k) => k !== i))} className="grid size-5 place-items-center rounded-md border-0 bg-transparent p-0 text-ink/60 hover:bg-ink/12 hover:text-ink">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={text}
          disabled={full}
          maxLength={40}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && !text && aliases.length) onChange(aliases.slice(0, -1));
          }}
          onBlur={add}
          placeholder={full ? '已达上限' : aliases.length ? '再加一个' : '例如 gh、代码托管'}
          aria-label="添加别名"
          className="h-7 min-w-[120px] flex-1 border-0 bg-transparent px-1 text-[14px] text-ink caret-amber outline-none"
          style={{ fontSize: compact ? 16 : undefined }}
        />
      </div>
    </div>
  );
}

/**
 * R2 · 表单手动保存: nothing is written until 保存; errors appear after blur or a save attempt;
 * closing with changes asks to discard first.
 */
export function AppEditor({ appId, initialName, onClose, onDelete }: Props) {
  const config = useConfig();
  const compact = useCompact();
  const existing = appId ? config.apps.find((a) => a.id === appId) : undefined;
  const wasPinned = !!existing && config.pins.includes(existing.id);
  const [draft, setDraft] = useState<AppEntry>(() => existing ?? blankApp(initialName));
  const [pin, setPin] = useState(wasPinned);
  const orig = useRef(JSON.stringify({ d: existing ?? blankApp(initialName), p: wasPinned }));
  const [touched, setTouched] = useState<Set<FieldKey>>(new Set());
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [libQ, setLibQ] = useState(() => (draft.icon.source === 'library' ? draft.icon.ref : slug(draft.name)));
  const [libMiss, setLibMiss] = useState(false);
  const [upBusy, setUpBusy] = useState(false);
  const [upErr, setUpErr] = useState('');
  const [newCat, setNewCat] = useState<string | null>(null);
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string } | null>(null);

  const isNew = !existing;
  const svc = draft.kind === 'service';
  const dirty = JSON.stringify({ d: draft, p: pin }) !== orig.current;
  const v = useMemo(() => validateApp(draft, config.apps), [draft, config.apps]);
  const err = (k: FieldKey) => (tried || touched.has(k) ? v.errors[k] : undefined);
  const errCount = Object.keys(v.errors).length;
  const pinsFull = !svc && !wasPinned && config.pins.length >= MAX_PINS;
  const pos = wasPinned ? config.pins.indexOf(draft.id) + 1 : config.pins.length + 1;

  const set = (fn: (d: AppEntry) => AppEntry) => {
    setDraft((d) => fn(structuredClone(d)));
    setConfirm(false);
    setTest(null);
  };

  const runTest = async () => {
    setTest({ busy: true });
    try {
      const r = await testHealth({ ...draft, id: draft.id || 'draft', name: draft.name.trim() || 'draft' });
      setTest({ busy: false, ok: r.ok, text: r.message });
    } catch (e) {
      setTest({ busy: false, ok: false, text: e instanceof Error ? e.message : '测试失败' });
    }
  };
  const touch = (k: FieldKey) => setTouched((t) => new Set(t).add(k));

  // Icon library lookup, 300 ms after typing stops (R2 · 图标库匹配).
  useEffect(() => {
    if (draft.icon.source !== 'library' || !libQ.trim()) return;
    const ref = libQ.trim().toLowerCase();
    const t = setTimeout(() => {
      const img = new Image();
      img.onload = () => {
        setLibMiss(false);
        set((d) => ({ ...d, icon: { ...d.icon, ref } }));
      };
      img.onerror = () => setLibMiss(true);
      img.src = libraryIconUrl(ref, config.settings.privacy.cacheIcons);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libQ, draft.icon.source]);

  const requestClose = () => {
    if (dirty && !confirm) return setConfirm(true);
    onClose();
  };

  const save = () => {
    if (!v.ok) {
      setTried(true);
      return;
    }
    const id = existing?.id ?? newAppId(draft.name || hostOf(draft.url), config.apps);
    const app: AppEntry = { ...draft, id, name: draft.name.trim(), url: draft.url.trim(), lanUrl: draft.lanUrl.trim() };
    const ops: Op[] = [{ type: 'app.upsert', app }];
    if (!svc && pin && !wasPinned && !pinsFull) ops.push({ type: 'pin.add', appId: id });
    if (!svc && !pin && wasPinned) ops.push({ type: 'pin.remove', appId: id });
    if (apply(ops, isNew ? `已添加 ${app.name}` : `已保存 ${app.name} 的更改`)) onClose();
  };

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(svg\+xml|png|webp)$/.test(file.type)) return setUpErr('请使用 SVG、PNG 或 WebP');
    if (file.size > 1024 * 1024) return setUpErr(`文件为 ${(file.size / 1048576).toFixed(1)} MB，超过 1 MB 上限`);
    setUpBusy(true);
    setUpErr('');
    try {
      const ref = await uploadIcon(file);
      set((d) => ({ ...d, icon: { ...d.icon, source: 'upload', ref } }));
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUpBusy(false);
    }
  };

  const addCategory = () => {
    const label = (newCat ?? '').trim();
    if (!label) return;
    const id = `c${Date.now().toString(36)}`;
    const cats = [...config.categories];
    const at = cats.findIndex((c) => c.id === LOCKED_CATEGORY.none);
    cats.splice(at < 0 ? cats.length : at, 0, { id, label, locked: false });
    if (apply({ type: 'categories.replace', categories: cats })) {
      set((d) => ({ ...d, categoryId: id }));
      setNewCat(null);
    }
  };

  const hasBuiltin = svc && !!BUILTIN_GLYPHS[draft.icon.ref || draft.id];
  const iconOptions = [hasBuiltin ? { value: 'builtin' as const, label: '内置' } : { value: 'auto' as const, label: '自动' }, { value: 'library' as const, label: '图标库' }, { value: 'upload' as const, label: '上传' }, { value: 'letter' as const, label: '字母' }];
  const catOptions = config.categories.filter((c) => svc || c.id !== LOCKED_CATEGORY.hosted);
  const pinHint = svc
    ? draft.showInServices
      ? 'Dock 与手机首页的服务区会显示它和状态角标'
      : '只在「全部应用」和搜索中出现'
    : pinsFull
      ? `首页已固定 ${MAX_PINS} 个网站，先在「首页与快捷方式」中移除一个`
      : pin
        ? pos <= config.settings.home.dockSize
          ? `首页第 ${pos} 位 · 桌面 Dock 与手机首页都显示`
          : `首页第 ${pos} 位 · 桌面 Dock 只显示前 ${config.settings.home.dockSize} 个，此项仅在手机显示`
        : '不固定时仍可在「全部应用」和搜索中找到';

  const input = (props: { label: string; required?: boolean; optional?: boolean; value: string; onChange(v: string): void; onBlur?(): void; error?: string; warn?: string; placeholder?: string; mono?: boolean; inputMode?: 'url' }) =>
    compact ? (
      <label className="flex min-h-[52px] items-center gap-3 px-4" style={{ boxShadow: props.error ? 'inset 3px 0 0 #e9765f' : undefined }}>
        <span className="w-[76px] flex-none text-[15px]">{props.label}</span>
        <input
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onBlur}
          placeholder={props.placeholder ?? (props.required ? '必填' : '可选')}
          aria-invalid={!!props.error}
          inputMode={props.inputMode}
          autoCapitalize="off"
          spellCheck={false}
          autoComplete="off"
          className={cn('h-[50px] min-w-0 flex-1 border-0 bg-transparent text-right text-ink caret-amber outline-none', props.mono ? 'font-mono text-[14px]' : 'text-[16px]')}
        />
      </label>
    ) : (
      <label className="flex flex-col gap-2">
        <span className="text-[13px] text-ink/72">
          {props.label} {props.required && <span className="text-error">*</span>}
          {props.optional && <span className="text-ink/42">可选</span>}
        </span>
        <input
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onBlur}
          placeholder={props.placeholder}
          aria-invalid={!!props.error}
          inputMode={props.inputMode}
          spellCheck={false}
          autoComplete="off"
          className={cn('box-border h-11 rounded-xl border-0 px-3.5 text-ink caret-amber outline-none placeholder:text-ink/38', props.mono ? 'font-mono text-[13px]' : 'text-[14.5px]')}
          style={{ background: 'rgba(239,234,225,0.06)', boxShadow: props.error ? 'inset 0 0 0 1.5px rgba(233,118,95,0.7)' : 'inset 0 0 0 1px rgba(239,234,225,0.08)' }}
        />
        {props.error && <span className="text-[12.5px] text-danger-ink">{props.error}</span>}
        {!props.error && props.warn && <span className="text-[12.5px] text-[#f1c690]">{props.warn}</span>}
      </label>
    );

  const autoHttps = () => {
    touch('url');
    if (draft.url && !/^https?:\/\//i.test(draft.url) && /\./.test(draft.url)) set((d) => ({ ...d, url: `https://${d.url.trim()}` }));
  };

  const iconSection = (
    <div className={cn('flex flex-col gap-2.5', compact && 'rounded-2xl bg-ink/6 p-3')}>
      {!compact && <span className="text-[13px] text-ink/72">图标</span>}
      <Segmented
        className={compact ? undefined : 'self-start'}
        label="图标来源"
        value={draft.icon.source}
        options={iconOptions}
        onChange={(source) => {
          set((d) => ({ ...d, icon: { ...d.icon, source, ref: source === 'builtin' ? d.icon.ref || d.id : source === 'library' ? libQ : source === 'upload' ? (d.icon.source === 'upload' ? d.icon.ref : '') : d.icon.ref } }));
          setUpErr('');
        }}
      />
      {draft.icon.source === 'auto' && <span className="text-[12.5px] leading-[1.6] text-ink/50">从 {hostOf(draft.url) || '网址'} 读取网站图标并放在瓷白底板上；读取失败时显示首字母</span>}
      {draft.icon.source === 'builtin' && <span className="text-[12.5px] leading-[1.6] text-ink/50">使用 Nexus 为该服务绘制的内置图标（暗色余烬材质）</span>}
      {draft.icon.source === 'library' && (
        <>
          <div className="flex items-center gap-2.5">
            <input
              value={libQ}
              onChange={(e) => setLibQ(e.target.value)}
              placeholder="图标名，例如 jellyfin"
              aria-label="图标名"
              spellCheck={false}
              autoCapitalize="off"
              className="box-border h-10 min-w-0 flex-1 rounded-[11px] border-0 bg-ink/6 px-3 font-mono text-[12.5px] text-ink caret-amber outline-none"
              style={{ fontSize: compact ? 14 : undefined }}
            />
            {!compact && <span className="text-[12px] text-ink/46">dashboard-icons</span>}
          </div>
          <span className={cn('text-[12.5px]', libMiss ? 'text-danger-ink' : 'text-ink/50')}>{libMiss ? `图标库中没有「${libQ}」，试试英文名，或改用上传 / 字母` : libQ.trim() ? `已匹配 ${libQ.trim().toLowerCase()}.svg` : '输入图标名'}</span>
        </>
      )}
      {draft.icon.source === 'upload' && (
        <>
          <label className="box-border flex h-14 cursor-pointer items-center gap-3 rounded-xl border-[1.5px] border-dashed border-ink/24 px-4 text-[13px] text-ink/70 hover:bg-ink/4">
            <input type="file" accept="image/svg+xml,image/png,image/webp" className="sr-only" onChange={(e) => void onUpload(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
            {upBusy ? <Spinner /> : <Upload className="size-4" />}
            {upBusy ? '正在处理…' : draft.icon.ref ? '已上传 · 点击更换' : '选择 SVG / PNG / WebP · ≤ 1 MB · 建议 ≥ 128 px'}
          </label>
          {upErr && <span className="text-[12.5px] text-danger-ink">{upErr}</span>}
        </>
      )}
      {draft.icon.source === 'letter' && (
        <div className="flex items-center gap-3">
          <input
            value={draft.icon.letter}
            maxLength={2}
            onChange={(e) => set((d) => ({ ...d, icon: { ...d.icon, letter: e.target.value.slice(0, 2) } }))}
            placeholder={(draft.name || 'J').slice(0, 1)}
            aria-label="图标字母"
            className="box-border h-10 w-[72px] rounded-[11px] border-0 bg-ink/6 text-center text-[15px] text-ink outline-none"
          />
          {TONES.map((t, i) => (
            <button
              key={t[0]}
              type="button"
              aria-label={`色调 ${i + 1}`}
              aria-pressed={draft.icon.tone === i}
              onClick={() => set((d) => ({ ...d, icon: { ...d.icon, tone: i } }))}
              className={cn('border-0', compact ? 'size-11 rounded-xl' : 'size-8 rounded-[10px]')}
              style={{ background: `linear-gradient(180deg,${t[0]},${t[1]})`, boxShadow: draft.icon.tone === i ? '0 0 0 2px #2a2824, 0 0 0 4px #e6c08a' : 'inset 0 0 0 1px rgba(239,234,225,0.12)' }}
            />
          ))}
        </div>
      )}
    </div>
  );

  const typeSeg = (
    <Segmented
      label="类型"
      value={draft.kind}
      options={[
        { value: 'site', label: '网站' },
        { value: 'service', label: '自托管服务' },
      ]}
      onChange={(kind) =>
        set((d) => ({
          ...d,
          kind,
          categoryId: kind === 'service' ? LOCKED_CATEGORY.hosted : d.categoryId === LOCKED_CATEGORY.hosted ? LOCKED_CATEGORY.none : d.categoryId,
          prefer: kind === 'site' ? 'ext' : d.prefer,
          icon: kind === 'site' && d.icon.source === 'builtin' ? { ...d.icon, source: 'auto' } : d.icon,
        }))
      }
    />
  );

  const categorySelect = (
    <div className="relative">
      <select
        value={draft.categoryId}
        aria-label="分类"
        onChange={(e) => (e.target.value === '__new' ? setNewCat('') : set((d) => ({ ...d, categoryId: e.target.value })))}
        className={cn('box-border w-full cursor-pointer appearance-none border-0 text-ink outline-none', compact ? 'absolute inset-0 opacity-0' : 'h-11 rounded-xl pr-10 pl-3.5 text-[14px]')}
        style={compact ? { fontSize: 16 } : { background: 'rgba(239,234,225,0.06)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.08)' }}
      >
        {catOptions.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
        <option value="__new">新建分类…</option>
      </select>
      {!compact && <ChevronDown className="pointer-events-none absolute top-[15px] right-3.5 size-3.5 text-ink/50" />}
    </div>
  );

  const newCatRow = newCat !== null && (
    <div className={cn('flex gap-2', compact && 'px-4 pb-3')}>
      <input
        autoFocus
        value={newCat}
        onChange={(e) => setNewCat(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addCategory();
          }
        }}
        placeholder="新分类名称"
        aria-label="新分类名称"
        maxLength={16}
        className="box-border h-10 min-w-0 flex-1 rounded-[11px] border-0 px-3 text-[13.5px] text-ink caret-amber outline-none"
        style={{ background: 'rgba(239,234,225,0.06)', boxShadow: 'inset 0 0 0 1px rgba(230,192,138,0.4)', fontSize: compact ? 16 : undefined }}
      />
      <Button variant="text" className="h-10 bg-amber/16" onClick={addCategory}>
        添加
      </Button>
    </div>
  );

  const pinRow = (
    <Row label={svc ? '显示在首页服务区' : '固定到首页'} sub={<span className={pinsFull ? 'text-[#f1c690]' : undefined}>{pinHint}</span>}>
      <Switch label={svc ? '显示在首页服务区' : '固定到首页'} checked={svc ? draft.showInServices : pin} disabled={pinsFull} onChange={(val) => (svc ? set((d) => ({ ...d, showInServices: val })) : setPin(val))} />
    </Row>
  );

  const openRow = (
    <Row label="打开方式">
      <Segmented
        label="打开方式"
        size={compact ? 'sm' : undefined}
        value={draft.openIn}
        options={[
          { value: 'same', label: '当前标签页' },
          { value: 'new', label: '新标签页' },
        ]}
        onChange={(openIn) => set((d) => ({ ...d, openIn }))}
      />
    </Row>
  );

  const healthBlock = svc && (
    <div className={cn('flex flex-col divide-y divide-ink/6', compact ? 'rounded-2xl bg-ink/6' : 'rounded-2xl bg-ink/4')}>
      <Row label={<>健康检查 <span className="text-[12.5px] text-ink/42">可选</span></>} sub="开启后首页显示状态角标；关闭则标为「未监测」">
        <Switch label="健康检查" checked={draft.health.enabled} onChange={(enabled) => set((d) => ({ ...d, health: { ...d.health, enabled } }))} />
      </Row>
      {draft.health.enabled && (
        <div className={cn('flex flex-col gap-3.5', compact ? 'px-4 py-3' : 'px-4 pt-3.5 pb-4')}>
          <label className="flex flex-col gap-2">
            <span className="text-[12.5px] text-ink/66">检查地址 · 路径或同主机的完整网址</span>
            <input
              value={draft.health.target}
              onChange={(e) => set((d) => ({ ...d, health: { ...d.health, target: e.target.value } }))}
              onBlur={() => touch('health')}
              placeholder="/api/health"
              aria-invalid={!!err('health')}
              spellCheck={false}
              autoCapitalize="off"
              className="box-border h-10 rounded-[11px] border-0 px-3 font-mono text-[12.5px] text-ink caret-amber outline-none"
              style={{ background: 'rgba(239,234,225,0.06)', boxShadow: err('health') ? 'inset 0 0 0 1.5px rgba(233,118,95,0.7)' : 'inset 0 0 0 1px rgba(239,234,225,0.08)', fontSize: compact ? 14 : undefined }}
            />
            {err('health') && <span className="text-[12.5px] text-danger-ink">{err('health')}</span>}
          </label>
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[12.5px] text-ink/66">检查间隔</span>
            <Segmented
              size="sm"
              label="检查间隔"
              value={draft.health.intervalSec}
              options={[
                { value: 30, label: '30 秒' },
                { value: 60, label: '1 分钟' },
                { value: 300, label: '5 分钟' },
              ]}
              onChange={(intervalSec) => set((d) => ({ ...d, health: { ...d.health, intervalSec } }))}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={test?.busy || !!v.errors.url || !!v.errors.lanUrl || !!v.errors.health} onClick={() => void runTest()} className={compact ? 'h-11 flex-1 text-[14.5px]' : undefined}>
              {test?.busy && <Spinner />}
              {test?.busy ? '正在测试…' : '测试连接'}
            </Button>
            {test && !test.busy && (
              <span className="flex min-w-0 items-center gap-[7px] text-[12.5px]" style={{ color: test.ok ? '#c4d7be' : '#f4b2a3' }}>
                <span className="size-[7px] flex-none rounded-full" style={{ background: test.ok ? '#a7bf9f' : '#e9765f' }} />
                <span className="truncate">{test.text}</span>
              </span>
            )}
          </div>
          <span className="text-[11.5px] leading-[1.6] text-ink/42">检查由 Nexus 服务端发起，浏览器不直接请求内网地址；只会访问这个应用自己的外网或内网主机，不发送任何登录凭据。</span>
        </div>
      )}
    </div>
  );

  const header = (
    <div className={cn('flex items-center gap-4', compact ? 'flex-col gap-2 pt-1' : 'rounded-[18px] bg-ink/4 p-4')}>
      <AppTile target={{ kind: 'app', app: { ...draft, icon: draft.icon.source === 'library' && libMiss ? { ...draft.icon, source: 'letter' } : draft.icon } }} size={compact ? 72 : 64} />
      {!compact && (
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className={cn('truncate text-[17px] font-medium', !draft.name.trim() && 'text-ink/42')}>{draft.name.trim() || '未命名'}</span>
          <span className="truncate text-[12.5px] text-ink/50">{hostOf(draft.url) || '尚未填写地址'}</span>
        </span>
      )}
      <span className={cn('flex h-6 items-center rounded-[7px] px-[9px] text-[11.5px] text-ink/70', compact ? 'bg-transparent text-[13px] text-ink/50' : 'bg-ink/8')}>{svc ? '余烬材质 · 自托管' : '瓷白材质 · 网站'}</span>
    </div>
  );

  const errorList = compact && (tried || touched.size > 0) && (
    <div className="-mt-1 flex flex-col gap-1 px-4">
      {(['name', 'url', 'lanUrl'] as const).map((k) => err(k) && <span key={k} className="text-[13px] leading-[1.5] text-danger-ink">{err(k)}</span>)}
      {!err('url') && v.warnings.url && <span className="text-[13px] text-[#f1c690]">{v.warnings.url}</span>}
    </div>
  );

  const body = compact ? (
    <>
      {header}
      {typeSeg}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col divide-y divide-ink/7 rounded-2xl bg-ink/6">
          {input({ label: '名称', required: true, value: draft.name, onChange: (name) => set((d) => ({ ...d, name })), onBlur: () => touch('name'), error: err('name'), warn: v.warnings.name })}
          {input({ label: svc ? '外网地址' : '网址', required: true, mono: true, inputMode: 'url', placeholder: 'https://', value: draft.url, onChange: (url) => set((d) => ({ ...d, url })), onBlur: autoHttps, error: err('url') })}
          {svc && input({ label: '内网地址', optional: true, mono: true, inputMode: 'url', value: draft.lanUrl, onChange: (lanUrl) => set((d) => ({ ...d, lanUrl })), onBlur: () => touch('lanUrl'), error: err('lanUrl') })}
          {svc && (
            <Row label="默认打开">
              <Segmented size="sm" label="默认打开" value={draft.prefer} options={[{ value: 'ext', label: '外网' }, { value: 'lan', label: '内网' }]} onChange={(prefer) => set((d) => ({ ...d, prefer }))} />
            </Row>
          )}
        </div>
        {errorList}
        {svc && <span className="px-4 text-[12.5px] leading-[1.6] text-ink/46">按所在网络自动切换内外网：尚未实现，当前按「默认打开」。</span>}
      </div>
      <div className="rounded-2xl bg-ink/6">
        <AliasEditor aliases={draft.aliases} onChange={(aliases) => set((d) => ({ ...d, aliases }))} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="px-4 text-[13px] text-ink/50">图标</span>
        {iconSection}
      </div>
      <div className="flex flex-col divide-y divide-ink/7 rounded-2xl bg-ink/6">
        <div className="relative flex min-h-[52px] items-center gap-3 px-4">
          <span className="flex-1 text-[15px]">分类</span>
          <span className="text-[15px] text-ink/60">{config.categories.find((c) => c.id === draft.categoryId)?.label ?? '未分类'}</span>
          <ChevronDown className="size-3.5 text-ink/40" />
          {categorySelect}
        </div>
        {newCatRow}
        {pinRow}
        {openRow}
      </div>
      {healthBlock}
      {!isNew && (
        <Button variant="danger" size="lg" className="w-full rounded-2xl" onClick={() => onDelete(draft.id)}>
          删除应用
        </Button>
      )}
    </>
  ) : (
    <>
      {header}
      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-ink/72">类型</span>
        <div className="self-start">{typeSeg}</div>
      </div>
      {input({ label: '名称', required: true, placeholder: '例如 Jellyfin', value: draft.name, onChange: (name) => {
        const follow = !libQ || libQ === slug(draft.name);
        set((d) => ({ ...d, name }));
        if (follow) setLibQ(slug(name));
      }, onBlur: () => touch('name'), error: err('name'), warn: v.warnings.name })}
      {input({ label: svc ? '外网地址' : '网址', required: true, mono: true, inputMode: 'url', placeholder: 'https://', value: draft.url, onChange: (url) => set((d) => ({ ...d, url })), onBlur: autoHttps, error: err('url'), warn: v.warnings.url })}
      <AliasEditor aliases={draft.aliases} onChange={(aliases) => set((d) => ({ ...d, aliases }))} />
      {svc && (
        <>
          {input({ label: '内网地址', optional: true, mono: true, placeholder: 'http://192.168.1.20:3000', value: draft.lanUrl, onChange: (lanUrl) => set((d) => ({ ...d, lanUrl })), onBlur: () => touch('lanUrl'), error: err('lanUrl') })}
          <div className="flex items-center gap-4">
            <span className="flex flex-1 flex-col gap-[3px]">
              <span className="text-[13px] text-ink/72">默认打开</span>
              <span className="flex items-center gap-1.5 text-[12px] text-ink/46">
                按所在网络自动选择
                <NotYet />
              </span>
            </span>
            <Segmented label="默认打开" value={draft.prefer} options={[{ value: 'ext', label: '外网' }, { value: 'lan', label: '内网' }]} onChange={(prefer) => set((d) => ({ ...d, prefer }))} />
          </div>
        </>
      )}
      {iconSection}
      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-ink/72">分类</span>
        {categorySelect}
        {newCatRow}
      </div>
      <div className="flex flex-col divide-y divide-ink/6 rounded-2xl bg-ink/4">
        {pinRow}
        {openRow}
      </div>
      {healthBlock}
    </>
  );

  const footer = confirm ? (
    <>
      <span className="flex-1 text-[13.5px] text-[#f1c690]">有未保存的更改，确定放弃？</span>
      <Button size={compact ? 'lg' : undefined} className={compact ? 'flex-1' : 'h-10'} onClick={() => setConfirm(false)}>
        继续编辑
      </Button>
      <Button size={compact ? 'lg' : undefined} variant="danger" className={compact ? 'flex-1' : 'h-10'} onClick={onClose}>
        放弃更改
      </Button>
    </>
  ) : (
    <>
      {!compact && !isNew && (
        <Button variant="ghost" className="h-10 text-danger-ink hover:bg-error/12" onClick={() => onDelete(draft.id)}>
          删除
        </Button>
      )}
      {!compact && <span className="flex-1 text-[12.5px] text-danger-ink">{tried && errCount ? `还有 ${errCount} 项需要修正` : ''}</span>}
      <Button size={compact ? 'lg' : undefined} className={compact ? 'flex-1' : 'h-10 px-4'} onClick={requestClose}>
        取消
      </Button>
      <Button size={compact ? 'lg' : undefined} variant="primary" className={compact ? 'flex-[1.6]' : 'h-10 px-5'} disabled={!isNew && !dirty} onClick={save}>
        {isNew ? '添加' : '保存'}
      </Button>
    </>
  );

  if (compact) {
    return (
      <>
        <div className="flex flex-col gap-5">{body}</div>
        <div className="fixed inset-x-0 bottom-0 z-8 flex flex-col gap-2 px-4 pt-3 backdrop-blur-[30px]" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))', background: confirm ? 'rgba(48,40,30,0.94)' : 'rgba(30,28,25,0.92)', boxShadow: 'inset 0 1px 0 rgba(239,234,225,0.08)' }}>
          {tried && errCount > 0 && !confirm && <span className="text-[13px] text-danger-ink">还有 {errCount} 项需要修正</span>}
          <div className="flex items-center gap-2.5">{footer}</div>
        </div>
      </>
    );
  }

  return (
    <DrawerShell title={isNew ? '新增应用' : `编辑 ${existing!.name}`} subtitle={isNew ? '保存后出现在全部应用与搜索中' : dirty ? '有未保存的更改' : '尚未修改'} onRequestClose={requestClose} footer={footer} confirming={confirm}>
      {body}
    </DrawerShell>
  );
}

function DrawerShell({ title, subtitle, children, footer, confirming, onRequestClose }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode; confirming: boolean; onRequestClose(): void }) {
  return (
    <RDialog.Root open onOpenChange={(o) => !o && onRequestClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-20 animate-[nx-fade_.24s_ease]" style={{ background: 'rgba(10,9,8,0.5)' }} />
        <RDialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            onRequestClose();
          }}
          onPointerDownOutside={(e) => {
            e.preventDefault();
            onRequestClose();
          }}
          onOpenAutoFocus={(e) => {
            // R2: the editor opens with the cursor in the first field, not on the close button.
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus();
          }}
          className="fixed top-0 right-0 bottom-0 z-21 flex w-[560px] max-w-full animate-[nx-slide_.36s_var(--ease-emph)] flex-col text-ink backdrop-blur-[40px]"
          style={{ background: 'rgba(34,32,28,0.97)', boxShadow: '-30px 0 80px rgba(0,0,0,0.45), inset 1px 0 0 rgba(239,234,225,0.07)' }}
        >
          <div className="flex h-[72px] flex-none items-center gap-3.5 border-b border-ink/6 pr-[18px] pl-7">
            <span className="flex flex-1 flex-col gap-0.5">
              <RDialog.Title className="m-0 text-[18px] font-medium">{title}</RDialog.Title>
              <span className="text-[12.5px] text-ink/50">{subtitle}</span>
            </span>
            <button type="button" onClick={onRequestClose} aria-label="关闭" className="grid size-[38px] place-items-center rounded-full border-0 bg-ink/7 text-ink/80 hover:bg-ink/14">
              <X className="size-[15px]" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-7 pt-6 pb-8">{children}</div>
          <div className="flex h-[72px] flex-none items-center gap-2.5 border-t border-ink/6 pr-5 pl-7 transition-colors duration-200" style={{ background: confirming ? 'rgba(227,163,91,0.08)' : 'transparent' }}>
            {footer}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
