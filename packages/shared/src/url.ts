import type { AppEntry, Engine } from './schema';

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const TLD_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Whether typed text should be offered as "打开网址" rather than searched.
 * Stricter than the prototype so that `1.5` or `node.js 教程` stay searches.
 */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return hostOf(s) !== '';
  const host = s.split(/[/?#]/, 1)[0]!.replace(/:\d{1,5}$/, '');
  return TLD_HOST.test(host) || IPV4.test(host) || host.toLowerCase() === 'localhost';
}

export function toNavigableUrl(input: string): string {
  const s = input.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** The address an app opens with: services may prefer their LAN address. */
export function appHref(app: AppEntry): string {
  return app.kind === 'service' && app.prefer === 'lan' && app.lanUrl ? app.lanUrl : app.url;
}

/**
 * Conservative canonical form used to spot the same address saved twice (公开化 · 收藏去重).
 * Only changes that never alter what the address opens: the scheme and host are lower-cased and a
 * default port is dropped (both done by the URL parser). Path, query and fragment stay exactly as
 * they are — documents and app routes depend on them. Returns null for anything that is not a plain
 * http(s) address, and for addresses that embed a user name or password (those are never saved).
 */
export function canonicalUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  if (u.username || u.password) return null;
  return u.href;
}

/** Query parameters that only track where a click came from. Removing them is an explicit, optional step. */
const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|spm|share_source|share_medium|vd_source)$/i;

/** `canonicalUrl` plus removal of well-known tracking parameters; everything else is kept. */
export function stripTrackingParams(input: string): string | null {
  const href = canonicalUrl(input);
  if (!href) return null;
  const u = new URL(href);
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  return u.href;
}

export function engineSearchUrl(engine: Engine, query: string): string | null {
  if (engine.kind !== 'web' || !engine.urlTemplate.includes('%s')) return null;
  return engine.urlTemplate.replace('%s', encodeURIComponent(query.trim()));
}
