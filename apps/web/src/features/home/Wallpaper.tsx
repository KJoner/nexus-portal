import { BUILTIN_WALLPAPERS, wallpaperFile, type Settings, type UploadedWallpaper, type Wallpaper as BuiltinWallpaper, type WallpaperCredit } from '@nexus/shared';
import { useState } from 'react';
import { useConfigStore } from '../../data/config-store';
import { cn } from '../../lib/cn';

export interface WallpaperEntry extends BuiltinWallpaper {
  uploaded?: UploadedWallpaper;
  /** Structured attribution (library entries from public sources). */
  info?: WallpaperCredit | null;
}

/** Unsplash images are hotlinked; size parameters keep `ixid` and the rest of the original query. */
export const remoteSrc = (raw: string, w: number) => `${raw}${raw.includes('?') ? '&' : '?'}w=${w}&q=78&fit=crop&auto=format`;

export function wallpaperList(uploads: readonly UploadedWallpaper[]): WallpaperEntry[] {
  return [
    ...BUILTIN_WALLPAPERS,
    ...uploads.map(
      (u): WallpaperEntry => ({
        id: u.id,
        name: u.name,
        kind: 'photo',
        src: u.remote ? remoteSrc(u.remote, 2560) : wallpaperFile(u.id, u.widths.at(-1)!, 'jpg'),
        uploaded: u,
        info: u.credit,
        focal: u.focal ?? undefined,
        luma: u.luma ?? undefined,
      }),
    ),
  ];
}

export function useWallpapers(): WallpaperEntry[] {
  const uploads = useConfigStore((s) => s.wallpapers);
  return wallpaperList(uploads);
}

export function useWallpaper(look: Settings['look']): WallpaperEntry {
  const list = useWallpapers();
  return list.find((w) => w.id === look.wallpaper) ?? list[0]!;
}

/** srcset of a library entry in one format, or of a hotlinked photo. */
export function wallpaperSrcset(u: UploadedWallpaper, ext: 'avif' | 'webp' | 'jpg'): string {
  if (u.remote) return [1280, 1920, 2560].map((w) => `${remoteSrc(u.remote!, w)} ${w}w`).join(', ');
  return u.widths.map((w) => `${wallpaperFile(u.id, w, ext)} ${w}w`).join(', ');
}

interface Props {
  look: Settings['look'];
  variant: 'desktop' | 'mobile';
  /** Drawer / full-screen panel open: the photo steps back (scale + blur). */
  receded: boolean;
  /** The picture to show when it is not `look.wallpaper` (rotation, 每日一图). */
  entry?: WallpaperEntry;
  /** Settings preview: renders inside its container instead of the viewport. */
  className?: string;
}

const a = (alpha: number) => `rgba(17,16,14,${Math.min(1, alpha).toFixed(3)})`;

/**
 * Warm monochrome treatment from R1.5: sand base → grayscale photo (multiply) → warm black (lighten),
 * then the vignette. The base colour (or the inline blurred thumbnail of an upload) paints first;
 * the photo fades in once decoded (R1.5 · 壁纸加载). A picture that fails to load falls back to the
 * built-in one, so a dead source never leaves a blank home page.
 */
export function Wallpaper({ look, variant, receded, entry, className }: Props) {
  const fixed = useWallpaper(look);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const chosen = entry ?? fixed;
  const wp = failed.has(chosen.id) ? BUILTIN_WALLPAPERS[0]! : chosen;
  const [loaded, setLoaded] = useState<string | null>(null);
  const warm = look.tone === 'warm';
  const focal = wp.id === look.wallpaper ? look.focal[variant] : (wp.focal ?? [50, 50]);
  const blurPad = look.blur ? -look.blur * 2 : 0;
  const ready = loaded === wp.id;
  const u = 'uploaded' in wp ? (wp as WallpaperEntry).uploaded : undefined;

  // Bright photos get a slightly stronger veil behind the clock and search (readability).
  const luma = wp.kind === 'photo' ? (wp.luma ?? 0.45) * (look.brightness / 100) * (warm ? 0.85 : 1) : 0;
  const lift = Math.max(0, Math.min(0.28, (luma - 0.5) * 0.8));
  const k = look.overlay / 48;
  const vignette =
    variant === 'desktop'
      ? `radial-gradient(ellipse 52% 50% at 50% 50%, ${a(0.5 * k + lift)}, rgba(17,16,14,${(lift * 0.4).toFixed(3)}) 75%), linear-gradient(180deg, ${a(0.6 * k)} 0%, rgba(17,16,14,0) 20%, rgba(17,16,14,0) 72%, ${a(0.6 * k)} 100%)`
      : `linear-gradient(180deg, ${a(0.62 * k + lift)} 0%, ${a(0.05 * k + lift * 0.5)} 32%, ${a(0.1 * k + lift * 0.5)} 50%, ${a(0.6 * k + lift)} 100%)`;
  const recede = variant === 'desktop' ? { t: 'scale(1.04)', f: 'blur(14px) brightness(.85)' } : { t: 'scale(1.05)', f: 'blur(10px) brightness(.7)' };
  const photoStyle = { objectPosition: `${focal[0]}% ${focal[1]}%`, filter: warm ? 'grayscale(1) contrast(1.08)' : 'none', mixBlendMode: warm ? 'multiply' : 'normal' } as const;
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const id = wp.id;
    void e.currentTarget
      .decode()
      .catch(() => undefined)
      .then(() => setLoaded(id));
  };
  const onError = () => setFailed((f) => new Set(f).add(wp.id));

  return (
    <div
      aria-hidden
      className={cn('absolute inset-0 overflow-hidden transition-[transform,filter] duration-420 ease-emph', className)}
      style={{ transform: receded ? recede.t : 'none', filter: receded ? recede.f : 'none' }}
    >
      <div className="absolute" style={{ inset: blurPad, filter: `brightness(${look.brightness}%)${look.blur ? ` blur(${look.blur}px)` : ''}` }}>
        {wp.kind === 'color' ? (
          <div className="absolute inset-0" style={{ background: wp.src }} />
        ) : (
          <>
            {u && (
              <img src={u.placeholder} alt="" className="absolute inset-0 size-full scale-110 object-cover blur-xl" style={{ objectPosition: photoStyle.objectPosition, filter: `blur(24px)${warm ? ' grayscale(1) brightness(.7)' : ''}` }} />
            )}
            <div key={wp.id} className={cn('absolute inset-0 isolate transition-opacity duration-400', ready ? 'opacity-100' : 'opacity-0')} style={{ background: warm ? '#a69e8e' : '#1b1a17' }}>
              {u && !u.remote ? (
                <picture>
                  <source type="image/avif" srcSet={wallpaperSrcset(u, 'avif')} sizes="100vw" />
                  <source type="image/webp" srcSet={wallpaperSrcset(u, 'webp')} sizes="100vw" />
                  <img src={wp.src} srcSet={wallpaperSrcset(u, 'jpg')} sizes="100vw" alt="" decoding="async" fetchPriority="high" onLoad={onLoad} onError={onError} className="absolute inset-0 size-full object-cover" style={photoStyle} />
                </picture>
              ) : u?.remote ? (
                <img src={wp.src} srcSet={wallpaperSrcset(u, 'jpg')} sizes="100vw" alt="" decoding="async" fetchPriority="high" referrerPolicy="no-referrer" onLoad={onLoad} onError={onError} className="absolute inset-0 size-full object-cover" style={photoStyle} />
              ) : (
                <img src={wp.src} alt="" decoding="async" fetchPriority="high" onLoad={onLoad} onError={onError} className="absolute inset-0 size-full object-cover" style={photoStyle} />
              )}
              {warm && <div className="absolute inset-0" style={{ background: '#221f1b', mixBlendMode: 'lighten' }} />}
            </div>
          </>
        )}
      </div>
      <div className="absolute inset-0" style={{ background: vignette }} />
    </div>
  );
}
