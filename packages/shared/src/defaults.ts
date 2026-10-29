import type { AppEntry, Config, Engine } from './schema';

/** Ember tones for self-hosted tiles and letter icons: [top, bottom]. */
export const TONES: ReadonlyArray<readonly [string, string]> = [
  ['#40372c', '#29241e'],
  ['#333d35', '#222924'],
  ['#323842', '#22262c'],
  ['#3d3236', '#282225'],
];

export interface Wallpaper {
  id: string;
  name: string;
  kind: 'photo' | 'color';
  /** Photo: asset url. Color: CSS background. */
  src: string;
  credit?: string;
  /** Default focal point [x%, y%] for photos. */
  focal?: [number, number];
}

export const BUILTIN_WALLPAPERS: readonly Wallpaper[] = [
  { id: 'fallingwater', name: '流水别墅', kind: 'photo', src: '/wallpapers/fallingwater.jpg', credit: '宾夕法尼亚', focal: [50, 42] },
  { id: 'ember', name: '暖炭', kind: 'color', src: 'linear-gradient(160deg,#3a3129 0%,#1d1a16 70%)' },
  { id: 'moss', name: '夜苔', kind: 'color', src: 'linear-gradient(160deg,#2f3a31 0%,#181c18 70%)' },
  { id: 'slate', name: '石墨', kind: 'color', src: 'linear-gradient(160deg,#30353d 0%,#17191d 70%)' },
];

const site = (id: string, name: string, url: string, categoryId: string, ref: string, aliases: string[] = []): AppEntry => ({
  id,
  kind: 'site',
  name,
  description: '',
  url,
  lanUrl: '',
  prefer: 'ext',
  categoryId,
  hidden: false,
  showInServices: true,
  aliases,
  icon: { source: 'library', ref, letter: '', tone: 0 },
  openIn: 'same',
  health: { enabled: false, target: '/', intervalSec: 60 },
});

/**
 * The three self-hosted services ship with placeholder addresses and health checks off,
 * so the home page reports them as 未监测 until they are configured — never as healthy.
 */
const service = (id: string, name: string, description: string, url: string, tone: number): AppEntry => ({
  id,
  kind: 'service',
  name,
  description,
  url,
  lanUrl: '',
  prefer: 'ext',
  categoryId: 'hosted',
  hidden: false,
  showInServices: true,
  aliases: [],
  icon: { source: 'builtin', ref: id, letter: '', tone },
  openIn: 'same',
  health: { enabled: false, target: '/', intervalSec: 60 },
});

export const DEFAULT_ENGINES: readonly Engine[] = [
  { id: 'google', name: 'Google', urlTemplate: 'https://www.google.com/search?q=%s', prefix: 'g', builtin: true, kind: 'web', icon: 'google' },
  { id: 'bing', name: 'Bing', urlTemplate: 'https://www.bing.com/search?q=%s', prefix: 'b', builtin: true, kind: 'web', icon: 'bing' },
  { id: 'duckduckgo', name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s', prefix: 'd', builtin: true, kind: 'web', icon: 'duckduckgo' },
  { id: 'links', name: '我的收藏', urlTemplate: '', prefix: 'lw', builtin: true, kind: 'linkwarden', icon: '' },
];

/** Apps are listed category by category (see `groupByCategory`). */
export function defaultConfig(): Config {
  const apps: AppEntry[] = [
    service('litebox', 'LiteBox', '服务器探针', 'https://litebox.home', 0),
    service('obsync', 'OBsync', '笔记同步', 'https://obsync.home', 1),
    service('linkwarden', 'Linkwarden', '书签归档', 'https://links.home', 2),
    site('github', 'GitHub', 'https://github.com', 'dev', 'github'),
    site('vercel', 'Vercel', 'https://vercel.com', 'dev', 'vercel'),
    site('cloudflare', 'Cloudflare', 'https://dash.cloudflare.com', 'dev', 'cloudflare'),
    site('gmail', 'Gmail', 'https://mail.google.com', 'work', 'gmail'),
    site('notion', 'Notion', 'https://notion.so', 'work', 'notion'),
    site('figma', 'Figma', 'https://figma.com', 'work', 'figma'),
    site('gdrive', '云端硬盘', 'https://drive.google.com', 'work', 'google-drive', ['google drive']),
    site('gcal', '日历', 'https://calendar.google.com', 'work', 'google-calendar', ['google calendar']),
    site('chatgpt', 'ChatGPT', 'https://chatgpt.com', 'work', 'chatgpt'),
    site('claude', 'Claude', 'https://claude.ai', 'work', 'claude-ai'),
    site('youtube', 'YouTube', 'https://youtube.com', 'media', 'youtube'),
    site('bilibili', '哔哩哔哩', 'https://bilibili.com', 'media', 'si:bilibili', ['bilibili', 'b站']),
    site('spotify', 'Spotify', 'https://open.spotify.com', 'media', 'spotify'),
    site('reddit', 'Reddit', 'https://reddit.com', 'media', 'reddit'),
    site('x', 'X', 'https://x.com', 'media', 'x', ['twitter']),
    site('telegram', 'Telegram', 'https://web.telegram.org', 'media', 'telegram'),
  ];
  return {
    apps,
    categories: [
      { id: 'hosted', label: '我的服务', locked: true },
      { id: 'dev', label: '开发', locked: false },
      { id: 'work', label: '工作', locked: false },
      { id: 'media', label: '影音与社区', locked: false },
      { id: 'none', label: '未分类', locked: true },
    ],
    pins: ['github', 'gmail', 'youtube', 'bilibili', 'notion'],
    engines: DEFAULT_ENGINES.map((e) => ({ ...e })),
    settings: {
      search: { defaultEngine: 'google', suggest: false, history: true, historyDays: 30, showApps: true, linkwarden: false },
      home: {
        dockSize: 5,
        mobileRows: 2,
        showServices: true,
        labels: { desktop: true, mobile: true },
        showRecent: true,
        shortcuts: { mode: 'expand', pageRows: 2, pager: true, remember: false },
      },
      look: {
        wallpaper: 'fallingwater',
        tone: 'warm',
        overlay: 48,
        brightness: 100,
        blur: 0,
        theme: 'dark',
        clock: '24',
        showDate: true,
        showSeconds: false,
        iconSize: 'm',
        motion: 'full',
        focal: { desktop: [50, 42], mobile: [46, 50] },
      },
      privacy: { guest: false, recordRecent: true, cacheIcons: true },
    },
  };
}
