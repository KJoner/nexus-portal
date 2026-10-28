import { BUILTIN_WALLPAPERS, wallpaperFile, type Settings, type UploadedWallpaper, type Wallpaper as BuiltinWallpaper } from '@nexus/shared';
import { useState } from 'react';
import { useConfigStore } from '../../data/config-store';
import { cn } from '../../lib/cn';

export interface WallpaperEntry extends BuiltinWallpaper {
  uploaded?: UploadedWallpaper;
}

export function wallpaperList(uploads: readonly UploadedWallpaper[]): WallpaperEntry[] {
  return [...BUILTIN_WALLPAPERS, ...uploads.map((u): WallpaperEntry => ({ id: u.id, name: u.name, kind: 'photo', src: wallpaperFile(u.id, u.widths.at(-1)!, 'jpg'), uploaded: u }))];
}

export function useWallpapers(): WallpaperEntry[] {
  const uploads = useConfigStore((s) => s.wallpapers);
  return wallpaperList(uploads);
}

export function useWallpaper(look: Settings['look']): WallpaperEntry {
  const list = useWallpapers();
  return list.find((w) => w.id === look.wallpaper) ?? list[0]!;
}

interface Props {
  look: Settings['look'];
  variant: 'desktop' | 'mobile';
  /** Drawer / full-screen panel open: the photo steps back (scale + blur). */
  receded: boolean;
  /** Settings preview: renders inside its container instead of the viewport. */
  className?: string;
}

const a = (alpha: number) => `rgba(17,16,14,${Math.min(1, alpha).toFixed(3)})`;
const srcset = (u: UploadedWallpaper, ext: 'avif' | 'webp' | 'jpg') => u.widths.map((w) => `${wallpaperFile(u.id, w, ext)} ${w}w`).join(', ');

/**
 * Warm monochrome treatment from R1.5: sand base → grayscale photo (multiply) → warm black (lighten),
 * then the vignette. The base colour (or the inline blurred thumbnail of an upload) paints first;
 * the photo fades in once decoded (R1.5 · 壁纸加载).
 */
export function Wallpaper({ look, variant, receded, className }: Props) {
  const wp = useWallpaper(look);
  const [loaded, setLoaded] = useState<string | null>(null);
  const warm = look.tone === 'warm';
  const k = look.overlay / 48;
  const focal = look.focal[variant];
  const blurPad = look.blur ? -look.blur * 2 : 0;
  const ready = loaded === wp.id;

  const vignette =
    variant === 'desktop'
      ? `radial-gradient(ellipse 52% 50% at 50% 50%, ${a(0.5 * k)}, rgba(17,16,14,0) 75%), linear-gradient(180deg, ${a(0.6 * k)} 0%, rgba(17,16,14,0) 20%, rgba(17,16,14,0) 72%, ${a(0.6 * k)} 100%)`
      : `linear-gradient(180deg, ${a(0.62 * k)} 0%, ${a(0.05 * k)} 32%, ${a(0.1 * k)} 50%, ${a(0.6 * k)} 100%)`;
  const recede = variant === 'desktop' ? { t: 'scale(1.04)', f: 'blur(14px) brightness(.85)' } : { t: 'scale(1.05)', f: 'blur(10px) brightness(.7)' };
  const photoStyle = { objectPosition: `${focal[0]}% ${focal[1]}%`, filter: warm ? 'grayscale(1) contrast(1.08)' : 'none', mixBlendMode: warm ? 'multiply' : 'normal' } as const;
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const id = wp.id;
    void e.currentTarget
      .decode()
      .catch(() => undefined)
      .then(() => setLoaded(id));
  };

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
            {wp.uploaded && (
              <img src={wp.uploaded.placeholder} alt="" className="absolute inset-0 size-full scale-110 object-cover blur-xl" style={{ objectPosition: photoStyle.objectPosition, filter: `blur(24px)${warm ? ' grayscale(1) brightness(.7)' : ''}` }} />
            )}
            <div key={wp.id} className={cn('absolute inset-0 isolate transition-opacity duration-400', ready ? 'opacity-100' : 'opacity-0')} style={{ background: warm ? '#a69e8e' : '#1b1a17' }}>
              {wp.uploaded ? (
                <picture>
                  <source type="image/avif" srcSet={srcset(wp.uploaded, 'avif')} sizes="100vw" />
                  <source type="image/webp" srcSet={srcset(wp.uploaded, 'webp')} sizes="100vw" />
                  <img src={wp.src} srcSet={srcset(wp.uploaded, 'jpg')} sizes="100vw" alt="" decoding="async" fetchPriority="high" onLoad={onLoad} className="absolute inset-0 size-full object-cover" style={photoStyle} />
                </picture>
              ) : (
                <img src={wp.src} alt="" decoding="async" fetchPriority="high" onLoad={onLoad} className="absolute inset-0 size-full object-cover" style={photoStyle} />
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
