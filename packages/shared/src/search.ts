import type { AppEntry, Engine } from './schema';
import { displayUrl, engineSearchUrl, hostOf, looksLikeUrl, toNavigableUrl } from './url';

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  collection?: string;
}

export interface RecentItem {
  kind: 'app' | 'url' | 'search';
  title: string;
  appId?: string;
  url?: string;
  query?: string;
  engineId?: string;
  at: number;
}

export interface QuickAction {
  id: string;
  title: string;
  sub: string;
}

interface RowBase {
  key: string;
  title: string;
  sub: string;
  meta?: string;
}

export type SearchRow =
  | (RowBase & { kind: 'url'; href: string })
  | (RowBase & { kind: 'app'; appId: string })
  | (RowBase & { kind: 'bookmark'; href: string })
  | (RowBase & { kind: 'web'; engineId: string; href: string; query: string })
  | (RowBase & { kind: 'recent'; recent: RecentItem })
  | (RowBase & { kind: 'action'; actionId: string });

export interface SearchSection {
  id: 'url' | 'apps' | 'bookmarks' | 'web' | 'recent' | 'actions';
  title: string;
  rows: SearchRow[];
}

export interface SearchInput {
  query: string;
  engineId: string;
  engines: readonly Engine[];
  apps: readonly AppEntry[];
  showApps: boolean;
  maxApps: number;
  /** `null` while unavailable — the section is simply omitted. */
  bookmarks: readonly Bookmark[] | null;
  recent: readonly RecentItem[];
  actions: readonly QuickAction[];
  formatAgo?: (at: number) => string;
}

export interface SearchResult {
  engine: Engine;
  /** Query with an engine prefix (`g rust`) stripped. */
  query: string;
  prefixed: boolean;
  sections: SearchSection[];
}

/** `g rust` → Google + `rust`. Only applies when the prefix is followed by a space. */
export function resolvePrefix(query: string, engines: readonly Engine[]): { engine: Engine | null; rest: string } {
  const m = /^(\S{1,8})\s+(.*)$/s.exec(query.trimStart());
  if (m) {
    const engine = engines.find((e) => e.prefix && e.prefix.toLowerCase() === m[1]!.toLowerCase());
    if (engine) return { engine, rest: m[2]! };
  }
  return { engine: null, rest: query };
}

function haystack(a: AppEntry): string {
  return [a.name, hostOf(a.url), hostOf(a.lanUrl), a.description, ...a.aliases].join(' ').toLowerCase();
}

/** Rank: name prefix > word start > anywhere. Hidden apps never match. */
export function matchApps(apps: readonly AppEntry[], query: string, includeHidden = false): AppEntry[] {
  const q = query.trim().toLowerCase();
  const pool = apps.filter((a) => includeHidden || !a.hidden);
  if (!q) return [...pool];
  const scored: { a: AppEntry; s: number; i: number }[] = [];
  pool.forEach((a, i) => {
    const name = a.name.toLowerCase();
    const hay = haystack(a);
    let s = -1;
    if (name.startsWith(q)) s = 0;
    else if (name.split(/[\s-]+/).some((w) => w.startsWith(q)) || a.aliases.some((x) => x.toLowerCase().startsWith(q))) s = 1;
    else if (hay.includes(q)) s = 2;
    if (s >= 0) scored.push({ a, s, i });
  });
  return scored.sort((x, y) => x.s - y.s || x.i - y.i).map((x) => x.a);
}

function webEngineFor(engine: Engine, engines: readonly Engine[]): Engine | null {
  return engine.kind === 'web' ? engine : (engines.find((e) => e.kind === 'web') ?? null);
}

export function buildSearch(input: SearchInput): SearchResult {
  const { engines } = input;
  const base = engines.find((e) => e.id === input.engineId) ?? engines[0]!;
  const { engine: pre, rest } = resolvePrefix(input.query, engines);
  const engine = pre ?? base;
  const q = rest.trim();

  if (!q) {
    const sections: SearchSection[] = [];
    if (input.recent.length) {
      sections.push({
        id: 'recent',
        title: '最近',
        rows: input.recent.slice(0, 3).map((r, k) => ({
          key: `recent:${k}`,
          kind: 'recent',
          title: r.title,
          sub: r.kind === 'search' ? '搜索' : r.url ? displayUrl(r.url) : '',
          meta: input.formatAgo ? input.formatAgo(r.at) : '',
          recent: r,
        })),
      });
    }
    if (input.actions.length) {
      sections.push({ id: 'actions', title: '快捷操作', rows: input.actions.map((a) => ({ key: `action:${a.id}`, kind: 'action', title: a.title, sub: a.sub, actionId: a.id })) });
    }
    return { engine, query: q, prefixed: !!pre, sections };
  }

  const out: SearchSection[] = [];
  if (looksLikeUrl(q)) {
    const href = toNavigableUrl(q);
    out.push({ id: 'url', title: '打开网址', rows: [{ key: 'url', kind: 'url', title: `前往 ${displayUrl(href)}`, sub: href, href }] });
  }

  const marks: SearchSection | null = input.bookmarks?.length
    ? {
        id: 'bookmarks',
        title: '收藏',
        rows: input.bookmarks.slice(0, engine.kind === 'linkwarden' ? 6 : 2).map((b) => ({
          key: `bm:${b.id}`,
          kind: 'bookmark',
          title: b.title || displayUrl(b.url),
          sub: hostOf(b.url),
          meta: '收藏',
          href: b.url,
        })),
      }
    : null;
  if (marks && engine.kind === 'linkwarden') out.push(marks);

  if (input.showApps) {
    const apps = matchApps(input.apps, q).slice(0, input.maxApps);
    if (apps.length) {
      out.push({
        id: 'apps',
        title: '应用',
        rows: apps.map((a) => ({ key: `app:${a.id}`, kind: 'app', title: a.name, sub: hostOf(a.url), meta: a.kind === 'service' ? '自托管' : '应用', appId: a.id })),
      });
    }
  }

  const web = webEngineFor(engine, engines);
  const href = web ? engineSearchUrl(web, q) : null;
  if (web && href) {
    out.push({ id: 'web', title: '网页', rows: [{ key: `web:${web.id}`, kind: 'web', title: `在 ${web.name} 中搜索「${q}」`, sub: '网页搜索', engineId: web.id, href, query: q }] });
  }
  if (marks && engine.kind !== 'linkwarden') out.push(marks);

  return { engine, query: q, prefixed: !!pre, sections: out };
}

export function flattenRows(sections: readonly SearchSection[]): SearchRow[] {
  return sections.flatMap((s) => s.rows);
}
