import { BUILTIN_WALLPAPERS, buildSearch, engineSearchUrl, flattenRows, type Config, type Engine, type QuickAction, type SearchRow } from '@nexus/shared';
import { Activity, Globe, History, Image, Search, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { useConfig } from '../../data/config-store';
import { useRecentStore, visibleRecent } from '../../data/recent';
import { useServices } from '../../data/status';
import type { TileTarget } from '../../icons/AppTile';
import { navigateTo, openApp } from '../../lib/open';
import { formatAgo } from '../../lib/time';
import { useWallpaper } from './Wallpaper';

export type QuickActionId = 'status' | 'wallpaper' | 'settings';

/** Engines offered in the menu and Alt ↑↓ cycle; Linkwarden only once its search is switched on. */
export function useEngines(): Engine[] {
  const config = useConfig();
  return useMemo(() => config.engines.filter((e) => e.kind === 'web' || config.settings.search.linkwarden), [config.engines, config.settings.search.linkwarden]);
}

export function useSearchModel(query: string, engineId: string, maxApps: number) {
  const config = useConfig();
  const engines = useEngines();
  const recentItems = useRecentStore((s) => s.items);
  const { summary } = useServices();
  const wp = useWallpaper(config.settings.look);

  return useMemo(() => {
    const guest = config.settings.privacy.guest;
    const wi = BUILTIN_WALLPAPERS.findIndex((w) => w.id === wp.id);
    const actions: QuickAction[] = [
      ...(guest ? [] : [{ id: 'status', title: '查看服务状态', sub: summary.text }]),
      { id: 'wallpaper', title: '更换壁纸', sub: `${wp.name} · 第 ${wi + 1} / ${BUILTIN_WALLPAPERS.length} 张` },
      { id: 'settings', title: '打开设置', sub: '外观、快捷方式、应用与搜索' },
    ];
    const result = buildSearch({
      query,
      engineId,
      engines: engines.length ? engines : config.engines,
      apps: config.apps,
      showApps: config.settings.search.showApps,
      maxApps,
      bookmarks: null,
      recent: visibleRecent(recentItems, config.settings),
      actions,
      formatAgo,
    });
    return { engines, result, rows: flattenRows(result.sections) };
  }, [config, engines, recentItems, summary.text, wp, query, engineId, maxApps]);
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
