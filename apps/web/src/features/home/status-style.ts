import type { StatusLevel } from '@nexus/shared';
import type { CSSProperties } from 'react';

export const LEVEL_COLOR: Record<StatusLevel, string> = {
  ok: '#a7bf9f',
  warn: '#e3a35b',
  error: '#e9765f',
  unknown: '#9a948a',
  off: 'transparent',
};

export function pillStyle(level: StatusLevel): CSSProperties {
  switch (level) {
    case 'error':
      return { background: 'rgb(var(--nx-error-rgb)/0.2)', color: '#f6b3a4', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-error-rgb)/0.36)' };
    case 'warn':
      return { background: 'rgba(227,163,91,0.17)', color: 'var(--nx-warn-ink)', boxShadow: 'inset 0 0 0 1px rgba(227,163,91,0.3)' };
    case 'unknown':
      return { background: 'rgb(var(--nx-s1-rgb)/0.4)', color: 'rgb(var(--nx-ink-rgb)/0.8)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.16)' };
    default:
      return { background: 'rgb(var(--nx-s1-rgb)/0.34)', color: 'rgb(var(--nx-ink-rgb)/0.74)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.06)' };
  }
}

/** Status dot; 未监测 is a hollow ring and never coloured. */
export function dotStyle(level: StatusLevel, ringAlpha = 0.38): CSSProperties {
  return level === 'off' ? { background: 'transparent', boxShadow: `inset 0 0 0 1.5px rgba(239,234,225,${ringAlpha})` } : { background: LEVEL_COLOR[level] };
}

export function messageColor(level: StatusLevel): string {
  return level === 'ok' ? 'rgb(var(--nx-ink-rgb)/0.58)' : level === 'unknown' ? 'rgb(var(--nx-ink-rgb)/0.66)' : level === 'off' ? 'rgb(var(--nx-ink-rgb)/0.44)' : LEVEL_COLOR[level];
}

export function actionStyle(level: StatusLevel): CSSProperties {
  if (level === 'warn') return { background: 'rgba(227,163,91,0.2)', color: LEVEL_COLOR.warn };
  if (level === 'error') return { background: 'rgb(var(--nx-error-rgb)/0.22)', color: LEVEL_COLOR.error };
  if (level === 'unknown') return { background: 'rgb(var(--nx-ink-rgb)/0.1)', color: 'var(--color-ink)' };
  return { background: 'rgb(var(--nx-ink-rgb)/0.06)', color: 'rgb(var(--nx-ink-rgb)/0.78)' };
}

export const rowHighlighted = (level: StatusLevel) => level !== 'ok' && level !== 'off';
