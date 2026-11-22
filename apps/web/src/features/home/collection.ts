import { AppSchema, LOCKED_CATEGORY, type AppEntry } from '@nexus/shared';
import { useEffect, useMemo } from 'react';
import { useConfig } from '../../data/config-store';
import { loadLibrary, useLibrary } from '../../data/library';
import { host } from '../../lib/host';

const clip = (s: string, n: number) => [...s].slice(0, n).join('').trim();

/**
 * 快速打开 (v0.5 · U2, 06-ACCEPTANCE L08): what the home page's search and its 快速打开 panel find is
 * the whole collection — saved pages that are not pinned to the home page included — not only the
 * home view (`config.apps`). A collection-only page is shown and opened as a site.
 *
 * The collection is loaded the first time `active` turns on (the person types or opens the panel);
 * a local collection reads it from this browser, an account's from the server once per page.
 * The browser extension's read-only view of an account has no collection to read: the home view only.
 */
export function useCollectionApps(active: boolean): AppEntry[] {
  const config = useConfig();
  const items = useLibrary((s) => s.items);
  const status = useLibrary((s) => s.status);
  useEffect(() => {
    if (active && status === 'idle' && !host.readOnly) void loadLibrary();
  }, [active, status]);
  return useMemo(() => {
    const shown = new Set(config.apps.map((a) => a.id));
    const extra: AppEntry[] = [];
    for (const i of Object.values(items)) {
      if (i.deletedAt !== null || shown.has(i.id)) continue;
      const parsed = AppSchema.safeParse({
        id: i.id,
        kind: 'site',
        name: clip(i.title, 32) || clip(i.url, 32),
        url: i.url,
        categoryId: i.folderId && i.folderId !== LOCKED_CATEGORY.hosted ? i.folderId : LOCKED_CATEGORY.none,
        icon: { source: 'auto', ref: '', letter: '', tone: 0 },
        aliases: i.tags.slice(0, 12).map((t) => clip(t, 32)),
      });
      if (parsed.success) extra.push(parsed.data);
    }
    return extra.length ? [...config.apps, ...extra] : config.apps;
  }, [items, config.apps]);
}
