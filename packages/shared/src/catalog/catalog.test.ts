import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../defaults';
import { MAX_PINS, type Config } from '../schema';
import { canonicalUrl, stripTrackingParams } from '../url';
import { catalogIcon, catalogState, catalogToApp, planCatalogAdd, REQUIRED_CATALOG_CATEGORIES, searchCatalog, servedCatalog, validateCatalog, type CatalogDocument, type CatalogEntry, type CatalogItem } from './catalog';
import raw from './catalog.json';
import { CATALOG } from './data';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const doc = (): CatalogDocument => clone(raw) as CatalogDocument;
const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  stable_id: 'sample',
  version: 1,
  name: '示例站',
  name_en: 'Sample',
  aliases: [],
  url: 'https://sample.org',
  category: 'tools',
  description: '',
  icon_ref: 'fav',
  icon_source: 'favicon',
  visibility: 'public',
  status: 'active',
  region: 'global',
  updated_at: '2026-11-21',
  verification: { status: 'unverified' },
  ...over,
});
const withEntry = (e: CatalogEntry) => {
  const d = doc();
  d.entries.push(e);
  return d;
};
const errorsOf = (d: unknown) => validateCatalog(d).errors.join('\n');

describe('bundled 应用目录', () => {
  it('passes the build-time check', () => {
    expect(validateCatalog(raw).errors).toEqual([]);
    expect(CATALOG.entries.length).toBe(raw.entries.length);
  });

  it('is within the 80–150 first-release target and covers every required category', () => {
    const active = CATALOG.entries.filter((e) => e.status === 'active');
    expect(active.length).toBeGreaterThanOrEqual(80);
    expect(active.length).toBeLessThanOrEqual(150);
    for (const c of REQUIRED_CATALOG_CATEGORIES) expect(active.some((e) => e.category === c)).toBe(true);
  });

  it('never contains the operator’s private services', () => {
    const text = JSON.stringify(raw).toLowerCase();
    expect(text).not.toMatch(/litebox|linkwarden/);
    expect(CATALOG.entries.some((e) => e.stable_id === 'obsync' || /\.home\b/.test(e.url))).toBe(false);
  });

  it('lists LiteSync with a deployment-provided address and nothing that pins it', () => {
    const ls = CATALOG.entries.find((e) => e.stable_id === 'litesync')!;
    expect(ls.url_from_env).toBe('NEXUS_LITESYNC_URL');
    expect(Object.keys(ls)).not.toContain('pin');
  });

  it('does not claim network verification it never did', () => {
    for (const e of CATALOG.entries) if (e.verification.status !== 'unverified') expect(e.verification.checked_at).toBeTruthy();
  });
});

describe('validateCatalog rejects', () => {
  it('a duplicate stable_id', () => expect(errorsOf(withEntry(entry({ stable_id: 'github' })))).toMatch(/github: stable_id 重复/));
  it('plain http and embedded credentials', () => {
    expect(errorsOf(withEntry(entry({ url: 'http://sample.org' })))).toMatch(/必须使用 https/);
    expect(errorsOf(withEntry(entry({ url: 'https://user:pw@sample.org' })))).toMatch(/用户名或密码/);
  });
  it('private and LAN addresses', () => {
    expect(errorsOf(withEntry(entry({ url: 'https://nas.home' })))).toMatch(/内网或本机/);
    expect(errorsOf(withEntry(entry({ url: 'https://192.168.1.10' })))).toMatch(/内网或本机/);
  });
  it('operator-private services under any spelling', () => {
    expect(errorsOf(withEntry(entry({ name: 'LiteBox' })))).toMatch(/运营者私有服务/);
    expect(errorsOf(withEntry(entry({ aliases: ['my linkwarden'] })))).toMatch(/运营者私有服务/);
    expect(errorsOf(withEntry(entry({ stable_id: 'obsync' })))).toMatch(/运营者私有服务/);
  });
  it('unknown category, mismatched icon source and non-public visibility', () => {
    expect(errorsOf(withEntry(entry({ category: 'nope' })))).toMatch(/分类 nope 不存在/);
    expect(errorsOf(withEntry(entry({ icon_ref: 'di:github', icon_source: 'favicon' })))).toMatch(/icon_source 应为 dashboard-icons/);
    expect(errorsOf(withEntry(entry({ visibility: 'admin' })))).toMatch(/visibility=public/);
  });
  it('the same address twice', () => expect(errorsOf(withEntry(entry({ url: 'https://GITHUB.com:443/' })))).toMatch(/与 github 的地址相同/));
  it('a placeholder address outside url_from_env, and a real one inside it', () => {
    expect(errorsOf(withEntry(entry({ url: 'https://example.com' })))).toMatch(/占位地址/);
    expect(errorsOf(withEntry(entry({ url_from_env: 'NEXUS_X_URL' })))).toMatch(/只能是 example.com/);
  });
  it('a missing required category and a missing LiteSync entry', () => {
    const d = doc();
    d.entries = d.entries.filter((e) => e.category !== 'mail' && e.stable_id !== 'litesync');
    const errors = errorsOf(d);
    expect(errors).toMatch(/分类 mail 至少需要一个可用条目/);
    expect(errors).toMatch(/必须包含可用的 LiteSync/);
  });
  it('claimed verification without a date, and malformed documents', () => {
    expect(errorsOf(withEntry(entry({ verification: { status: 'reachable' } })))).toMatch(/缺少 checked_at/);
    expect(validateCatalog({ schemaVersion: 2 }).doc).toBeNull();
  });
});

describe('servedCatalog', () => {
  it('leaves LiteSync out until the deployment provides an https address', () => {
    expect(servedCatalog(CATALOG, {}).some((i) => i.id === 'litesync')).toBe(false);
    expect(servedCatalog(CATALOG, { NEXUS_LITESYNC_URL: 'http://sync.example.net' }).some((i) => i.id === 'litesync')).toBe(false);
    const ls = servedCatalog(CATALOG, { NEXUS_LITESYNC_URL: 'https://Sync.Example.net/' }).find((i) => i.id === 'litesync')!;
    expect(ls.url).toBe('https://sync.example.net');
  });

  it('skips retired templates', () => {
    const d = doc();
    d.entries.find((e) => e.stable_id === 'github')!.status = 'retired';
    expect(servedCatalog(d, {}).some((i) => i.id === 'github')).toBe(false);
  });
});

const items = (env: Record<string, string> = { NEXUS_LITESYNC_URL: 'https://sync.example.net' }) => servedCatalog(CATALOG, env);
const item = (id: string) => items().find((i) => i.id === id)!;

describe('a user copy of a template', () => {
  it('keeps provenance and searchable names, never pins, and maps icons onto existing sources', () => {
    const app = catalogToApp(item('bilibili'), [], 'none');
    expect(app).toMatchObject({ kind: 'site', name: '哔哩哔哩', url: 'https://www.bilibili.com', categoryId: 'none', catalogId: 'bilibili', catalogVersion: 1, hidden: false });
    expect(app.aliases).toEqual(expect.arrayContaining(['bilibili', 'b站']));
    expect(app.icon).toEqual({ source: 'library', ref: 'si:bilibili', letter: '', tone: 0 });
    expect(catalogIcon('di:github')).toMatchObject({ source: 'library', ref: 'github' });
    expect(catalogIcon('fav')).toMatchObject({ source: 'auto' });
    expect(catalogIcon('builtin:obsync')).toMatchObject({ source: 'builtin', ref: 'obsync' });
  });

  it('gets an id that does not collide with an existing entry', () => {
    const existing = defaultConfig().apps;
    expect(existing.some((a) => a.id === 'github')).toBe(true);
    expect(catalogToApp(item('github'), existing, 'dev').id).toBe('github-2');
  });

  it('shows 已添加 by template and by the same address saved by hand', () => {
    const cfg = defaultConfig();
    expect(catalogState(item('github'), cfg.apps)).toBe('same-url');
    expect(catalogState(item('zhihu'), cfg.apps)).toBe('new');
    const copy = catalogToApp(item('zhihu'), cfg.apps, 'none');
    expect(catalogState(item('zhihu'), [...cfg.apps, { ...copy, url: 'https://zhihu.com/explore' }])).toBe('added');
  });

  it('treats a front page with or without www. as the same site, but never a specific page', () => {
    const cfg = defaultConfig();
    // The self-hosted seed saved https://bilibili.com; the template is https://www.bilibili.com.
    expect(catalogState(item('bilibili'), cfg.apps)).toBe('same-url');
    const page = { ...cfg.apps[3]!, id: 'zh-page', url: 'https://www.zhihu.com/question/1', catalogId: undefined };
    expect(catalogState(item('zhihu'), [page])).toBe('new');
  });
});

describe('planCatalogAdd', () => {
  const base = (): Config => ({ ...defaultConfig(), apps: [], pins: [] });

  it('adds to the collection without pinning by default', () => {
    const plan = planCatalogAdd([item('zhihu'), item('douban')], base());
    expect(plan.ops.map((o) => o.type)).toEqual(['app.upsert', 'app.upsert']);
    expect(plan.added.map((a) => a.appId)).toEqual(['zhihu', 'douban']);
  });

  it('pins only when asked, and only while the home page has room', () => {
    expect(planCatalogAdd([item('zhihu')], base(), { pin: true }).ops.map((o) => o.type)).toEqual(['app.upsert', 'pin.add']);
    const full = base();
    full.pins = Array.from({ length: MAX_PINS }, (_, i) => `p${i}`);
    const plan = planCatalogAdd([item('zhihu')], full, { pin: true });
    expect(plan.ops.map((o) => o.type)).toEqual(['app.upsert']);
    expect(plan.notPinned.map((n) => n.appId)).toEqual(['zhihu']);
  });

  it('never duplicates: already added, same address or chosen twice', () => {
    const cfg = defaultConfig();
    const plan = planCatalogAdd([item('github'), item('zhihu'), item('zhihu')], cfg);
    expect(plan.skipped).toEqual([{ item: item('github'), reason: 'same-url' }]);
    expect(plan.added).toHaveLength(1);
  });

  it('falls back to 未分类 for 我的服务 or an unknown group', () => {
    const cfg = defaultConfig();
    for (const categoryId of ['hosted', 'missing', undefined]) {
      const op = planCatalogAdd([item('zhihu')], cfg, { categoryId }).ops[0]!;
      expect(op.type === 'app.upsert' && op.app.categoryId).toBe('none');
    }
    const op = planCatalogAdd([item('zhihu')], cfg, { categoryId: 'work' }).ops[0]!;
    expect(op.type === 'app.upsert' && op.app.categoryId).toBe('work');
  });
});

describe('searchCatalog', () => {
  const all = items();
  const ids = (q: string, opts = {}) => searchCatalog(all, q, opts).map((i) => i.id);

  it('finds Chinese names, English names, aliases and domains', () => {
    expect(ids('哔哩')[0]).toBe('bilibili');
    expect(ids('bilibili')[0]).toBe('bilibili');
    expect(ids('b站')[0]).toBe('bilibili');
    expect(ids('Wikipedia')).toEqual(expect.arrayContaining(['wikipedia', 'wikipedia-en']));
    expect(ids('ycombinator')).toContain('hacker-news');
  });

  it('uses pinyin initials when the pinyin table is available', () => {
    // Only the Chinese name: without pinyin nothing in it can match Latin letters.
    const custom: CatalogItem = { ...item('zhihu'), id: 'ceshi', name: '测试站', nameEn: '测试站', aliases: [], url: 'https://t.example.org' };
    const py = (t: string) => [...t].map((ch) => ({ 测: 'ce', 试: 'shi', 站: 'zhan' })[ch] ?? ch);
    expect(searchCatalog([custom], 'csz', { pinyin: null })).toEqual([]);
    expect(searchCatalog([custom], 'csz', { pinyin: py }).map((i) => i.id)).toEqual(['ceshi']);
  });

  it('filters by category and lists everything in category order without a query', () => {
    expect(new Set(searchCatalog(all, '', { category: 'mail' }).map((i) => i.category))).toEqual(new Set(['mail']));
    const ordered = searchCatalog(all, '', { order: CATALOG.categories });
    expect(ordered[0]!.category).toBe('search');
    expect(ordered).toHaveLength(all.length);
  });
});

describe('canonicalUrl and tracking parameters', () => {
  it('only normalises what cannot change the destination', () => {
    expect(canonicalUrl('HTTPS://Example.ORG:443/A?x=1#Top')).toBe('https://example.org/A?x=1#Top');
    expect(canonicalUrl('https://example.org/docs#/app/route?id=7')).toBe('https://example.org/docs#/app/route?id=7');
    expect(canonicalUrl('https://example.org/a')).not.toBe(canonicalUrl('https://example.org/b'));
  });

  it('rejects other protocols and embedded credentials', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings', 'https://u:p@example.org', 'not a url']) expect(canonicalUrl(bad)).toBeNull();
  });

  it('removes tracking parameters only when asked, and keeps the rest', () => {
    expect(stripTrackingParams('https://example.org/p?id=7&utm_source=x&fbclid=y#s')).toBe('https://example.org/p?id=7#s');
    expect(canonicalUrl('https://example.org/p?id=7&utm_source=x')).toBe('https://example.org/p?id=7&utm_source=x');
  });
});
