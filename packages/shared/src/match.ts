import type { AppEntry } from './schema';

/**
 * Per-character pinyin of a string, one entry per character (non-Chinese characters as-is).
 * Supplied by the caller (the web app lazy-loads it), so this module stays dependency-free.
 */
export type PinyinFn = (text: string) => string[];

/**
 * Match strength, best first (v0.2 搜索排序):
 * 0 exact name / alias · 1 prefix (also full pinyin) · 2 initials (words, CamelCase, pinyin) ·
 * 3 contains (name, alias, domain, path) · 4 ordered characters with gaps · 5 small typos.
 */
export type MatchTier = 0 | 1 | 2 | 3 | 4 | 5;
export interface AppMatch {
  app: AppEntry;
  tier: MatchTier;
  /**
   * Only a guess (a typo, or loose letters that do not read like an abbreviation): never the
   * default for Enter, listed after the web search when nothing better matched.
   */
  weak: boolean;
  /** Character ranges of `app.name` to highlight, [start, end). */
  ranges: [number, number][];
  /** What matched when it was not the name (shown as a hint). */
  via?: string;
}

export interface MatchOptions {
  includeHidden?: boolean;
  pinyin?: PinyinFn | null;
  /** Small ranking bonus within a tier: pinned apps, frequently opened ones. */
  boost?: (app: AppEntry) => number;
}

const CJK = /[㐀-鿿豈-﫿]/;

interface Term {
  /** Lower-cased text. */
  text: string;
  /** Initials and the index (in `text`) of the character each one came from. */
  initials: string;
  initialAt: number[];
  /** Full pinyin (CJK text only) and, per pinyin character, the source character index. */
  pinyin: string;
  pinyinAt: number[];
}

/** Word starts: spaces and punctuation, CamelCase humps, every capital of an acronym, every CJK character. */
function initialsOf(raw: string, py: string[] | null): { initials: string; at: number[] } {
  let initials = '';
  const at: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const prev = raw[i - 1];
    if (CJK.test(ch)) {
      const s = py?.[i];
      if (s && /^[a-z]/i.test(s)) {
        initials += s[0]!.toLowerCase();
        at.push(i);
      }
      continue;
    }
    if (!/[a-z0-9]/i.test(ch)) continue;
    const start = prev === undefined || !/[a-z0-9]/i.test(prev) || CJK.test(prev);
    const hump = /[A-Z]/.test(ch) && !!prev && (/[a-z0-9]/.test(prev) || /[A-Z]/.test(prev));
    if (start || hump) {
      initials += ch.toLowerCase();
      at.push(i);
    }
  }
  return { initials, at };
}

function termOf(raw: string, pinyin: PinyinFn | null | undefined): Term {
  const text = raw.toLowerCase();
  const py = pinyin && CJK.test(raw) ? pinyin(raw) : null;
  const { initials, at } = initialsOf(raw, py && py.length === raw.length ? py : null);
  let full = '';
  const fullAt: number[] = [];
  if (py && py.length === raw.length) {
    py.forEach((s, i) => {
      const part = (CJK.test(raw[i]!) ? s : raw[i]!).toLowerCase().replace(/[^a-z0-9]/g, '');
      full += part;
      for (let k = 0; k < part.length; k++) fullAt.push(i);
    });
  }
  return { text, initials, initialAt: at, pinyin: full, pinyinAt: fullAt };
}

/** Path words worth searching: no query string, nothing that looks like a token or an id. */
export function pathWords(url: string): string[] {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return [];
  }
  return path
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s).toLowerCase();
      } catch {
        return '';
      }
    })
    .filter((s) => s.length >= 2 && s.length <= 32 && !/[=@]/.test(s) && !/^[a-z0-9_-]{20,}$/i.test(s) && !/\d{5,}/.test(s));
}

function hostWords(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

interface Index {
  name: Term;
  aliases: Term[];
  hosts: string[];
  path: string[];
}

const cache = new WeakMap<AppEntry, { pinyin: PinyinFn | null; index: Index }>();

function indexOf(app: AppEntry, pinyin: PinyinFn | null): Index {
  const hit = cache.get(app);
  if (hit && hit.pinyin === pinyin) return hit.index;
  const index: Index = {
    name: termOf(app.name, pinyin),
    aliases: app.aliases.filter(Boolean).map((a) => termOf(a, pinyin)),
    hosts: [hostWords(app.url), hostWords(app.lanUrl)].filter(Boolean),
    path: pathWords(app.url),
  };
  cache.set(app, { pinyin, index });
  return index;
}

/** Merges character positions into ranges. */
function ranges(at: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of [...new Set(at)].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/**
 * Ordered characters with gaps (`lbx` → LiteBox). Must start on the first letter or a word start,
 * and the gaps must stay modest, so two letters never match half the list.
 */
function subsequence(q: string, t: Term): number[] | null {
  const s = t.text;
  const starts = new Set(t.initialAt);
  let best: number[] | null = null;
  for (let first = 0; first < s.length; first++) {
    if (s[first] !== q[0] || (first > 0 && !starts.has(first))) continue;
    const at = [first];
    let j = first + 1;
    for (let k = 1; k < q.length; k++) {
      while (j < s.length && s[j] !== q[k]) j++;
      if (j >= s.length) break;
      at.push(j++);
    }
    if (at.length !== q.length) continue;
    const span = at.at(-1)! - at[0]! + 1;
    if (span > q.length * 3 + 2) continue;
    if (!best || span < best.at(-1)! - best[0]! + 1) best = at;
  }
  return best;
}

/** Optimal string alignment distance (insert, delete, substitute, swap neighbours), capped. */
export function typoDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** Best tier for one term (name or alias). Ranges refer to the term's own text. */
function matchTerm(q: string, t: Term): { tier: MatchTier; at: number[]; weak?: boolean } | null {
  const s = t.text;
  if (s === q) return { tier: 0, at: [...s].map((_, i) => i) };
  if (s.startsWith(q)) return { tier: 1, at: [...q].map((_, i) => i) };
  // Word starts inside the name ("drive" in "Google Drive") count as prefixes too.
  for (const i of t.initialAt) {
    if (i > 0 && s.startsWith(q, i)) return { tier: 1, at: [...q].map((_, k) => i + k) };
  }
  if (t.pinyin && t.pinyin.startsWith(q) && q.length >= 2) return { tier: 1, at: t.pinyinAt.slice(0, q.length) };
  if (q.length >= 2 && t.initials.startsWith(q)) return { tier: 2, at: t.initialAt.slice(0, q.length) };
  if (q.length >= 2) {
    const i = s.indexOf(q);
    if (i >= 0) return { tier: 3, at: [...q].map((_, k) => i + k) };
    const p = t.pinyin.indexOf(q);
    if (p >= 0 && q.length >= 3) return { tier: 3, at: t.pinyinAt.slice(p, p + q.length) };
  }
  if (q.length >= 3) {
    const at = subsequence(q, t);
    // `lbx` → LiteBox reads like an abbreviation: starts the name and hits two word starts.
    if (at) return { tier: 4, at, weak: !(at[0] === 0 && at.filter((i) => t.initialAt.includes(i)).length >= 2) };
    // Pinyin with gaps (txwd + 腾讯文档 is covered by initials; this catches "tengwd").
    if (t.pinyin && /^[a-z]+$/.test(q)) {
      const py = subsequence(q, { ...t, text: t.pinyin, initialAt: [...new Set(t.pinyinAt)].map((c) => t.pinyinAt.indexOf(c)) });
      if (py) return { tier: 4, at: py.map((i) => t.pinyinAt[i]!), weak: true };
    }
  }
  if (q.length >= 4 && /^[a-z0-9]+$/.test(q)) {
    const max = q.length >= 7 ? 2 : 1;
    const target = s.replace(/[^a-z0-9]/g, '');
    // A slip in the part typed so far: compare with the same-length start of the name.
    const best = Math.min(typoDistance(q, target, max), typoDistance(q, target.slice(0, q.length), max), typoDistance(q, target.slice(0, q.length + 1), max));
    if (best <= max) return { tier: 5, at: [], weak: true };
  }
  return null;
}

/** One app against the (lower-cased, trimmed) query. */
export function matchApp(app: AppEntry, q: string, pinyin: PinyinFn | null = null): AppMatch | null {
  const ix = indexOf(app, pinyin);
  const name = matchTerm(q, ix.name);
  let best: AppMatch | null = name ? { app, tier: name.tier, weak: !!name.weak, ranges: ranges(name.at) } : null;
  for (const [k, alias] of ix.aliases.entries()) {
    const m = matchTerm(q, alias);
    if (m && (!best || m.tier < best.tier)) best = { app, tier: m.tier, weak: !!m.weak, ranges: [], via: `别名 ${app.aliases[k]}` };
  }
  if (!best || best.tier > 3) {
    const hit = (via: string): AppMatch => ({ app, tier: 3, weak: false, ranges: [], via });
    if (q.length >= 2 && ix.hosts.some((h) => h.startsWith(q) || h.split('.').some((part) => part.startsWith(q)))) best = hit(ix.hosts[0]!);
    else if (q.length >= 3 && ix.hosts.some((h) => h.includes(q))) best = hit(ix.hosts[0]!);
    else if (q.length >= 3 && ix.path.some((p) => p.includes(q))) best = hit(`路径 ${ix.path.find((p) => p.includes(q))}`);
  }
  if (!best && q.length >= 3 && app.description.toLowerCase().includes(q)) best = { app, tier: 3, weak: false, ranges: [], via: app.description };
  return best;
}

/**
 * Ranked app matches: by tier, then pinned / frequent use, then where in the name it matched,
 * then shorter names, then the user's own order. Hidden apps never match unless asked for.
 */
export function rankApps(apps: readonly AppEntry[], query: string, opts: MatchOptions = {}): AppMatch[] {
  const q = query.trim().toLowerCase();
  const pool = apps.filter((a) => opts.includeHidden || !a.hidden);
  if (!q) return pool.map((app) => ({ app, tier: 0, weak: false, ranges: [] }));
  const out: { m: AppMatch; i: number; boost: number; pos: number }[] = [];
  pool.forEach((app, i) => {
    const m = matchApp(app, q, opts.pinyin ?? null);
    if (m) out.push({ m, i, boost: opts.boost?.(app) ?? 0, pos: m.ranges[0]?.[0] ?? 99 });
  });
  return out.sort((x, y) => Number(x.m.weak) - Number(y.m.weak) || x.m.tier - y.m.tier || y.boost - x.boost || x.pos - y.pos || x.m.app.name.length - y.m.app.name.length || x.i - y.i).map((x) => x.m);
}
