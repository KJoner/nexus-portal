import type { Settings } from '@nexus/shared';
import { create } from 'zustand';

type Look = Settings['look'];

/** Appearance edits are previewed, not saved (R2 · 预览后应用); the draft lives until applied or reverted. */
export const useLookDraft = create<{ draft: Look | null; set(d: Look): void; reset(): void }>((set) => ({
  draft: null,
  set: (draft) => set({ draft }),
  reset: () => set({ draft: null }),
}));

const KEYS: (keyof Look)[] = ['wallpaper', 'tone', 'overlay', 'brightness', 'blur', 'theme', 'clock', 'showDate', 'showSeconds', 'iconSize', 'motion', 'rotation', 'blocked'];
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function lookDiff(draft: Look | null, applied: Look): number {
  if (!draft) return 0;
  const focal = (['desktop', 'mobile'] as const).filter((d) => String(draft.focal[d]) !== String(applied.focal[d])).length;
  return KEYS.filter((k) => !same(draft[k], applied[k])).length + focal;
}

/**
 * Only what the draft changed: favorites (and anything else) edited on another device meanwhile
 * must not be overwritten by a stale copy when the draft is applied.
 */
export function lookPatch(draft: Look, applied: Look): Partial<Look> {
  return Object.fromEntries((Object.keys(draft) as (keyof Look)[]).filter((k) => !same(draft[k], applied[k])).map((k) => [k, draft[k]]));
}
