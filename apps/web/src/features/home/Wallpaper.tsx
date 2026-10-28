import { BUILTIN_WALLPAPERS, type Settings } from '@nexus/shared';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';

interface Props {
  look: Settings['look'];
  variant: 'desktop' | 'mobile';
  /** Drawer / full-screen panel open: the photo steps back (scale + blur). */
  receded: boolean;
}

const a = (alpha: number) => `rgba(17,16,14,${Math.min(1, alpha).toFixed(3)})`;

export function useWallpaper(look: Settings['look']) {
  return BUILTIN_WALLPAPERS.find((w) => w.id === look.wallpaper) ?? BUILTIN_WALLPAPERS[0]!;
}

/**
 * Warm monochrome treatment from R1.5: sand base → grayscale photo (multiply) → warm black (lighten),
 * then the vignette. The base colour paints first and the photo fades in once decoded.
 */
export function Wallpaper({ look, variant, receded }: Props) {
  const wp = useWallpaper(look);
  const [loaded, setLoaded] = useState<string | null>(null);
  const warm = look.tone === 'warm';
  const k = look.overlay / 48;
  const focal = look.focal[variant];
  const blurPad = look.blur ? -look.blur * 2 : 0;

  useEffect(() => {
    if (wp.kind !== 'photo' || loaded === wp.src) return;
    let alive = true;
    const img = new Image();
    img.src = wp.src;
    img
      .decode()
      .catch(() => undefined)
      .then(() => alive && setLoaded(wp.src));
    return () => {
      alive = false;
    };
  }, [wp, loaded]);

  const vignette =
    variant === 'desktop'
      ? `radial-gradient(ellipse 52% 50% at 50% 50%, ${a(0.5 * k)}, rgba(17,16,14,0) 75%), linear-gradient(180deg, ${a(0.6 * k)} 0%, rgba(17,16,14,0) 20%, rgba(17,16,14,0) 72%, ${a(0.6 * k)} 100%)`
      : `linear-gradient(180deg, ${a(0.62 * k)} 0%, ${a(0.05 * k)} 32%, ${a(0.1 * k)} 50%, ${a(0.6 * k)} 100%)`;

  const recede = variant === 'desktop' ? { t: 'scale(1.04)', f: 'blur(14px) brightness(.85)' } : { t: 'scale(1.05)', f: 'blur(10px) brightness(.7)' };

  return (
    <div
      aria-hidden
      className="absolute inset-0 transition-[transform,filter] duration-420 ease-emph"
      style={{ transform: receded ? recede.t : 'none', filter: receded ? recede.f : 'none' }}
    >
      <div className="absolute" style={{ inset: blurPad, filter: `brightness(${look.brightness}%)${look.blur ? ` blur(${look.blur}px)` : ''}` }}>
        {wp.kind === 'color' ? (
          <div className="absolute inset-0" style={{ background: wp.src }} />
        ) : (
          <div
            className={cn('absolute inset-0 isolate transition-opacity duration-400', loaded === wp.src ? 'opacity-100' : 'opacity-0')}
            style={{ background: warm ? '#a69e8e' : '#1b1a17' }}
          >
            <img
              src={wp.src}
              alt=""
              decoding="async"
              fetchPriority="high"
              className="absolute inset-0 size-full object-cover"
              style={{ objectPosition: `${focal[0]}% ${focal[1]}%`, filter: warm ? 'grayscale(1) contrast(1.08)' : 'none', mixBlendMode: warm ? 'multiply' : 'normal' }}
            />
            {warm && <div className="absolute inset-0" style={{ background: '#221f1b', mixBlendMode: 'lighten' }} />}
          </div>
        )}
      </div>
      <div className="absolute inset-0" style={{ background: vignette }} />
    </div>
  );
}
