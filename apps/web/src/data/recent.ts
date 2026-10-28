import type { RecentItem } from '@nexus/shared';
import { create } from 'zustand';
import { storage } from '../lib/storage';
import { useConfigStore } from './config-store';

const KEY = 'nexus.recent.v1';
const MAX = 30;

interface RecentStore {
  items: RecentItem[];
  record(item: Omit<RecentItem, 'at'>): void;
  clear(): void;
  /** 清除搜索历史: removes searched terms, keeps recently opened apps. */
  clearSearches(): void;
}

const same = (a: Omit<RecentItem, 'at'>, b: RecentItem) => a.kind === b.kind && (a.appId ?? a.url ?? a.query) === (b.appId ?? b.url ?? b.query);

/** Recent opens and searches. Stored only in this browser (R2: 只保存在本浏览器，不会上传). */
export const useRecentStore = create<RecentStore>((set, get) => ({
  items: storage.get<RecentItem[]>(KEY) ?? [],
  record(item) {
    const { privacy, search } = useConfigStore.getState().snapshot.config.settings;
    if (privacy.guest) return;
    if (item.kind === 'search' ? !search.history : !privacy.recordRecent) return;
    const items = [{ ...item, at: Date.now() }, ...get().items.filter((x) => !same(item, x))].slice(0, MAX);
    storage.set(KEY, items);
    set({ items });
  },
  clear() {
    storage.remove(KEY);
    set({ items: [] });
  },
  clearSearches() {
    const items = get().items.filter((x) => x.kind !== 'search');
    storage.set(KEY, items);
    set({ items });
  },
}));

/** Items visible under current privacy and retention settings. */
export function visibleRecent(items: readonly RecentItem[], settings: ReturnType<typeof useConfigStore.getState>['snapshot']['config']['settings']): RecentItem[] {
  if (settings.privacy.guest || !settings.home.showRecent) return [];
  const cutoff = Date.now() - settings.search.historyDays * 86_400_000;
  return items.filter((r) => r.at >= cutoff && (r.kind === 'search' ? settings.search.history : settings.privacy.recordRecent));
}
