import { hostOf, TONES, type AppEntry, type Engine, type StatusLevel } from '@nexus/shared';
import type { LucideIcon } from 'lucide-react';
import { memo, useState, type CSSProperties } from 'react';
import { cn } from '../lib/cn';
import { ALL_APPS_GLYPH, BUILTIN_GLYPHS, faviconUrl, libraryIconUrl } from './glyphs';

/** Three materials, one geometry (R1 Spec): porcelain = external site, ember = self-hosted, glass = system. */
const PORCELAIN: CSSProperties = {
  background: 'linear-gradient(180deg,#f7f3ec 0%,#e6e0d5 100%)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.75), inset 0 -1px 0 rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.2), 0 8px 18px -6px rgba(0,0,0,0.45)',
};
const EMBER_SHADOW = 'inset 0 1px 0 rgba(255,255,255,0.1), inset 0 0 0 1px rgba(255,255,255,0.045), 0 1px 1px rgba(0,0,0,0.25), 0 8px 18px -6px rgba(0,0,0,0.5)';
const GLASS: CSSProperties = { background: 'rgba(239,234,225,0.1)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(239,234,225,0.08)' };
const SYSTEM: CSSProperties = { background: 'rgba(239,234,225,0.08)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.06)' };

const ember = (tone: number): CSSProperties => {
  const t = TONES[tone % TONES.length]!;
  return { background: `linear-gradient(180deg,${t[0]} 0%,${t[1]} 100%)`, boxShadow: EMBER_SHADOW };
};

export type TileTarget =
  | { kind: 'app'; app: AppEntry }
  | { kind: 'engine'; engine: Engine }
  | { kind: 'all' }
  | { kind: 'bookmark' }
  | { kind: 'system'; icon: LucideIcon };

interface Resolved {
  surface: CSSProperties;
  src: string | null;
  scale: number;
  letter: string;
  icon?: LucideIcon;
}

function resolve(t: TileTarget): Resolved {
  switch (t.kind) {
    case 'all':
      return { surface: GLASS, src: ALL_APPS_GLYPH, scale: 0.46, letter: '' };
    case 'bookmark':
      return { surface: ember(2), src: BUILTIN_GLYPHS.linkwarden!, scale: 0.64, letter: '' };
    case 'system':
      return { surface: SYSTEM, src: null, scale: 0.5, letter: '', icon: t.icon };
    case 'engine': {
      const e = t.engine;
      if (e.kind === 'linkwarden') return { surface: ember(2), src: BUILTIN_GLYPHS.linkwarden!, scale: 0.64, letter: '' };
      const src = e.icon ? libraryIconUrl(e.icon) : faviconUrl(hostOf(e.urlTemplate.replace('%s', '')));
      return { surface: PORCELAIN, src, scale: 0.54, letter: e.name.slice(0, 1) };
    }
    case 'app': {
      const a = t.app;
      const letter = (a.icon.letter || a.name).slice(0, 2);
      const svc = a.kind === 'service';
      const surface = svc ? ember(a.icon.tone) : PORCELAIN;
      switch (a.icon.source) {
        case 'builtin': {
          const glyph = BUILTIN_GLYPHS[a.icon.ref];
          return glyph ? { surface: ember(a.icon.tone), src: glyph, scale: 0.64, letter } : { surface: ember(a.icon.tone), src: null, scale: 0, letter };
        }
        case 'letter':
          return { surface: ember(a.icon.tone), src: null, scale: 0, letter };
        case 'library':
          return { surface, src: a.icon.ref ? libraryIconUrl(a.icon.ref) : null, scale: svc ? 0.58 : 0.54, letter };
        case 'upload':
          return { surface, src: a.icon.ref || null, scale: svc ? 0.58 : 0.54, letter };
        case 'auto':
          return { surface, src: faviconUrl(hostOf(a.url)), scale: svc ? 0.58 : 0.54, letter };
      }
    }
  }
}

/** Remembers icons that failed so re-renders do not flash a broken image before the letter. */
const failed = new Set<string>();

const BADGE: Partial<Record<StatusLevel, string>> = { warn: '#e3a35b', error: '#e9765f' };

interface Props {
  target: TileTarget;
  size: number;
  /** Only 警告 / 异常 draw a corner badge (R1.5 五态). */
  status?: StatusLevel;
  lazy?: boolean;
  className?: string;
  style?: CSSProperties;
}

export const AppTile = memo(function AppTile({ target, size, status, lazy, className, style }: Props) {
  const r = resolve(target);
  const [, bump] = useState(0);
  const src = r.src && !failed.has(r.src) ? r.src : null;
  const Icon = r.icon;
  const badge = status ? BADGE[status] : undefined;
  const radius = Math.round(size * 0.285);
  return (
    <span
      aria-hidden
      className={cn('relative block flex-none', className)}
      style={{ width: size, height: size, borderRadius: radius, ...r.surface, ...style }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          loading={lazy ? 'lazy' : 'eager'}
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 object-contain select-none"
          style={{ width: `${r.scale * 100}%`, height: `${r.scale * 100}%` }}
          onError={() => {
            failed.add(src);
            bump((n) => n + 1);
          }}
        />
      ) : Icon ? (
        <Icon className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-ink/82" style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2} />
      ) : r.letter ? (
        <span
          className="absolute inset-0 grid place-items-center font-semibold"
          style={{ fontSize: Math.round(size * 0.38), color: target.kind === 'app' && target.app.kind === 'site' && target.app.icon.source !== 'letter' ? '#3a352e' : '#efeae1' }}
        >
          {r.letter}
        </span>
      ) : null}
      {badge && (
        <span
          className="absolute rounded-full"
          style={{ top: -3, right: -3, width: size >= 56 ? 12 : 9, height: size >= 56 ? 12 : 9, background: badge, boxShadow: '0 0 0 2.5px #2b2925' }}
        />
      )}
    </span>
  );
});
