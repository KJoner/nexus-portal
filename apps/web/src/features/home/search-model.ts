import { buildSearch, engineSearchUrl, flattenRows, resolvePrefix, type Bookmark, type Config, type Engine, type QuickAction, type SearchRow } from '@nexus/shared';
import { Activity, Globe, History, Image, Search, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { linkwardenApi, suggestApi, useConfig } from '../../data/config-store';
import { useRecentStore, visibleRecent } from '../../data/recent';
import { useServices } from '../../data/status';
import type { TileTarget } from '../../icons/AppTile';
import { navigateTo, openApp } from '../../lib/open';
import { formatAgo } from '../../lib/time';
import { useWallpaper, useWallpapers } from './Wallpaper';

export type QuickActionId = 'status' | 'wallpaper' | 'settings';

/** Engines offered in the menu and Alt ↑↓ cycle; Linkwarden only once its search is switched on. */
export function useEngines(): Engine[] {
  const config = useConfig();
  return useMemo(() => config.engines.filter((e) => e.kind === 'web' || config.settings.search.linkwarden), [config.engines, config.settings.search.linkwarden]);
}

/**
 * Linkwarden matches for the typed text, fetched through Nexus (the token stays on the server).
 * Debounced; a newer query cancels the older request; any failure simply hides the 收藏 section.
 */
function useBookmarks(query: string, enabled: boolean): Bookmark[] | null {
  const [state, setState] = useState<{ q: string; items: Bookmark[] } | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (!enabled || !q) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      linkwardenApi.search(q, ctrl.signal).then(
        (items) => setState({ q, items }),
        () => !ctrl.signal.aborted && setState({ q, items: [] }),
      );
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, enabled]);
  return enabled && q && state?.q === q ? state.items : null;
}

/** 搜索建议 for the effective web engine, debounced and cancellable; off by default (privacy). */
function useSuggestions(query: string, engineId: string, enabled: boolean): string[] | null {
  const [state, setState] = useState<{ key: string; items: string[] } | null>(null);
  const q = query.trim();
  const key = `${engineId}|${q}`;
  useEffect(() => {
    if (!enabled || !q) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      suggestApi(engineId, q, ctrl.signal).then(
        (items) => setState({ key, items }),
        () => undefined,
      );
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [key, q, engineId, enabled]);
  return enabled && q && state?.key === key ? state.items : null;
}

export function useSearchModel(query: string, engineId: string, maxApps: number) {
  const config = useConfig();
  const engines = useEngines();
  const { engine: prefixed, rest } = resolvePrefix(query, engines);
  const bookmarks = useBookmarks(rest, config.settings.search.linkwarden && !config.settings.privacy.guest);
  const effective = prefixed ?? engines.find((e) => e.id === engineId);
  const webId = effective?.kind === 'web' ? effective.id : (engines.find((e) => e.kind === 'web')?.id ?? 'google');
  const suggestions = useSuggestions(rest, webId, config.settings.search.suggest && !config.settings.privacy.guest);
  const recentItems = useRecentStore((s) => s.items);
  const { summary } = useServices();
  const wp = useWallpaper(config.settings.look);
  const walls = useWallpapers();

  return useMemo(() => {
    const guest = config.settings.privacy.guest;
    const wi = walls.findIndex((w) => w.id === wp.id);
    const actions: QuickAction[] = [
      ...(guest ? [] : [{ id: 'status', title: '查看服务状态', sub: summary.text }]),
      { id: 'wallpaper', title: '更换壁纸', sub: `${wp.name} · 第 ${wi + 1} / ${walls.length} 张` },
      { id: 'settings', title: '打开设置', sub: '外观、快捷方式、应用与搜索' },
    ];
    const result = buildSearch({
      query,
      engineId,
      engines: engines.length ? engines : config.engines,
      apps: config.apps,
      showApps: config.settings.search.showApps,
      maxApps,
      bookmarks,
      suggestions,
      recent: visibleRecent(recentItems, config.settings),
      actions,
      formatAgo,
    });
    return { engines, result, rows: flattenRows(result.sections) };
  }, [config, engines, recentItems, summary.text, wp, walls, query, engineId, maxApps, bookmarks, suggestions]);
}

export function rowTile(row: SearchRow, config: Config, engine: Engine): TileTarget {
  switch (row.kind) {
    case 'app': {
      const app = config.apps.find((a) => a.id === row.appId);
      return app ? { kind: 'app', app } : { kind: 'system', icon: Globe };
    }
    case 'url':
      return { kind: 'system', icon: Globe };
    case 'bookmark':
      return { kind: 'bookmark' };
    case 'web':
      if (row.key.startsWith('sug:')) return { kind: 'system', icon: Search };
      return { kind: 'engine', engine: config.engines.find((e) => e.id === row.engineId) ?? engine };
    case 'recent': {
      const app = row.recent.appId ? config.apps.find((a) => a.id === row.recent.appId) : undefined;
      if (app) return { kind: 'app', app };
      return { kind: 'system', icon: row.recent.kind === 'search' ? Search : History };
    }
    case 'action':
      return { kind: 'system', icon: row.actionId === 'status' ? Activity : row.actionId === 'wallpaper' ? Image : Settings };
  }
}

/** Opens a result row; quick actions are handed back to the caller. */
export function activateRow(row: SearchRow, config: Config, newTab: boolean, onAction: (id: QuickActionId) => void) {
  const record = useRecentStore.getState().record;
  switch (row.kind) {
    case 'app': {
      const app = config.apps.find((a) => a.id === row.appId);
      if (app) openApp(app, newTab);
      return;
    }
    case 'url':
    case 'bookmark':
      record({ kind: 'url', title: row.kind === 'url' ? row.href.replace(/^https?:\/\//, '') : row.title, url: row.href });
      navigateTo(row.href, newTab);
      return;
    case 'web': {
      record({ kind: 'search', title: row.query, query: row.query, engineId: row.engineId });
      navigateTo(row.href, newTab);
      return;
    }
    case 'recent': {
      const r = row.recent;
      const app = r.appId ? config.apps.find((a) => a.id === r.appId) : undefined;
      if (app) return openApp(app, newTab);
      if (r.kind === 'search' && r.query) {
        const engine = config.engines.find((e) => e.id === r.engineId && e.kind === 'web') ?? config.engines.find((e) => e.kind === 'web');
        const href = engine && engineSearchUrl(engine, r.query);
        if (href) {
          record({ kind: 'search', title: r.query, query: r.query, engineId: engine.id });
          navigateTo(href, newTab);
        }
        return;
      }
      if (r.url) {
        record({ kind: 'url', title: r.title, url: r.url });
        navigateTo(r.url, newTab);
      }
      return;
    }
    case 'action':
      onAction(row.actionId as QuickActionId);
  }
}
