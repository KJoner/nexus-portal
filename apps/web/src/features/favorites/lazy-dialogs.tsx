import { lazy, Suspense } from 'react';
import { useFavoriteDialogs } from './dialog-store';

const Dialogs = lazy(() => import('./FavoriteDialogs'));

/**
 * For the home page and 快速打开: the dialogs' code loads only when 添加收藏 or 编辑 is first
 * opened, so the new-tab page stays light. 我的收藏 renders the dialogs directly.
 */
export function LazyFavoriteDialogs() {
  const open = useFavoriteDialogs((s) => s.add !== null || s.edit !== null);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Dialogs />
    </Suspense>
  );
}
