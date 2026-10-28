import { pinnedSites, shownServices, wallpaperFile, type Settings } from '@nexus/shared';
import { Check, CircleAlert, Trash2, Upload, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { deleteWallpaper, uploadWallpaper, useConfig } from '../../../data/config-store';
import { AppTile } from '../../../icons/AppTile';
import { cn } from '../../../lib/cn';
import { formatClock, formatDate } from '../../../lib/time';
import { useWallpapers, Wallpaper, type WallpaperEntry } from '../../home/Wallpaper';
import { lookDiff, useLookDraft } from '../look-draft';
import { patch } from '../model';
import { Button, Dialog, Group, NotYet, PageHeader, Row, Segmented, Slider, Spinner, Switch, useCompact } from '../ui';

type Look = Settings['look'];
const MAX_BYTES = 10 * 1024 * 1024;
const MOTION_SUB = {
  full: '所有过渡与异常呼吸提示；系统开启「减少动态效果」时自动降为减弱',
  reduced: '只保留淡入淡出，去掉位移、缩放与呼吸',
  off: '所有变化瞬时完成；异常改为静态描边',
} as const;

function Preview({ look, device, onFocal }: { look: Look; device: 'desktop' | 'mobile'; onFocal(xy: [number, number]): void }) {
  const config = useConfig();
  const compact = useCompact();
  const now = new Date();
  const time = formatClock(now, look.clock, look.showSeconds);
  const tiles = [...pinnedSites(config).slice(0, config.settings.home.dockSize), ...shownServices(config)];
  const scaled: Look = { ...look, blur: Math.round(look.blur * 0.3 * 10) / 10 };
  const focal = look.focal[device];
  const size = ({ s: [17, 21], m: [20, 24], l: [23, 27] } as const)[look.iconSize];
  const pc = device === 'desktop';
  const box = compact ? { w: '100%', h: 232, r: 22 } : pc ? { w: 416, h: 260, r: 12 } : { w: 160, h: 346, r: 24 };
  return (
    <div
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onFocal([Math.round(((e.clientX - r.left) / r.width) * 100), Math.round(((e.clientY - r.top) / r.height) * 100)]);
      }}
      role="img"
      aria-label="外观预览，点击画面设置焦点"
      className="relative flex-none cursor-crosshair overflow-hidden bg-base transition-[width,height] duration-320 ease-emph"
      style={{ width: box.w, height: box.h, borderRadius: box.r, boxShadow: '0 20px 50px rgba(0,0,0,0.45), 0 0 0 1px rgba(239,234,225,0.08)' }}
    >
      <Wallpaper look={scaled} variant={device} receded={false} />
      <span className="pointer-events-none absolute size-4 -translate-1/2 rounded-full" style={{ left: `${focal[0]}%`, top: `${focal[1]}%`, boxShadow: '0 0 0 1.5px #e6c08a, 0 0 0 4px rgba(0,0,0,0.25)' }} />
      {compact ? (
        <>
          <div className="pointer-events-none absolute top-[18px] left-[18px]">
            <div className="text-[36px] leading-none font-light tracking-[-0.04em] tabular-nums">{time}</div>
            {look.showDate && <div className="mt-[5px] text-[11px] opacity-72">{formatDate(now)}</div>}
          </div>
          <span className="pointer-events-none absolute top-3.5 right-3 flex h-6 items-center rounded-lg px-[9px] text-[11px] text-ink/80" style={{ background: 'rgba(17,16,14,0.5)' }}>
            点按设置焦点
          </span>
          <div className="pointer-events-none absolute right-2.5 bottom-2.5 left-2.5 rounded-[18px] px-2.5 py-3" style={{ background: 'rgba(26,25,22,0.5)' }}>
            <div className="grid grid-cols-8 justify-items-center">
              {tiles.slice(0, 8).map((a) => (
                <AppTile key={a.id} target={{ kind: 'app', app: a }} size={size[1]} />
              ))}
            </div>
          </div>
        </>
      ) : pc ? (
        <div className="pointer-events-none absolute top-[72px] left-1/2 w-[252px] -translate-x-1/2">
          <div className="flex items-baseline gap-[7px] px-[3px] pb-2">
            <span className="text-[24px] leading-none font-light tracking-[-0.03em] tabular-nums">{time}</span>
            {look.showDate && <span className="text-[8px] opacity-70">{formatDate(now)}</span>}
          </div>
          <div className="rounded-[10px] backdrop-blur-[10px]" style={{ background: 'rgba(26,25,22,0.5)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)' }}>
            <div className="flex h-6 items-center px-[9px] text-[7.5px] opacity-60">搜索、输入网址，或打开应用</div>
            <div className="mx-2 h-px bg-ink/12" />
            <div className="flex justify-center px-2 py-[9px]" style={{ gap: look.iconSize === 'l' ? 4 : 6 }}>
              {[...tiles.map((a) => <AppTile key={a.id} target={{ kind: 'app', app: a }} size={size[0]} />), <AppTile key="all" target={{ kind: 'all' }} size={size[0]} />]}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="pointer-events-none absolute top-[30px] left-3.5">
            <div className="text-[26px] leading-none font-light tracking-[-0.04em] tabular-nums">{time}</div>
            {look.showDate && <div className="mt-1 text-[7.5px] opacity-70">{formatDate(now)}</div>}
          </div>
          <div className="pointer-events-none absolute right-1.5 bottom-2.5 left-1.5 rounded-2xl px-2 pt-3 pb-2.5" style={{ background: 'rgba(26,25,22,0.5)' }}>
            <div className="grid grid-cols-4 justify-items-center gap-y-2">
              {tiles.slice(0, config.settings.home.mobileRows * 4).map((a) => (
                <AppTile key={a.id} target={{ kind: 'app', app: a }} size={size[1]} />
              ))}
            </div>
            <div className="mt-2.5 h-[18px] rounded-[7px] bg-ink/12" />
          </div>
        </>
      )}
    </div>
  );
}

function WallCard({ w, selected, onPick, onRemove }: { w: WallpaperEntry; selected: boolean; onPick(): void; onRemove?(): void }) {
  const compact = useCompact();
  return (
    <div className={cn('relative flex flex-col gap-2', compact && 'w-[92px] flex-none snap-start gap-[7px]')}>
      <button
        type="button"
        onClick={onPick}
        aria-pressed={selected}
        aria-label={w.name}
        className={cn('relative overflow-hidden border-0 p-0 transition-shadow duration-140', compact ? 'h-[148px] w-[92px] rounded-[14px]' : 'aspect-[16/10] rounded-xl')}
        style={{ background: w.kind === 'color' ? w.src : '#2a2724', boxShadow: selected ? '0 0 0 2px #1b1a17, 0 0 0 4px #e6c08a' : 'inset 0 0 0 1px rgba(239,234,225,0.08)' }}
      >
        {w.kind === 'photo' && <img src={w.uploaded ? wallpaperFile(w.uploaded.id, w.uploaded.widths[0]!, 'webp') : w.src} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" style={{ filter: w.uploaded ? 'none' : 'grayscale(1) contrast(1.05) brightness(.8)' }} />}
        {selected && (
          <span className="absolute right-1.5 bottom-1.5 grid size-5 place-items-center rounded-full bg-amber">
            <Check className="size-3 text-on-amber" strokeWidth={3} />
          </span>
        )}
      </button>
      <span className="flex items-center gap-1.5 text-[12.5px] text-ink/70">
        <span className="min-w-0 flex-1 truncate">{w.name}</span>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`删除壁纸 ${w.name}`} className="grid size-[22px] flex-none place-items-center rounded-md border-0 bg-transparent text-ink/50 hover:bg-ink/10">
            <Trash2 className="size-[13px]" />
          </button>
        )}
      </span>
    </div>
  );
}

export function AppearancePage() {
  const config = useConfig();
  const compact = useCompact();
  const applied = config.settings.look;
  const draft = useLookDraft((s) => s.draft);
  const setDraft = useLookDraft((s) => s.set);
  const resetDraft = useLookDraft((s) => s.reset);
  const look = draft ?? applied;
  const walls = useWallpapers();
  const [device, setDevice] = useState<'desktop' | 'mobile'>(compact ? 'mobile' : 'desktop');
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'warn'; text: string } | null>(null);
  const [removing, setRemoving] = useState<WallpaperEntry | null>(null);
  const diff = lookDiff(draft, applied);
  const set = <K extends keyof Look>(k: K, v: Look[K]) => setDraft({ ...look, [k]: v });
  const pick = (w: WallpaperEntry) => setDraft({ ...look, wallpaper: w.id, focal: { desktop: w.focal ?? [50, 50], mobile: w.focal ?? [50, 50] } });

  const upload = async (file: File | undefined) => {
    setHover(false);
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type)) return setMsg({ tone: 'error', text: `不支持「${file.name}」的格式，请使用 JPG、PNG、WebP 或 AVIF` });
    if (file.size > MAX_BYTES) return setMsg({ tone: 'error', text: `文件为 ${(file.size / 1048576).toFixed(1)} MB，超过 10 MB 上限` });
    setBusy(true);
    setMsg(null);
    try {
      const w = await uploadWallpaper(file);
      setDraft({ ...look, wallpaper: w.id, focal: { desktop: [50, 50], mobile: [50, 50] } });
      if (w.width < 1920) setMsg({ tone: 'warn', text: `分辨率 ${w.width}×${w.height}，在 1440 以上的屏幕可能略显模糊；建议 ≥ 2560 宽` });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : '上传失败' });
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void upload(e.dataTransfer.files[0]);
  };

  const removeWall = async () => {
    if (!removing) return;
    const id = removing.id;
    setRemoving(null);
    try {
      await deleteWallpaper(id);
      if (draft?.wallpaper === id) setDraft({ ...look, wallpaper: 'fallingwater' });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : '删除失败' });
    }
  };

  const focalRow = (
    <Row label="画面焦点" sub={compact ? '点按顶部预览设置；手机竖屏按焦点裁切' : '在右侧预览上点击设置；桌面与手机分别保存'}>
      <span className="text-[13px] text-ink/70 tabular-nums">
        {look.focal[device][0]}% · {look.focal[device][1]}%
      </span>
      <Button size="sm" onClick={() => setDraft({ ...look, focal: { ...look.focal, [device]: [50, 50] } })}>
        居中
      </Button>
    </Row>
  );

  const uploadCard = (
    <div className={cn('flex flex-col gap-2', compact && 'w-[92px] flex-none gap-[7px]')}>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        className={cn('box-border flex cursor-pointer flex-col items-center justify-center gap-1.5 border-[1.5px] border-dashed text-[12px] text-ink/70 transition-colors duration-140', compact ? 'h-[148px] w-[92px] rounded-[14px]' : 'aspect-[16/10] rounded-xl')}
        style={{ borderColor: hover ? '#e6c08a' : 'rgba(239,234,225,0.26)', background: hover ? 'rgba(230,192,138,0.08)' : 'transparent' }}
      >
        <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" className="sr-only" disabled={busy} onChange={(e) => void upload(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        {busy ? <Spinner className="size-4" /> : <Upload className="size-[18px]" />}
        <span className="px-1 text-center">{busy ? '正在处理…' : hover ? '松开以上传' : compact ? '上传' : '上传或拖放图片'}</span>
      </label>
      <span className="text-[12.5px] text-ink/46">{compact ? '从相册' : 'JPG · PNG · WebP，≤ 10 MB'}</span>
    </div>
  );

  const message = msg && (
    <div className={cn('flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px]', compact ? 'mx-0' : 'mx-5 mb-4')} style={{ background: msg.tone === 'error' ? 'rgba(233,118,95,0.14)' : 'rgba(227,163,91,0.13)', color: msg.tone === 'error' ? '#f4b2a3' : '#f1c690' }}>
      <CircleAlert className="size-[15px] flex-none" />
      <span className="flex-1">{msg.text}</span>
      <button type="button" aria-label="关闭" onClick={() => setMsg(null)} className="grid size-[26px] place-items-center rounded-[7px] border-0 bg-transparent text-inherit">
        <X className="size-3" />
      </button>
    </div>
  );

  const groups = (
    <>
      <Group title="壁纸">
        {compact ? (
          <div className="flex flex-col gap-2 py-3">
            <div className="nx-scroll-hidden flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3">
              {walls.map((w) => (
                <WallCard key={w.id} w={w} selected={look.wallpaper === w.id} onPick={() => pick(w)} onRemove={w.uploaded ? () => setRemoving(w) : undefined} />
              ))}
              {uploadCard}
            </div>
            {message && <div className="px-3">{message}</div>}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-5 gap-3.5 p-5">
              {walls.map((w) => (
                <WallCard key={w.id} w={w} selected={look.wallpaper === w.id} onPick={() => pick(w)} onRemove={w.uploaded ? () => setRemoving(w) : undefined} />
              ))}
              {uploadCard}
            </div>
            {message}
          </div>
        )}
        <Row label="色调" sub="暖调单色让任意照片都与琥珀色界面协调" stacked>
          <Segmented label="色调" value={look.tone} options={[{ value: 'warm', label: '暖调单色' }, { value: 'original', label: '保留原色' }]} onChange={(v) => set('tone', v)} />
        </Row>
        {focalRow}
        <Row label={<>每日轮换 <NotYet /></>} sub="从图库与上传中每天换一张" disabled>
          <Switch label="每日轮换" checked={false} disabled />
        </Row>
      </Group>

      <Group title="背景">
        {(
          [
            ['overlay', '遮罩强度', '越强文字越清晰', 0, 80, '%'],
            ['brightness', '亮度', '调整壁纸本身', 60, 120, '%'],
            ['blur', '模糊', '0 为清晰', 0, 24, 'px'],
          ] as const
        ).map(([k, label, sub, min, max, unit]) =>
          compact ? (
            <div key={k} className="flex flex-col gap-0.5 px-4 pt-3 pb-2">
              <div className="flex justify-between text-[15px]">
                <span>{label}</span>
                <span className="text-ink/60 tabular-nums">{`${look[k]}${unit}`}</span>
              </div>
              <Slider label={label} min={min} max={max} unit={unit} value={look[k]} onChange={(v) => set(k, v)} />
            </div>
          ) : (
            <Row key={k} label={label} sub={sub} className="[&>div:first-child]:w-[200px] [&>div:first-child]:flex-none">
              <Slider label={label} min={min} max={max} unit={unit} value={look[k]} onChange={(v) => set(k, v)} />
            </Row>
          ),
        )}
      </Group>

      <Group title={compact ? '主题、时间与图标' : '主题与时间'}>
        <Row label="主题" sub="浅色首页尚未实现，暂时只提供深色" stacked>
          <Segmented
            label="主题"
            value={look.theme}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色', disabled: true },
              { value: 'auto', label: '跟随系统', disabled: true },
            ]}
            onChange={(v) => set('theme', v)}
          />
        </Row>
        <Row label="时间格式" stacked>
          <Segmented label="时间格式" value={look.clock} options={[{ value: '24', label: '24 小时' }, { value: '12', label: '12 小时' }]} onChange={(v) => set('clock', v)} />
        </Row>
        <Row label="显示秒" sub="每秒刷新一次数字">
          <Switch label="显示秒" checked={look.showSeconds} onChange={(v) => set('showSeconds', v)} />
        </Row>
        <Row label="显示日期" sub="时钟旁的日期与星期">
          <Switch label="显示日期" checked={look.showDate} onChange={(v) => set('showDate', v)} />
        </Row>
        {compact && (
          <>
            <Row label="图标尺寸" stacked>
              <Segmented label="图标尺寸" value={look.iconSize} options={[{ value: 's', label: '小' }, { value: 'm', label: '中' }, { value: 'l', label: '大' }]} onChange={(v) => set('iconSize', v)} />
            </Row>
            <Row label="动画强度" sub={MOTION_SUB[look.motion]} stacked>
              <Segmented label="动画强度" value={look.motion} options={[{ value: 'full', label: '完整' }, { value: 'reduced', label: '减弱' }, { value: 'off', label: '关闭' }]} onChange={(v) => set('motion', v)} />
            </Row>
          </>
        )}
      </Group>

      {!compact && (
        <Group title="图标与动画">
          <Row label="图标尺寸" sub={`Dock ${{ s: 48, m: 56, l: 64 }[look.iconSize]} px · 手机 ${{ s: 54, m: 60, l: 66 }[look.iconSize]} pt`}>
            <Segmented label="图标尺寸" value={look.iconSize} options={[{ value: 's', label: '小' }, { value: 'm', label: '中' }, { value: 'l', label: '大' }]} onChange={(v) => set('iconSize', v)} />
          </Row>
          <Row label="动画强度" sub={MOTION_SUB[look.motion]}>
            <Segmented label="动画强度" value={look.motion} options={[{ value: 'full', label: '完整' }, { value: 'reduced', label: '减弱' }, { value: 'off', label: '关闭' }]} onChange={(v) => set('motion', v)} />
          </Row>
        </Group>
      )}
    </>
  );

  const applyBar = diff > 0 && (
    <div
      role="region"
      aria-label="未应用的外观更改"
      className={cn('z-8 animate-pop backdrop-blur-[30px]', compact ? 'fixed inset-x-0 bottom-0 flex flex-col gap-2.5 px-4 pt-3' : 'fixed bottom-6 left-[312px] flex h-14 w-[min(640px,calc(100vw-360px))] items-center gap-3 rounded-[18px] pr-2.5 pl-5')}
      style={{ background: compact ? 'rgba(30,28,25,0.9)' : 'rgba(40,38,34,0.94)', boxShadow: compact ? 'inset 0 1px 0 rgba(239,234,225,0.08)' : '0 20px 50px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(230,192,138,0.26)', paddingBottom: compact ? 'max(16px, env(safe-area-inset-bottom))' : undefined }}
    >
      {!compact && <span className="size-[7px] rounded-full bg-amber" />}
      <span className={cn('text-ink', compact ? 'text-[13px] text-ink/66' : 'flex-1 text-[14px]')}>预览中 · {diff} 项更改尚未应用到首页</span>
      <div className={cn('flex gap-2.5', compact && 'w-full')}>
        <Button size={compact ? 'lg' : undefined} className={compact ? 'flex-1' : 'h-[38px] rounded-[11px] px-4 text-[13.5px]'} onClick={resetDraft}>
          还原
        </Button>
        <Button
          size={compact ? 'lg' : undefined}
          variant="primary"
          className={compact ? 'flex-[1.6]' : 'h-[38px] rounded-[11px] px-[18px] text-[13.5px]'}
          onClick={() => draft && patch('look', draft, '外观已应用到首页') && resetDraft()}
        >
          应用到首页
        </Button>
      </div>
    </div>
  );

  const removeDialog = (
    <Dialog
      open={!!removing}
      onOpenChange={(o) => !o && setRemoving(null)}
      title={removing ? `删除壁纸「${removing.name}」？` : ''}
      description={`图片会从 Nexus 服务端删除，无法撤销。${removing && applied.wallpaper === removing.id ? '首页会换回默认壁纸。' : ''}`}
      footer={
        <>
          <Button className="h-10 px-[18px]" onClick={() => setRemoving(null)}>
            取消
          </Button>
          <Button variant="danger-solid" className="h-10 px-5" onClick={() => void removeWall()}>
            删除
          </Button>
        </>
      }
    />
  );

  if (compact) {
    return (
      <>
        <Preview look={look} device="mobile" onFocal={(xy) => setDraft({ ...look, focal: { ...look.focal, mobile: xy } })} />
        {groups}
        {applyBar}
        {removeDialog}
      </>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_456px] items-start gap-10">
      <div className="flex min-w-0 flex-col gap-7">
        <PageHeader title="外观与个性化" sub="右侧预览会立即反映每项调整。确认后点「应用到首页」，在此之前首页保持不变。" />
        {groups}
      </div>
      <aside className="sticky top-0 flex flex-col gap-3.5">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-medium text-ink/70">实时预览</span>
          <span className="flex-1" />
          <Segmented<'desktop' | 'mobile'> size="sm" label="预览设备" value={device} options={[{ value: 'desktop', label: '桌面' }, { value: 'mobile', label: '手机' }]} onChange={setDevice} />
        </div>
        <div className="grid min-h-[360px] place-items-center rounded-[20px] py-4" style={{ background: 'rgba(0,0,0,0.18)' }}>
          <Preview look={look} device={device} onFocal={(xy) => setDraft({ ...look, focal: { ...look.focal, [device]: xy } })} />
        </div>
        <div className="flex justify-between text-[12px] text-ink/46">
          <span>点击画面设置{device === 'desktop' ? '桌面' : '手机'}焦点</span>
          <span>{walls.find((w) => w.id === look.wallpaper)?.name}</span>
        </div>
      </aside>
      {applyBar}
      {removeDialog}
    </div>
  );
}
