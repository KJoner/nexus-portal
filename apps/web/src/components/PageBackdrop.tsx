import { useConfig } from '../data/config-store';
import { useDailyEntry } from '../features/home/rotation';
import { useWallpaper } from '../features/home/Wallpaper';

/**
 * The home wallpaper pushed back to atmosphere: blur 48, brightness 42 %, 62 % warm black (R2).
 * Shared by the full-page views (设置, 我的收藏) so they read as one family. Light theme: a paper veil.
 */
export function PageBackdrop() {
  const look = useConfig().settings.look;
  const fixed = useWallpaper(look);
  const wp = useDailyEntry(look.rotation.mode === 'potd') ?? fixed;
  return (
    <>
      <div aria-hidden className="absolute -inset-[60px] isolate" style={{ background: wp.kind === 'photo' ? '#a69e8e' : 'var(--color-base)', filter: 'blur(48px) brightness(.42)' }}>
        {wp.kind === 'photo' ? <img src={wp.uploaded?.placeholder ?? wp.src} alt="" loading="lazy" className="absolute inset-0 size-full object-cover grayscale" style={{ mixBlendMode: 'multiply' }} /> : <div className="absolute inset-0" style={{ background: wp.src }} />}
        {wp.kind === 'photo' && <div className="absolute inset-0" style={{ background: '#221f1b', mixBlendMode: 'lighten' }} />}
      </div>
      <div aria-hidden className="absolute inset-0" style={{ background: 'rgb(var(--nx-page-rgb)/var(--nx-page-veil))' }} />
    </>
  );
}
