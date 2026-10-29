import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { pathWords, rankApps, typoDistance, type PinyinFn } from './match';
import type { AppEntry } from './schema';
import { buildSearch, type SearchInput } from './search';

/** Enough of a pinyin table for the examples (the app lazy-loads pinyin-pro). */
const PY: Record<string, string> = { 谷: 'gu', 歌: 'ge', 翻: 'fan', 译: 'yi', 腾: 'teng', 讯: 'xun', 文: 'wen', 档: 'dang', 邮: 'you', 箱: 'xiang', 云: 'yun', 端: 'duan', 硬: 'ying', 盘: 'pan', 日: 'ri', 历: 'li' };
const pinyin: PinyinFn = (text) => [...text].map((c) => PY[c] ?? c);

const base = defaultConfig().apps;
const gh = base.find((a) => a.id === 'github')!;
const app = (id: string, name: string, url = `https://${id}.example.com`, over: Partial<AppEntry> = {}): AppEntry => ({ ...gh, id, name, url, aliases: [], ...over });
const apps = [...base, app('gtrans', '谷歌翻译', 'https://translate.google.com'), app('tdocs', '腾讯文档', 'https://docs.qq.com'), app('qqmail', 'QQ邮箱', 'https://mail.qq.com'), app('gdrive2', 'Google Drive', 'https://drive.google.com/drive/my-drive')];
const top = (q: string, opts = { pinyin }) => rankApps(apps, q, opts)[0];

describe('matching (v0.2)', () => {
  it.each([
    ['lbx', 'litebox', 4],
    ['ltb', 'litebox', 4],
    ['gd', 'gdrive2', 2],
    ['gh', 'github', 2],
    ['ggfy', 'gtrans', 2],
    ['txwd', 'tdocs', 2],
    ['qqyx', 'qqmail', 2],
    ['tengxunwendang', 'tdocs', 1],
    ['teng', 'tdocs', 1],
    ['drive', 'gdrive2', 1],
    ['github', 'github', 0],
    ['b站', 'bilibili', 0],
  ] as const)('%s → %s', (q, id, tier) => {
    const m = top(q)!;
    expect(m.app.id).toBe(id);
    expect(m.tier).toBe(tier);
  });

  it('highlights the characters that matched', () => {
    expect(top('lbx')!.ranges).toEqual([
      [0, 1],
      [4, 5],
      [6, 7],
    ]);
    expect(top('txwd')!.ranges).toEqual([[0, 4]]);
    expect(top('drive')!.ranges).toEqual([[7, 12]]);
  });

  it('finds apps by domain and by safe path words, never by tokens or query strings', () => {
    expect(top('translate')!.app.id).toBe('gtrans');
    expect(top('docs.qq')!.app.id).toBe('tdocs');
    expect(top('my-drive')!.app.id).toBe('gdrive2');
    expect(pathWords('https://x.example.com/team/AbCdEfGhIjKlMnOpQrStUvWx123?token=secret#k')).toEqual(['team']);
    expect(pathWords('https://x.example.com/u/12345678/key=abc')).toEqual([]);
    const secret = app('tok', 'Tok', 'https://t.example.com/app?access_token=hunter2');
    expect(rankApps([secret], 'hunter2')).toEqual([]);
  });

  it('tolerates small typos as a weak, last-tier guess', () => {
    expect(typoDistance('gtihub', 'github', 1)).toBe(1);
    expect(top('gtihub')).toMatchObject({ tier: 5, weak: true });
    // Gapped letters that read like an abbreviation are a real match, loose ones only a guess.
    expect(top('lbx')).toMatchObject({ app: { id: 'litebox' }, weak: false });
    expect(rankApps(apps, 'lix', { pinyin })[0]).toMatchObject({ app: { id: 'litebox' }, weak: true });
    expect(top('githb')!.app.id).toBe('github');
    expect(rankApps(apps, 'qzxv', { pinyin })).toEqual([]);
  });

  it('keeps two letters from matching half the list', () => {
    const m = rankApps(apps, 'xz', { pinyin });
    expect(m).toEqual([]);
    expect(rankApps(apps, 'g', { pinyin }).every((x) => x.tier <= 1)).toBe(true);
  });

  it('works without pinyin (still loading) and ranks boosted apps first within a tier', () => {
    expect(rankApps(apps, 'txwd')).toEqual([]);
    const plain = rankApps(apps, 'c').map((m) => m.app.id);
    const boosted = rankApps(apps, 'c', { boost: (a) => (a.id === 'claude' ? 1 : 0) }).map((m) => m.app.id);
    expect(boosted[0]).toBe('claude');
    expect(new Set(boosted)).toEqual(new Set(plain));
  });
});

describe('search sections with fuzzy matches', () => {
  const c = defaultConfig();
  const input = (query: string, over: Partial<SearchInput> = {}): SearchInput => ({ query, engineId: 'google', engines: c.engines, apps, showApps: true, maxApps: 3, bookmarks: null, recent: [], actions: [], pinyin, ...over });

  it('a URL stays first even when an app matches loosely', () => {
    expect(buildSearch(input('gtihub.com')).sections[0]!.id).toBe('url');
  });

  it('guesses only: web search first, so Enter does not open a wrong app', () => {
    const r = buildSearch(input('gtihub'));
    expect(r.sections.map((s) => s.id)).toEqual(['web', 'apps']);
    expect(r.sections[1]!.title).toBe('可能是这些应用');
    expect(r.sections[1]!.rows[0]).toMatchObject({ weak: true });
  });

  it('strong matches keep apps first and carry highlights', () => {
    const r = buildSearch(input('ggfy'));
    expect(r.sections[0]!.id).toBe('apps');
    expect(r.sections[0]!.rows[0]).toMatchObject({ title: '谷歌翻译', highlight: [[0, 4]] });
  });

  it('shows what matched when it was an alias', () => {
    const row = buildSearch(input('twitter')).sections[0]!.rows[0]!;
    expect(row).toMatchObject({ title: 'X', sub: '别名 twitter' });
  });
});
