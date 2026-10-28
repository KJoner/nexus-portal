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

export function engineSearchUrl(engine: Engine, query: string): string | null {
  if (engine.kind !== 'web' || !engine.urlTemplate.includes('%s')) return null;
  return engine.urlTemplate.replace('%s', encodeURIComponent(query.trim()));
}
