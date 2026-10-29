import type { AppEntry, Config } from './schema';

/** Services shown in the Dock / mobile service area (visible and opted in). */
export function shownServices(c: Config): AppEntry[] {
  if (!c.settings.home.showServices) return [];
  return c.apps.filter((a) => a.kind === 'service' && !a.hidden && a.showInServices);
}

export function pinnedSites(c: Config): AppEntry[] {
  const byId = new Map(c.apps.map((a) => [a.id, a]));
  return c.pins.map((id) => byId.get(id)).filter((a): a is AppEntry => !!a && a.kind === 'site' && !a.hidden);
}

/** One order, two capacities: how many pinned sites each surface shows. */
export function homeCapacity(c: Config): { desktop: number; mobile: number } {
  const services = shownServices(c).length;
  return {
    desktop: c.settings.home.dockSize,
    mobile: Math.max(0, c.settings.home.mobileRows * 4 - services),
  };
}

/** Desktop home: the Dock's first row, and the pinned sites left for the extension pages. */
export function desktopShortcuts(c: Config): { first: AppEntry[]; extra: AppEntry[] } {
  const pinned = pinnedSites(c);
  const { dockSize, shortcuts } = c.settings.home;
  return { first: pinned.slice(0, dockSize), extra: shortcuts.mode === 'single' ? [] : pinned.slice(dockSize) };
}

/** Mobile home: sites on the first page (next to the services), and the rest for later pages. */
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
