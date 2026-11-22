import { AddFavoriteDialog } from './AddFavoriteDialog';
import { FavoriteEditor } from './FavoriteEditor';

/** The two dialogs of 我的收藏, wherever the page is (home, 快速打开, settings). */
export default function FavoriteDialogs() {
  return (
    <>
      <AddFavoriteDialog />
      <FavoriteEditor />
    </>
  );
}
