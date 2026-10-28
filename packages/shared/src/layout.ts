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
