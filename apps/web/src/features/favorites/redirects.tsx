import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * Old addresses of the collection (UI v2 · spec 03 §9, 07 §7): 收藏库 (/library) and 应用目录
 * (/catalog) are 我的收藏 now. Bookmarks and links keep working and land on the same task:
 *   /library                → /settings/favorites (view / search kept; ?edit=<id> opens the editor)
 *   /catalog?q=…            → /settings/favorites with 添加收藏 › 应用商店, the search kept
 * Query values are only passed on as URL parameters, never put into the page as HTML.
 */
export function LegacyLibraryRedirect() {
  const navigate = useNavigate();
  const { search } = useLocation();
  useEffect(() => {
    const old = new URLSearchParams(search);
    const next = new URLSearchParams();
    for (const k of ['edit', 'q', 'view', 'import']) if (old.get(k)) next.set(k, old.get(k)!);
    if (old.get('folder')) next.set('view', `group:${old.get('folder')}`);
    navigate(`/settings/favorites${next.size ? `?${next}` : ''}`, { replace: true });
  }, [navigate, search]);
  return <div className="fixed inset-0 bg-base" />;
}

export function LegacyCatalogRedirect() {
  const navigate = useNavigate();
  const { search } = useLocation();
  useEffect(() => {
    const q = new URLSearchParams(search).get('q') ?? '';
    const next = new URLSearchParams({ add: 'store' });
    if (q) next.set('sq', q);
    navigate(`/settings/favorites?${next}`, { replace: true });
  }, [navigate, search]);
  return <div className="fixed inset-0 bg-base" />;
}
