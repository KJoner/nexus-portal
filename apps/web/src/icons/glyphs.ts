const svg = (s: string) => `data:image/svg+xml,${encodeURIComponent(s)}`;

/** Nexus-drawn glyphs for the self-hosted services (R1 Spec · 自托管服务图标). */
export const BUILTIN_GLYPHS: Record<string, string> = {
  litebox: svg(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M16 4.6 26.6 10.4 16 16.2 5.4 10.4Z' fill='#F1C88C'/><path d='M5.4 10.4 16 16.2V27.6L5.4 21.8Z' fill='#E6C08A' fill-opacity='.46'/><path d='M26.6 10.4 16 16.2V27.6L26.6 21.8Z' fill='#E6C08A' fill-opacity='.24'/><path d='M16 4.6 26.6 10.4' stroke='#FFF3DE' stroke-opacity='.7' stroke-width='.8'/></svg>`,
  ),
  obsync: svg(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none' stroke='#C4D7BE' stroke-width='2.3' stroke-linecap='round' stroke-linejoin='round'><path d='M7.35 13.5A9 9 0 0 1 23.8 11.5'/><path d='M24.35 8.35 23.8 11.5 20.8 10.4'/><path d='M24.65 18.5A9 9 0 0 1 8.2 20.5'/><path d='M7.65 23.65 8.2 20.5 11.2 21.6'/><path d='M16 12.2 19 16 16 19.8 13 16Z' fill='#C4D7BE' stroke='none'/></svg>`,
  ),
  linkwarden: svg(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M10 5.2h12a1.6 1.6 0 0 1 1.6 1.6v20.4l-7.6-4.9-7.6 4.9V6.8A1.6 1.6 0 0 1 10 5.2z' fill='#C3CFDE'/><g fill='none' stroke='#262A30' stroke-width='1.7'><circle cx='14.2' cy='12.6' r='2.9'/><circle cx='17.8' cy='16.2' r='2.9'/></g></svg>`,
  ),
};

export const ALL_APPS_GLYPH = svg(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='#EFEAE1'><circle cx='9' cy='9' r='2.1'/><circle cx='16' cy='9' r='2.1'/><circle cx='23' cy='9' r='2.1'/><circle cx='9' cy='16' r='2.1'/><circle cx='16' cy='16' r='2.1'/><circle cx='23' cy='16' r='2.1'/><circle cx='9' cy='23' r='2.1'/><circle cx='16' cy='23' r='2.1'/><circle cx='23' cy='23' r='2.1'/></svg>`,
);

const DASHBOARD_ICONS = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';
const SIMPLE_ICONS = 'https://cdn.simpleicons.org/';

/**
 * Brand icon address. With 本地缓存图标 on (default) the Nexus server fetches and caches it, so the
 * browser never contacts a third-party icon service; off, the browser loads the CDN directly.
 */
export function libraryIconUrl(ref: string, cached: boolean): string {
  const slug = ref.trim().toLowerCase();
  const si = slug.startsWith('si:');
  const name = encodeURIComponent(si ? slug.slice(3) : slug);
  if (cached) return `/api/icon-cache/${si ? 'si' : 'di'}/${name}`;
  return si ? SIMPLE_ICONS + name : `${DASHBOARD_ICONS}${name}.svg`;
}

export function faviconUrl(host: string, cached: boolean): string {
  const h = encodeURIComponent(host.toLowerCase().replace(/:\d+$/, ''));
  return cached ? `/api/icon-cache/fav/${h}` : `https://icons.duckduckgo.com/ip3/${h}.ico`;
}
