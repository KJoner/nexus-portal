import { create } from 'zustand';

/**
 * 添加收藏 and the unified editor are opened from many places — the 我的收藏 page, the home page,
 * 快速打开, old links (/catalog, /settings/apps?new=…) — and are the same dialog everywhere
 * (UI v2 · spec 01 §5). Whoever shows the page renders <FavoriteDialogs/>; this store says what is open.
 */
export type AddTab = 'manual' | 'store';

export interface AddRequest {
  tab: AddTab;
  /** 应用商店 search words (e.g. from /catalog?q=). */
  q: string;
  /** Prefill of the manual form (e.g. 快速打开 「添加收藏」 with what was typed, /settings/apps?new=&url=). */
  title: string;
  url: string;
  /** The group the dialog starts with (the group being looked at in 我的收藏). */
  folderId?: string;
}

interface DialogState {
  add: AddRequest | null;
  /** The favorite being edited (its id). */
  edit: string | null;
  showAdd(req?: Partial<AddRequest>): void;
  hideAdd(): void;
  showEdit(id: string): void;
  hideEdit(): void;
}

export const useFavoriteDialogs = create<DialogState>((set) => ({
  add: null,
  edit: null,
  showAdd: (req = {}) => set({ add: { tab: req.tab ?? 'manual', q: req.q ?? '', title: req.title ?? '', url: req.url ?? '', ...(req.folderId ? { folderId: req.folderId } : {}) }, edit: null }),
  hideAdd: () => set({ add: null }),
  showEdit: (id) => set({ edit: id, add: null }),
  hideEdit: () => set({ edit: null }),
}));

export const openAddFavorite = (req?: Partial<AddRequest>) => useFavoriteDialogs.getState().showAdd(req);
export const openEditFavorite = (id: string) => useFavoriteDialogs.getState().showEdit(id);
