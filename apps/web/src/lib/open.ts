import { appHref, type AppEntry } from '@nexus/shared';
import { useRecentStore } from '../data/recent';

export function navigateTo(href: string, newTab: boolean) {
  if (newTab) window.open(href, '_blank', 'noopener,noreferrer');
  else window.location.assign(href);
}

/** Anchor props for an app tile: real links, so middle-click and ⌘/Ctrl-click work natively. */
export function appLinkProps(app: AppEntry) {
  const newTab = app.openIn === 'new';
  return {
    href: appHref(app),
    target: newTab ? '_blank' : undefined,
    rel: newTab ? 'noopener noreferrer' : undefined,
  };
}

export function recordAppOpen(app: AppEntry) {
  useRecentStore.getState().record({ kind: 'app', title: app.name, appId: app.id, url: appHref(app) });
}

export function openApp(app: AppEntry, forceNewTab = false) {
  recordAppOpen(app);
  navigateTo(appHref(app), forceNewTab || app.openIn === 'new');
}
