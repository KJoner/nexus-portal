import type { PinyinFn } from '@nexus/shared';
import { create } from 'zustand';

/**
 * 拼音 / 拼音首字母 matching for Chinese app names. pinyin-pro is large, so it is its own chunk,
 * fetched while the browser is idle after the home page has painted; until it arrives, search
 * simply works without pinyin.
 */
export const usePinyin = create<{ fn: PinyinFn | null; load(): void }>((set, get) => {
  let started = false;
  return {
    fn: null,
    load() {
      if (started || get().fn) return;
      started = true;
      import('pinyin-pro').then(
        ({ pinyin }) => set({ fn: (text: string) => pinyin(text, { toneType: 'none', type: 'array' }) }),
        () => {
          started = false;
        },
      );
    },
  };
});

/** Starts loading pinyin when the browser has nothing better to do. */
export function preloadPinyin() {
  const run = () => usePinyin.getState().load();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 2000);
}
