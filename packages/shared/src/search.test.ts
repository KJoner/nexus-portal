import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { buildSearch, matchApps, resolvePrefix, type SearchInput } from './search';
import { summarize } from './status';
import { looksLikeUrl } from './url';

const c = defaultConfig();
const input = (query: string, over: Partial<SearchInput> = {}): SearchInput => ({
  query,
  engineId: 'google',
  engines: c.engines,
  apps: c.apps,
  showApps: true,
  maxApps: 3,
  bookmarks: null,
  recent: [],
  actions: [],
  ...over,
});

describe('looksLikeUrl', () => {
  it.each(['github.com', 'https://x.com/a b', 'localhost:3000', '192.168.1.10:8008/api', 'docs.linkwarden.app/api'])('%s', (s) => {
    expect(looksLikeUrl(s)).toBe(!s.includes(' '));
  });
  it.each(['1.5', 'node.js 教程', 'lin', 'a.b'])('%s is a search', (s) => {
    expect(looksLikeUrl(s)).toBe(false);
  });
});

describe('resolvePrefix', () => {
  it('switches engine only when followed by a space', () => {
    expect(resolvePrefix('b rust', c.engines).engine?.id).toBe('bing');
    expect(resolvePrefix('brust', c.engines).engine).toBeNull();
    expect(resolvePrefix('LW backup', c.engines)).toMatchObject({ rest: 'backup' });
  });
});

describe('buildSearch', () => {
  it('orders url → apps → web', () => {
    const r = buildSearch(input('github.com'));
    expect(r.sections.map((s) => s.id)).toEqual(['url', 'apps', 'web']);
  });

  it('ranks name prefixes first and excludes hidden apps', () => {
    expect(matchApps(c.apps, 'lin').map((a) => a.id)).toEqual(['linkwarden']);
    const hidden = c.apps.map((a) => (a.id === 'gmail' ? { ...a, hidden: true } : a));
    expect(matchApps(hidden, 'gmail')).toEqual([]);
    expect(matchApps(c.apps, 'b站').map((a) => a.id)).toEqual(['bilibili']);
  });

  it('puts bookmarks first for the Linkwarden engine and falls back to a web engine', () => {
    const bookmarks = [{ id: '1', title: 'Rust 异步编程入门', url: 'https://rust-lang.github.io/async-book' }];
    const r = buildSearch(input('rust', { engineId: 'links', bookmarks }));
    expect(r.sections.map((s) => s.id)).toEqual(['bookmarks', 'web']);
    const web = r.sections.find((s) => s.id === 'web')!.rows[0]!;
    expect(web.kind === 'web' && web.href).toBe('https://www.google.com/search?q=rust');
  });

  it('applies prefixes', () => {
    const r = buildSearch(input('d 天气'));
    expect(r.engine.id).toBe('duckduckgo');
    expect(r.prefixed).toBe(true);
    expect(r.query).toBe('天气');
  });

  it('idle shows only real recent items and actions', () => {
    expect(buildSearch(input('')).sections).toEqual([]);
    const r = buildSearch(input('  ', { recent: [{ kind: 'app', title: 'GitHub', appId: 'github', url: 'https://github.com', at: 0 }], actions: [{ id: 'wallpaper', title: '更换壁纸', sub: '' }] }));
    expect(r.sections.map((s) => s.id)).toEqual(['recent', 'actions']);
  });
});

describe('summarize', () => {
  const s = (name: string, level: Parameters<typeof summarize>[0][number]['level']) => ({ name, level });
  it('names the most severe issue', () => {
    expect(summarize([s('LiteBox', 'error'), s('OBsync', 'warn'), s('Linkwarden', 'unknown')])).toEqual({ level: 'error', text: 'LiteBox 无法访问', more: '另有 2 项提醒' });
    expect(summarize([s('LiteBox', 'ok'), s('OBsync', 'warn')]).text).toBe('OBsync 需要处理');
  });
  it('never counts unmonitored services as healthy', () => {
    expect(summarize([s('LiteBox', 'ok'), s('OBsync', 'off')])).toEqual({ level: 'ok', text: '1 项服务正常', more: '1 项未监测' });
    expect(summarize([s('LiteBox', 'off'), s('OBsync', 'off')])).toMatchObject({ level: 'off', text: '2 项服务未监测' });
  });
});
