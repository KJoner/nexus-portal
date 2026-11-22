import type { AppEntry, Config } from './schema';

/**
 * Services shown in the old Dock / mobile service area (visible and opted in). UI v2 (v12.0.3): the
 * home page no longer has a separate services strip — the services it showed were pinned by the
 * one-time tree migration (N2), and 「服务」 is a view of 我的收藏. Kept for older clients' documents
 * and the migration; the new home page does not call it.
 */
export function shownServices(c: Config): AppEntry[] {
  if (!c.settings.home.showServices) return [];
  return c.apps.filter((a) => a.kind === 'service' && !a.hidden && a.showInServices);
}

/**
 * The home page's pinned favorites in pin order — sites and (UI v2) services alike: a service is a
 * favorite with service options and is pinned like any other. Hidden entries never show.
 */
export function pinnedSites(c: Config): AppEntry[] {
  const byId = new Map(c.apps.map((a) => [a.id, a]));
  return c.pins.map((id) => byId.get(id)).filter((a): a is AppEntry => !!a && !a.hidden);
}

/** One order, two capacities: how many pinned favorites each surface shows on its first page. */
export function homeCapacity(c: Config): { desktop: number; mobile: number } {
  return {
    desktop: c.settings.home.dockSize,
    mobile: Math.max(0, c.settings.home.mobileRows * 4),
  };
}

/** Desktop home: the Dock's first row, and the pinned sites left for the extension pages. */
export function desktopShortcuts(c: Config): { first: AppEntry[]; extra: AppEntry[] } {
  const pinned = pinnedSites(c);
  const { dockSize, shortcuts } = c.settings.home;
  return { first: pinned.slice(0, dockSize), extra: shortcuts.mode === 'single' ? [] : pinned.slice(dockSize) };
}

/** Mobile home: the favorites on the first page, and the rest for later pages. */
export function mobileShortcuts(c: Config): { first: AppEntry[]; extra: AppEntry[] } {
  const pinned = pinnedSites(c);
  const capacity = homeCapacity(c).mobile;
  return { first: pinned.slice(0, capacity), extra: c.settings.home.shortcuts.mode === 'single' ? [] : pinned.slice(capacity) };
}

/** Splits `items` into pages of `size`; always at least one (possibly empty) page. */
export function paginate<T>(items: readonly T[], size: number): T[][] {
  if (size < 1 || !items.length) return [[...items]];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}
