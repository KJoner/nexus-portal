import { rankApps, type MatchOptions, type PinyinFn } from './match';
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
  /** Ranges of `title` that matched the query, [start, end). */
  highlight?: [number, number][];
  /** A guess (gapped letters, typo): never the default for Enter. */
  weak?: boolean;
}

export type SearchRow =
  | (RowBase & { kind: 'url'; href: string })
  | (RowBase & { kind: 'app'; appId: string })
  | (RowBase & { kind: 'bookmark'; href: string })
  | (RowBase & { kind: 'web'; engineId: string; href: string; query: string })
  | (RowBase & { kind: 'recent'; recent: RecentItem })
  | (RowBase & { kind: 'action'; actionId: string });

export interface SearchSection {
  id: 'url' | 'apps' | 'bookmarks' | 'web' | 'suggest' | 'recent' | 'actions';
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
  /** Query completions from the web engine (搜索建议), when enabled. */
  suggestions?: readonly string[] | null;
  recent: readonly RecentItem[];
  actions: readonly QuickAction[];
  formatAgo?: (at: number) => string;
  /** Lazy-loaded pinyin for Chinese names (拼音 / 首字母). */
  pinyin?: PinyinFn | null;
  /** Ranking bonus for pinned and frequently opened apps. */
  boost?: MatchOptions['boost'];
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

/** Apps matching `query`, best first (see `rankApps`). Hidden apps never match unless asked for. */
export function matchApps(apps: readonly AppEntry[], query: string, includeHidden = false, opts: Omit<MatchOptions, 'includeHidden'> = {}): AppEntry[] {
  return rankApps(apps, query, { ...opts, includeHidden }).map((m) => m.app);
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

  // Weak guesses (gapped letters, typos) only fill up behind strong matches, and never more than two.
  let apps: SearchSection | null = null;
  if (input.showApps) {
    const ranked = rankApps(input.apps, q, { pinyin: input.pinyin, boost: input.boost });
    const strong = ranked.filter((m) => !m.weak);
    const picked = [...strong, ...ranked.filter((m) => m.weak).slice(0, 2)].slice(0, input.maxApps);
    if (picked.length) {
      apps = {
        id: 'apps',
        title: strong.length ? '应用' : '可能是这些应用',
        rows: picked.map((m) => ({
          key: `app:${m.app.id}`,
          kind: 'app',
          title: m.app.name,
          // Only the host: a path or query could carry tokens.
          sub: m.via && !m.via.startsWith(hostOf(m.app.url)) ? m.via : hostOf(m.app.url),
          meta: m.app.kind === 'service' ? '自托管' : '应用',
          appId: m.app.id,
          highlight: m.ranges,
          weak: m.weak || undefined,
        })),
      };
    }
  }

  const web = webEngineFor(engine, engines);
  const href = web ? engineSearchUrl(web, q) : null;
  const webSection: SearchSection | null = web && href ? { id: 'web', title: '网页', rows: [{ key: `web:${web.id}`, kind: 'web', title: `在 ${web.name} 中搜索「${q}」`, sub: '网页搜索', engineId: web.id, href, query: q }] } : null;
  // Only guesses: the web search comes first, so Enter does not open a wrong app.
  const guessesOnly = apps && apps.rows.every((r) => r.weak);
  if (apps && !guessesOnly) out.push(apps);
  if (webSection) out.push(webSection);
  if (apps && guessesOnly) out.push(apps);
  if (web && input.suggestions?.length) {
    const seen = new Set([q.toLowerCase()]);
    const rows = input.suggestions
      .filter((x) => x.trim() && !seen.has(x.trim().toLowerCase()) && seen.add(x.trim().toLowerCase()))
      .slice(0, 4)
      .flatMap((text, k): SearchRow[] => {
        const href = engineSearchUrl(web, text);
        return href ? [{ key: `sug:${k}`, kind: 'web', title: text, sub: `${web.name} 建议`, engineId: web.id, href, query: text }] : [];
      });
    if (rows.length) out.push({ id: 'suggest', title: '搜索建议', rows });
  }
  if (marks && engine.kind !== 'linkwarden') out.push(marks);

  return { engine, query: q, prefixed: !!pre, sections: out };
}

export function flattenRows(sections: readonly SearchSection[]): SearchRow[] {
  return sections.flatMap((s) => s.rows);
}
