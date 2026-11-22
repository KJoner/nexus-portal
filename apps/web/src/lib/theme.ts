import { useEffect, useState } from 'react';
import { useConfigStore } from '../data/config-store';
import { storage } from './storage';

/**
 * 深色 / 浅色 / 跟随系统 (UI v2 · v12.0.3). The choice is `settings.look.theme` of the collection on
 * screen (so it follows the account or this browser's local collection); it is written to
 * `<html data-theme>`, which switches the colour tokens in styles/index.css. The last applied value is
 * remembered in this browser only to paint the first frame in the right colours before the
 * collection has been read (no flash of the other theme). Existing collections keep 深色.
 */
export type ThemeChoice = 'dark' | 'light' | 'auto';
export type ResolvedTheme = 'dark' | 'light';

const KEY = 'nexus.theme.v1';
const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null);

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'auto') return media()?.matches ? 'light' : 'dark';
  return choice;
}

export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    // Native controls and scrollbars follow the theme on screen (public/theme-boot.js sets the first frame).
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
  }
  storage.set(KEY, choice);
  return resolved;
}

/** Before the first render: the theme this browser showed last (dark when it never showed one). */
export function applyRememberedTheme(): void {
  const c = storage.get<ThemeChoice>(KEY);
  applyTheme(c === 'light' || c === 'auto' ? c : 'dark');
}

/** Keeps <html data-theme> in step with the collection's choice and, for 跟随系统, with the system. */
export function ThemeRoot() {
  const choice = useConfigStore((s) => s.snapshot.config.settings.look.theme) as ThemeChoice;
  const [system, setSystem] = useState(() => media()?.matches ?? false);
  useEffect(() => {
    const m = media();
    if (!m) return;
    const on = () => setSystem(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  useEffect(() => {
    applyTheme(choice);
  }, [choice, system]);
  return null;
}

/** The theme on screen now (for the top bar's 深色 / 浅色 button). */
export function useResolvedTheme(): ResolvedTheme {
  const choice = useConfigStore((s) => s.snapshot.config.settings.look.theme) as ThemeChoice;
  const [system, setSystem] = useState(() => media()?.matches ?? false);
  useEffect(() => {
    const m = media();
    if (!m) return;
    const on = () => setSystem(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return choice === 'auto' ? (system ? 'light' : 'dark') : choice;
}
