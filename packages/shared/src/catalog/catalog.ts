import { z } from 'zod';
import { rankApps, type PinyinFn } from '../match';
import type { Op } from '../ops';
import { LOCKED_CATEGORY, MAX_PINS, type AppEntry, type Config, type Icon } from '../schema';
import { canonicalUrl, hostOf } from '../url';
import { newAppId } from '../validate';

/**
 * 应用目录 (v0.4, 公开化批次 B): public website templates maintained by the operator in this
 * repository. A template is never a user's data — adding one copies it into the user's own
 * collection (an AppEntry with `catalogId`), and later template versions never overwrite that copy.
 *
 * The data file lives in `catalog.json` next to this module and is exposed separately
 * (`@nexus/shared/catalog-data`) so the web bundle does not carry it; browsers read the catalog
 * from `GET /api/v2/catalog`.
 */

export const CATALOG_SCHEMA_VERSION = 1;

const StableId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'stable_id 只能用小写字母、数字和连字符（最长 48）');
const IconRef = z.string().regex(/^(?:di:[a-z0-9][a-z0-9-]{0,63}|si:[a-z0-9][a-z0-9-]{0,63}|builtin:[a-z0-9-]{1,32}|fav|letter)$/, 'icon_ref 格式不正确');

export const CatalogCategorySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
  label: z.string().trim().min(1).max(16),
  order: z.number().int().min(0).max(1000),
});

export const CatalogVerificationSchema = z.object({
  /** `unverified`: never checked over the network. `reachable` / `unreachable`: result of `npm run catalog:verify`. */
  status: z.enum(['unverified', 'reachable', 'unreachable']),
  checked_at: z.string().max(40).optional(),
  http_status: z.number().int().min(0).max(999).optional(),
  note: z.string().max(200).optional(),
});

export const CatalogEntrySchema = z.object({
  stable_id: StableId,
  /** Bumped when the template's defaults change; copies remember the version they were made from. */
  version: z.number().int().min(1).max(1_000_000),
  /** Same limit as the app editor (首页最多显示 16 个字符). */
  name: z.string().trim().min(1).max(16),
  name_en: z.string().trim().min(1).max(48),
  aliases: z.array(z.string().trim().min(1).max(32)).max(12),
  url: z.string().trim().min(1).max(2048),
  /**
   * The real address is deployment specific (LiteSync: the operator's own sync server). The served
   * catalog takes it from this environment variable and leaves the entry out while it is unset.
   */
  url_from_env: z
    .string()
    .regex(/^NEXUS_[A-Z0-9_]{1,40}$/)
    .optional(),
  category: z.string().min(1).max(24),
  description: z.string().trim().max(40),
  icon_ref: IconRef,
  /** Where the icon comes from — recorded, never assumed to be an open licence for the brand. */
  icon_source: z.enum(['dashboard-icons', 'simple-icons', 'favicon', 'letter', 'nexus-builtin']),
  visibility: z.enum(['public', 'admin']),
  status: z.enum(['active', 'retired']),
  region: z.enum(['global', 'cn']),
  updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verification: CatalogVerificationSchema,
});

export const CatalogDocumentSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  catalogVersion: z.string().min(1).max(32),
  note: z.string().max(1000).optional(),
  categories: z.array(CatalogCategorySchema).min(1).max(30),
  entries: z.array(CatalogEntrySchema).max(500),
});

export type CatalogCategory = z.infer<typeof CatalogCategorySchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;

/** What `GET /api/v2/catalog` returns for one template (resolved address, nothing internal). */
export interface CatalogItem {
  id: string;
  version: number;
  name: string;
  nameEn: string;
  aliases: string[];
  url: string;
  category: string;
  description: string;
  iconRef: string;
  iconSource: CatalogEntry['icon_source'];
  region: CatalogEntry['region'];
  updatedAt: string;
  verified: boolean;
}

export interface CatalogResponse {
  catalogVersion: string;
  categories: (CatalogCategory & { count: number })[];
  items: CatalogItem[];
  /** Opaque; null when this was the last page. */
  nextCursor: string | null;
}

/** Categories every public catalog must cover (requirements §8.2). */
export const REQUIRED_CATALOG_CATEGORIES = ['search', 'mail', 'ai', 'office', 'dev', 'learn', 'design', 'video', 'news'] as const;

/** Operator-private services: never in the public catalog, whatever they are called there. */
const OPERATOR_PRIVATE = /(?:^|[^a-z])(?:litebox|linkwarden)(?:[^a-z]|$)/i;
const OLD_PRIVATE_NAME = /^obsync$/i;
/** Hosts that only make sense on someone's own network. */
const PRIVATE_HOST = /(?:^localhost$|\.(?:home|local|lan|internal|localhost|intranet|corp)$)/i;
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;
const PLACEHOLDER_HOST = /(?:^|\.)example\.(?:com|org|net)$/i;

const SOURCE_FOR_REF = (ref: string): CatalogEntry['icon_source'] =>
  ref === 'fav' ? 'favicon' : ref === 'letter' ? 'letter' : ref.startsWith('di:') ? 'dashboard-icons' : ref.startsWith('si:') ? 'simple-icons' : 'nexus-builtin';

/**
 * Build-time check of a catalog document (run by `npm run catalog:check`, the server build and the
 * unit tests). Returns every problem found, in Chinese, so one run shows all of them.
 */
export function validateCatalog(input: unknown): { errors: string[]; doc: CatalogDocument | null } {
  const parsed = CatalogDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`), doc: null };
  }
  const doc = parsed.data;
  const errors: string[] = [];
  const cats = new Set<string>();
  for (const c of doc.categories) {
    if (cats.has(c.id)) errors.push(`分类 ${c.id} 重复`);
    cats.add(c.id);
  }
  const ids = new Set<string>();
  const urls = new Map<string, string>();
  for (const e of doc.entries) {
    const at = `条目 ${e.stable_id}`;
    if (ids.has(e.stable_id)) errors.push(`${at}: stable_id 重复`);
    ids.add(e.stable_id);
    if (!cats.has(e.category)) errors.push(`${at}: 分类 ${e.category} 不存在`);
    if (SOURCE_FOR_REF(e.icon_ref) !== e.icon_source) errors.push(`${at}: icon_source 应为 ${SOURCE_FOR_REF(e.icon_ref)}（与 icon_ref ${e.icon_ref} 对应）`);
    if (e.visibility !== 'public') errors.push(`${at}: 公共目录只能包含 visibility=public 的条目；运营者私有入口留在管理员自己的收藏里`);
    const text = [e.stable_id, e.name, e.name_en, ...e.aliases, e.url];
    if (text.some((t) => OPERATOR_PRIVATE.test(t)) || OLD_PRIVATE_NAME.test(e.stable_id) || OLD_PRIVATE_NAME.test(e.name)) {
      errors.push(`${at}: 运营者私有服务（LiteBox / Linkwarden / OBsync）不能出现在公共目录`);
    }
    const lower = new Set<string>();
    for (const a of [e.name, ...e.aliases]) {
      const k = a.toLowerCase();
      if (lower.has(k)) errors.push(`${at}: 别名「${a}」重复`);
      lower.add(k);
    }
    let u: URL | null = null;
    try {
      u = new URL(e.url);
    } catch {
      errors.push(`${at}: url 不是有效地址`);
    }
    if (u) {
      if (u.protocol !== 'https:') errors.push(`${at}: url 必须使用 https`);
      if (u.username || u.password) errors.push(`${at}: url 不能包含用户名或密码`);
      if (PRIVATE_HOST.test(u.hostname) || IP_LITERAL.test(u.hostname)) errors.push(`${at}: url 指向内网或本机地址`);
      if (e.url_from_env && !PLACEHOLDER_HOST.test(u.hostname)) errors.push(`${at}: 由 ${e.url_from_env} 提供地址的条目，url 只能是 example.com 占位地址`);
      if (!e.url_from_env && PLACEHOLDER_HOST.test(u.hostname)) errors.push(`${at}: url 不能是 example.com 占位地址`);
      const canon = canonicalUrl(e.url);
      if (canon && e.status === 'active' && !e.url_from_env) {
        const other = urls.get(canon);
        if (other) errors.push(`${at}: 与 ${other} 的地址相同`);
        else urls.set(canon, e.stable_id);
      }
    }
    if (e.verification.status !== 'unverified' && !e.verification.checked_at) errors.push(`${at}: 核验结果缺少 checked_at`);
  }
  for (const c of REQUIRED_CATALOG_CATEGORIES) {
    if (!doc.entries.some((e) => e.category === c && e.status === 'active')) errors.push(`分类 ${c} 至少需要一个可用条目`);
  }
  const ls = doc.entries.find((e) => e.stable_id === 'litesync');
  if (!ls || ls.status !== 'active') errors.push('目录必须包含可用的 LiteSync 条目');
  else if (!ls.url_from_env) errors.push('LiteSync 条目的地址必须由部署配置（url_from_env）提供');
  return { errors, doc: errors.length ? null : doc };
}

/** Strict loader for the bundled document: an invalid catalog is a build error, not a runtime surprise. */
export function loadCatalog(input: unknown): CatalogDocument {
  const { errors, doc } = validateCatalog(input);
  if (!doc) throw new Error(`应用目录校验失败：\n- ${errors.join('\n- ')}`);
  return doc;
}

/**
 * The templates users may see: active, public, with deployment-specific addresses resolved.
 * An entry whose address variable is unset (or not https) is left out instead of pointing nowhere.
 */
export function servedCatalog(doc: CatalogDocument, env: Readonly<Record<string, string | undefined>>): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const e of doc.entries) {
    if (e.status !== 'active' || e.visibility !== 'public') continue;
    let url = e.url;
    if (e.url_from_env) {
      const v = env[e.url_from_env]?.trim();
      const canon = v ? canonicalUrl(v) : null;
      if (!canon || !canon.startsWith('https://')) continue;
      url = canon.replace(/\/$/, '');
    }
    out.push({
      id: e.stable_id,
      version: e.version,
      name: e.name,
      nameEn: e.name_en,
      aliases: e.aliases,
      url,
      category: e.category,
      description: e.description,
      iconRef: e.icon_ref,
      iconSource: e.icon_source,
      region: e.region,
      updatedAt: e.updated_at,
      verified: e.verification.status === 'reachable',
    });
  }
  return out;
}

/** The AppEntry icon a template's `icon_ref` maps to (the same sources AppTile already renders). */
export function catalogIcon(ref: string): Icon {
  if (ref.startsWith('di:')) return { source: 'library', ref: ref.slice(3), letter: '', tone: 0 };
  if (ref.startsWith('si:')) return { source: 'library', ref, letter: '', tone: 0 };
  if (ref.startsWith('builtin:')) return { source: 'builtin', ref: ref.slice(8), letter: '', tone: 1 };
  if (ref === 'letter') return { source: 'letter', ref: '', letter: '', tone: 0 };
  return { source: 'auto', ref: '', letter: '', tone: 0 };
}

function aliasesOf(item: CatalogItem): string[] {
  const out: string[] = [];
  const seen = new Set([item.name.toLowerCase()]);
  for (const a of [item.nameEn, ...item.aliases]) {
    const v = a.trim().slice(0, 32);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, 12);
}

/** A user's own copy of a template. The id is unique within `apps`; nothing is pinned here. */
export function catalogToApp(item: CatalogItem, apps: readonly AppEntry[], categoryId: string): AppEntry {
  return {
    id: newAppId(item.id, apps),
    kind: 'site',
    name: item.name,
    description: item.description.slice(0, 40),
    url: item.url,
    lanUrl: '',
    prefer: 'ext',
    categoryId,
    hidden: false,
    showInServices: true,
    aliases: aliasesOf(item),
    icon: catalogIcon(item.iconRef),
    openIn: 'same',
    health: { enabled: false, target: '/', intervalSec: 60 },
    catalogId: item.id,
    catalogVersion: item.version,
  };
}

export type CatalogState = 'new' | 'added' | 'same-url';

/**
 * A site's front page, keyed by host without `www.` — `https://bilibili.com` and
 * `https://www.bilibili.com/` are one site. Anything with a path, query or fragment is a specific
 * page and gets no key (never merged with the front page or with other pages).
 */
function frontPageKey(url: string): string | null {
  const canon = canonicalUrl(url);
  if (!canon) return null;
  const u = new URL(canon);
  return u.pathname === '/' && !u.search && !u.hash ? u.host.replace(/^www\./, '') : null;
}

/**
 * `added`: copied from this template before. `same-url`: the user already saved this address
 * (exactly, or the same site's front page with or without `www.`). Only for the 已添加 hint and
 * for skipping duplicates when adding templates — bookmark de-duplication stays exact.
 */
export function catalogState(item: CatalogItem, apps: readonly AppEntry[]): CatalogState {
  if (apps.some((a) => a.catalogId === item.id)) return 'added';
  const canon = canonicalUrl(item.url);
  if (canon && apps.some((a) => canonicalUrl(a.url) === canon)) return 'same-url';
  const front = frontPageKey(item.url);
  if (front && apps.some((a) => frontPageKey(a.url) === front)) return 'same-url';
  return 'new';
}

export interface CatalogAddPlan {
  ops: Op[];
  /** Templates that will become new entries, with the ids they get. */
  added: { item: CatalogItem; appId: string }[];
  skipped: { item: CatalogItem; reason: 'added' | 'same-url' }[];
  /** Asked to pin, but the home page was full: added without pinning. */
  notPinned: { item: CatalogItem; appId: string }[];
}

/**
 * Ops that add the chosen templates to the user's collection. Pinning is off unless asked for
 * (新增收藏默认不固定到首页); already added templates and addresses the user saved before are
 * skipped rather than duplicated.
 */
export function planCatalogAdd(items: readonly CatalogItem[], config: Config, opts: { categoryId?: string; pin?: boolean } = {}): CatalogAddPlan {
  const valid = (id: string | undefined) => !!id && id !== LOCKED_CATEGORY.hosted && config.categories.some((k) => k.id === id);
  const categoryId = valid(opts.categoryId) ? opts.categoryId! : LOCKED_CATEGORY.none;
  const apps = [...config.apps];
  let pins = config.pins.length;
  const plan: CatalogAddPlan = { ops: [], added: [], skipped: [], notPinned: [] };
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const state = catalogState(item, apps);
    if (state !== 'new') {
      plan.skipped.push({ item, reason: state });
      continue;
    }
    const app = catalogToApp(item, apps, categoryId);
    apps.push(app);
    plan.ops.push({ type: 'app.upsert', app });
    plan.added.push({ item, appId: app.id });
    if (opts.pin) {
      if (pins < MAX_PINS) {
        plan.ops.push({ type: 'pin.add', appId: app.id });
        pins++;
      } else plan.notPinned.push({ item, appId: app.id });
    }
  }
  return plan;
}

const asApp = (item: CatalogItem): AppEntry => ({ ...catalogToApp(item, [], LOCKED_CATEGORY.none), id: item.id });

/**
 * 目录搜索: the same matcher as the home search (name, aliases incl. the English name, domain,
 * pinyin and initials when `pinyin` is available). An empty query lists the templates in
 * category order.
 */
export function searchCatalog(items: readonly CatalogItem[], query: string, opts: { category?: string | null; pinyin?: PinyinFn | null; order?: readonly CatalogCategory[] } = {}): CatalogItem[] {
  const pool = opts.category ? items.filter((i) => i.category === opts.category) : [...items];
  const q = query.trim();
  if (!q) {
    const rank = new Map((opts.order ?? []).map((c) => [c.id, c.order]));
    return pool.map((item, i) => ({ item, i })).sort((a, b) => (rank.get(a.item.category) ?? 999) - (rank.get(b.item.category) ?? 999) || a.i - b.i).map((x) => x.item);
  }
  const byId = new Map(pool.map((i) => [i.id, i]));
  const ranked = rankApps(pool.map(asApp), q, { pinyin: opts.pinyin ?? null });
  return ranked.map((m) => byId.get(m.app.id)!).filter(Boolean);
}

/** Display host of a template, e.g. `github.com`. */
export const catalogHost = (item: Pick<CatalogItem, 'url'>) => hostOf(item.url).replace(/^www\./, '');
