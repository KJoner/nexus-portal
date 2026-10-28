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
      return { background: 'rgba(233,118,95,0.2)', color: '#f6b3a4', boxShadow: 'inset 0 0 0 1px rgba(233,118,95,0.36)' };
    case 'warn':
      return { background: 'rgba(227,163,91,0.17)', color: '#f1c690', boxShadow: 'inset 0 0 0 1px rgba(227,163,91,0.3)' };
    case 'unknown':
      return { background: 'rgba(26,25,22,0.4)', color: 'rgba(239,234,225,0.8)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.16)' };
    default:
      return { background: 'rgba(26,25,22,0.34)', color: 'rgba(239,234,225,0.74)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.06)' };
  }
}

/** Status dot; 未监测 is a hollow ring and never coloured. */
export function dotStyle(level: StatusLevel, ringAlpha = 0.38): CSSProperties {
  return level === 'off' ? { background: 'transparent', boxShadow: `inset 0 0 0 1.5px rgba(239,234,225,${ringAlpha})` } : { background: LEVEL_COLOR[level] };
}

export function messageColor(level: StatusLevel): string {
  return level === 'ok' ? 'rgba(239,234,225,0.58)' : level === 'unknown' ? 'rgba(239,234,225,0.66)' : level === 'off' ? 'rgba(239,234,225,0.44)' : LEVEL_COLOR[level];
}

export function actionStyle(level: StatusLevel): CSSProperties {
  if (level === 'warn') return { background: 'rgba(227,163,91,0.2)', color: LEVEL_COLOR.warn };
  if (level === 'error') return { background: 'rgba(233,118,95,0.22)', color: LEVEL_COLOR.error };
  if (level === 'unknown') return { background: 'rgba(239,234,225,0.1)', color: '#efeae1' };
  return { background: 'rgba(239,234,225,0.06)', color: 'rgba(239,234,225,0.78)' };
}

export const rowHighlighted = (level: StatusLevel) => level !== 'ok' && level !== 'off';
