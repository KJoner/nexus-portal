import type { CatalogResponse } from '@nexus/shared';
import { create } from 'zustand';
import { catalogApi } from '../../data/config-store';
import { HttpError, NetworkError } from '../../data/transport';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

interface CatalogStore {
  status: CatalogStatus;
  data: CatalogResponse | null;
  error: string | null;
  /** Loads once per page session; `force` re-fetches (retry after an error). */
  load(force?: boolean): Promise<void>;
}

/**
 * 应用目录 in memory. The catalog is public and the same for everyone, so nothing about it is
 * written to this browser's storage (and nothing per account is mixed into it).
 */
export const useCatalog = create<CatalogStore>((set, get) => ({
  status: 'idle',
  data: null,
  error: null,
  async load(force = false) {
    const s = get();
    if (!force && (s.status === 'loading' || s.status === 'ready')) return;
    set({ status: s.data ? 'ready' : 'loading', error: null });
    try {
      set({ status: 'ready', data: await catalogApi.load(), error: null });
    } catch (e) {
      const error = e instanceof NetworkError ? '无法连接 Nexus 服务端，请检查网络后重试' : e instanceof HttpError ? e.message : '应用目录加载失败';
      set({ status: get().data ? 'ready' : 'error', error });
    }
  },
}));

/** Tests. */
export const resetCatalog = () => useCatalog.setState({ status: 'idle', data: null, error: null });
