import { GALLERY_CATEGORIES, type GalleryCategory, type Settings, type UnsplashPhoto, type UploadedWallpaper } from '@nexus/shared';
import { Check, ImageDown, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { wallpaperSources } from '../../../data/config-store';
import { cn } from '../../../lib/cn';
import { localDay, useSourcesStore } from '../../home/rotation';
import { wallpaperList, type WallpaperEntry } from '../../home/Wallpaper';
import { CreditText } from '../../home/WallpaperBar';
import { Button, Group, Row, Segmented, Spinner, useCompact } from '../ui';

type Look = Settings['look'];
type Rotation = Look['rotation'];
export type SourceTab = 'library' | 'gallery' | 'daily' | 'unsplash' | 'url';

const TABS: { id: SourceTab; label: string }[] = [
  { id: 'library', label: '我的壁纸' },
  { id: 'gallery', label: '精选图库' },
  { id: 'daily', label: '每日一图' },
  { id: 'unsplash', label: 'Unsplash' },
  { id: 'url', label: '网址导入' },
];

const entryOf = (w: UploadedWallpaper): WallpaperEntry => wallpaperList([w]).at(-1)!;
const message = (e: unknown) => (e instanceof Error ? e.message : '操作失败');
const chip = (on: boolean) => cn('flex h-[34px] flex-none items-center rounded-full border-0 px-[13px] text-[13px] whitespace-nowrap transition-colors duration-140', on ? 'bg-ink/14 text-ink' : 'bg-ink/5 text-ink/66 hover:text-ink');

function Card({ img, title, sub, busy, done, onClick }: { img: ReactNode; title: string; sub?: ReactNode; busy?: boolean; done?: boolean; onClick(): void }) {
  const compact = useCompact();
  return (
    <div className={cn('flex flex-col gap-1.5', compact && 'w-[132px] flex-none snap-start')}>
      <button type="button" onClick={onClick} disabled={busy} aria-label={title} className="relative aspect-[16/10] overflow-hidden rounded-xl border-0 bg-ink/6 p-0 disabled:cursor-wait">
        {img}
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-black/45">
            <Spinner />
          </span>
        )}
        {done && !busy && (
          <span className="absolute right-1.5 bottom-1.5 grid size-5 place-items-center rounded-full bg-ink/80" title="已在我的壁纸中">
            <Check className="size-3 text-base" strokeWidth={3} />
          </span>
        )}
      </button>
      <span className="truncate text-[12.5px] text-ink/72">{title}</span>
      {sub && <span className="-mt-1 truncate text-[11.5px] text-ink/44">{sub}</span>}
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  const compact = useCompact();
  return <div className={compact ? 'nx-scroll-hidden flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pb-1' : 'grid grid-cols-4 gap-3.5'}>{children}</div>;
}

/** 精选图库: previews come through Nexus; a click downloads the full picture once, then picks it. */
function GalleryTab({ onPick, onError }: { onPick(e: WallpaperEntry): void; onError(m: string): void }) {
  const { data, loading, error, load } = useSourcesStore();
  const [cat, setCat] = useState<GalleryCategory | 'all'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => void load(), [load]);
  const items = (data?.gallery ?? []).filter((g) => cat === 'all' || g.category === cat);
  const choose = async (id: string) => {
    setBusy(id);
    try {
      onPick(entryOf(await wallpaperSources.gallery(id)));
      void load(true);
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(null);
    }
  };
  if (error) return <p className="m-0 text-[13px] text-ink/56">{error}</p>;
  if (!data) return loading ? <Spinner /> : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="nx-scroll-hidden flex gap-2 overflow-x-auto">
        <button type="button" aria-pressed={cat === 'all'} onClick={() => setCat('all')} className={chip(cat === 'all')}>
          全部
        </button>
        {(Object.keys(GALLERY_CATEGORIES) as GalleryCategory[]).map((c) => (
          <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={chip(cat === c)}>
            {GALLERY_CATEGORIES[c]}
          </button>
        ))}
      </div>
      <Grid>
        {items.map((g) => (
          <Card
            key={g.id}
            title={g.title}
            busy={busy === g.id}
            done={!!g.wallpaperId}
            onClick={() => void choose(g.id)}
            img={<img src={`/api/gallery/${encodeURIComponent(g.id)}/preview`} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />}
          />
        ))}
      </Grid>
      <p className="m-0 text-[12px] leading-[1.6] text-ink/44">图片来自 Wikimedia Commons，均为允许自由使用的许可（CC0、公有领域、CC BY / BY-SA）。第一次选用时由 Nexus 服务器下载并保存，之后不再重复下载；需要署名的图片会在首页显示作者与许可。</p>
    </div>
  );
}

/** 每日一图: Wikimedia Commons' Picture of the Day, used as the rotation mode `potd`. */
function DailyTab({ look, onRotation, onError }: { look: Look; onRotation(r: Partial<Rotation>): void; onError(m: string): void }) {
  const [today, setToday] = useState<WallpaperEntry | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    wallpaperSources.daily(localDay(new Date())).then(
      (w) => live && setToday(entryOf(w)),
      (e) => live && onError(message(e)),
    ).finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const on = look.rotation.mode === 'potd';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-4">
        <div className="relative aspect-[16/10] w-[220px] flex-none overflow-hidden rounded-xl bg-ink/6">
          {today?.uploaded && <img src={today.src} alt="" className="absolute inset-0 size-full object-cover" />}
          {busy && (
            <span className="absolute inset-0 grid place-items-center">
              <Spinner />
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-[1.6] text-ink/66">
          <span>每天自动换成 Wikimedia Commons 的「每日图片」；遇到竖幅图片时，使用最近一张横幅图片。</span>
          {today && (
            <span className="truncate text-[12px] text-ink/50">
              今天：<CreditText info={today.info} />
            </span>
          )}
          <Button variant={on ? undefined : 'primary'} className="h-9 w-fit px-4" disabled={on} onClick={() => onRotation({ mode: 'potd' })}>
            {on ? '已在使用每日一图' : '使用每日一图'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Unsplash: searched through Nexus (the key stays on the server); thumbnails are hotlinked. */
function UnsplashTab({ enabled, onPick, onError }: { enabled: boolean; onPick(e: WallpaperEntry): void; onError(m: string): void }) {
  const [q, setQ] = useState('');
  const [photos, setPhotos] = useState<UnsplashPhoto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (query: string) => {
    setLoading(true);
    try {
      setPhotos(await wallpaperSources.unsplash(query));
    } catch (e) {
      onError(message(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (enabled) void run('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  if (!enabled)
    return (
      <p className="m-0 text-[13px] leading-[1.7] text-ink/60">
        Unsplash 需要你自己申请的 Access Key：在 unsplash.com/developers 创建应用后，把 Key 填入部署环境变量 <code className="font-mono text-[12px]">NEXUS_UNSPLASH_ACCESS_KEY</code> 并重启 Nexus。Key 只保存在服务器上。按 Unsplash 的规定，图片会由浏览器直接从 Unsplash 加载。
      </p>
    );
  const choose = async (id: string) => {
    setBusy(id);
    try {
      onPick(entryOf(await wallpaperSources.useUnsplash(id)));
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <div className="flex h-9 flex-1 items-center gap-2 rounded-[11px] bg-ink/6 px-3">
          <Search className="size-3.5 text-ink/50" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键词，如 mountain、city night；留空为壁纸精选" aria-label="搜索 Unsplash" className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-ink caret-amber outline-none" />
        </div>
        <Button type="submit" className="h-9 px-4">
          {loading ? <Spinner /> : '搜索'}
        </Button>
      </form>
      <Grid>
        {(photos ?? []).map((p) => (
          <Card
            key={p.id}
            title={p.description || 'Unsplash 照片'}
            sub={`摄影：${p.author}`}
            busy={busy === p.id}
            onClick={() => void choose(p.id)}
            img={<img src={p.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" style={{ background: p.color }} />}
          />
        ))}
      </Grid>
      {photos && !photos.length && !loading && <p className="m-0 text-[13px] text-ink/50">没有找到合适的横幅照片，换个关键词试试。</p>}
    </div>
  );
}

/** 网址导入: downloaded once by the server (public addresses, ≤ 15 MB), then a normal library picture. */
function UrlTab({ onPick, onError }: { onPick(e: WallpaperEntry): void; onError(m: string): void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      onPick(entryOf(await wallpaperSources.import(url.trim())));
      setUrl('');
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2.5">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="url"
          inputMode="url"
          placeholder="https://example.com/photo.jpg"
          aria-label="图片地址"
          className="box-border h-10 min-w-0 flex-1 rounded-[11px] border-0 bg-ink/6 px-3 font-mono text-[13px] text-ink caret-amber outline-none"
          style={{ fontSize: 16 }}
        />
        <Button variant="primary" type="submit" className="h-10 px-4" disabled={busy || !url.trim()}>
          {busy ? <Spinner /> : <ImageDown className="size-4" />}
          导入
        </Button>
      </form>
      <p className="m-0 text-[12px] leading-[1.6] text-ink/44">Nexus 服务器会下载这张图片、重新编码后保存到「我的壁纸」，之后不再访问原地址。只支持公网地址（不能是内网或本机），JPG / PNG / WebP / AVIF，≤ 15 MB。请只导入你有权使用的图片。</p>
    </div>
  );
}

/** 背景来源 tabs above the wallpaper grid. */
export function SourcePicker({ look, library, onPick, onRotation, onError }: { look: Look; library: ReactNode; onPick(e: WallpaperEntry): void; onRotation(r: Partial<Rotation>): void; onError(m: string): void }) {
  const compact = useCompact();
  const [tab, setTab] = useState<SourceTab>('library');
  const unsplash = useSourcesStore((s) => s.data?.unsplash ?? false);
  const load = useSourcesStore((s) => s.load);
  useEffect(() => void load(), [load]);
  return (
    <div className={cn('flex flex-col gap-3.5', compact ? 'py-3' : 'p-5')}>
      <div role="tablist" aria-label="背景来源" className={cn('nx-scroll-hidden flex gap-2 overflow-x-auto', compact && 'px-3')}>
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={chip(tab === t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} className={cn(compact && tab !== 'library' && tab !== 'gallery' && 'px-3')}>
        {tab === 'library' && library}
        {tab === 'gallery' && <GalleryTab onPick={onPick} onError={onError} />}
        {tab === 'daily' && <DailyTab look={look} onRotation={onRotation} onError={onError} />}
        {tab === 'unsplash' && <UnsplashTab enabled={unsplash} onPick={onPick} onError={onError} />}
        {tab === 'url' && <UrlTab onPick={onPick} onError={onError} />}
      </div>
    </div>
  );
}

const MODE_OPTIONS: { value: Rotation['mode']; label: string }[] = [
  { value: 'off', label: '不自动切换' },
  { value: 'open', label: '每次打开首页' },
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'interval', label: '按设定间隔' },
  { value: 'potd', label: '每日一图（Wikimedia）' },
];

const MODE_SUB: Record<Rotation['mode'], string> = {
  off: '一直显示上面选中的壁纸',
  open: '每次打开或刷新首页时换一张',
  hourly: '整点换一张；同一时段所有设备显示同一张',
  daily: '每天换一张；同一天所有设备显示同一张',
  interval: '按设定的间隔换一张',
  potd: '每天使用 Wikimedia Commons 的每日图片',
};

const selectClass = 'box-border h-10 cursor-pointer rounded-xl border-0 bg-ink/6 pr-8 pl-3.5 text-[14px] text-ink outline-none';

/** 自动切换: how and from where the home page changes its picture. */
export function RotationGroup({ look, set }: { look: Look; set(r: Partial<Rotation>, extra?: Partial<Look>): void }) {
  const compact = useCompact();
  const r = look.rotation;
  const timed = r.mode !== 'off' && r.mode !== 'potd';
  const favorites = look.favorites.length;
  const toggleCat = (c: GalleryCategory) => {
    const has = r.categories.includes(c);
    if (has && r.categories.length === 1) return;
    set({ categories: has ? r.categories.filter((x) => x !== c) : [...r.categories, c] });
  };
  return (
    <Group title="自动切换">
      <Row label="切换方式" sub={MODE_SUB[r.mode]} stacked={compact}>
        <select aria-label="壁纸切换方式" value={r.mode} onChange={(e) => set({ mode: e.target.value as Rotation['mode'] })} className={selectClass} style={{ fontSize: compact ? 16 : undefined }}>
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      {r.mode === 'interval' && (
        <Row label="间隔" stacked={compact}>
          <select aria-label="切换间隔" value={r.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })} className={selectClass} style={{ fontSize: compact ? 16 : undefined }}>
            {[15, 30, 60, 120, 360, 720].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
              </option>
            ))}
          </select>
        </Row>
      )}
      {timed && (
        <Row label="切换范围" sub={r.pool === 'favorites' && !favorites ? '还没有收藏的壁纸，暂时从「我的壁纸」中选择' : r.pool === 'gallery' ? '轮到的图片由服务器下载一次，之后直接使用' : undefined} stacked>
          <Segmented
            label="切换范围"
            value={r.pool}
            options={[
              { value: 'library', label: '我的壁纸' },
              { value: 'favorites', label: `收藏${favorites ? ` ${favorites}` : ''}` },
              { value: 'gallery', label: '精选图库' },
            ]}
            onChange={(pool) => set({ pool })}
          />
        </Row>
      )}
      {timed && r.pool === 'gallery' && (
        <Row label="图库分类" stacked>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(GALLERY_CATEGORIES) as GalleryCategory[]).map((c) => (
              <button key={c} type="button" aria-pressed={r.categories.includes(c)} onClick={() => toggleCat(c)} className={chip(r.categories.includes(c))}>
                {GALLERY_CATEGORIES[c]}
              </button>
            ))}
          </div>
        </Row>
      )}
      {look.blocked.length > 0 && (
        <Row label="不喜欢的壁纸" sub={`${look.blocked.length} 张不会再出现在自动切换中`}>
          <Button size="sm" onClick={() => set({}, { blocked: [] })}>
            全部恢复
          </Button>
        </Row>
      )}
    </Group>
  );
}

