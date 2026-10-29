import { z } from 'zod';
import {
  AppSchema,
  CategorySchema,
  ConfigSchema,
  EngineSchema,
  LOCKED_CATEGORY,
  MAX_PINS,
  SettingsSchema,
  type AppEntry,
  type Category,
  type Config,
  type Engine,
  type Settings,
  type SettingsSection,
} from './schema';

/**
 * Intent-based configuration changes. The same reducer runs in the browser (optimistic update)
 * and on the server (authoritative write), so concurrent edits from two devices merge by intent
 * instead of overwriting each other.
 */
export type Op =
  | { type: 'pin.add'; appId: string; index?: number }
  | { type: 'pin.remove'; appId: string }
  | { type: 'pin.move'; appId: string; toIndex: number }
  | { type: 'pin.reorder'; order: string[] }
  | { type: 'app.setHidden'; appId: string; hidden: boolean }
  | { type: 'service.setShown'; appId: string; shown: boolean }
  | { type: 'app.upsert'; app: AppEntry; index?: number }
  | { type: 'app.delete'; appId: string }
  /** Moves an app to `toIndex` among the apps of `categoryId` (default: its own category). */
  | { type: 'app.move'; appId: string; toIndex: number; categoryId?: string }
  | { type: 'categories.replace'; categories: Category[] }
  | { type: 'category.move'; categoryId: string; toIndex: number }
  | { type: 'engine.upsert'; engine: Engine; index?: number }
  | { type: 'engine.delete'; engineId: string }
  | { type: 'engine.move'; engineId: string; toIndex: number }
  | { type: 'settings.patch'; section: SettingsSection; patch: Record<string, unknown> }
  | { type: 'config.replace'; config: Config };

const IdRef = z.string().min(1).max(64);
const Index = z.number().int().min(-1000).max(1000);

/**
 * Structural check for ops arriving over the network. Payloads (app, engine, categories, config)
 * stay `unknown` here because `applyOp` validates them against their full schemas.
 */
export const OpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pin.add'), appId: IdRef, index: Index.optional() }),
  z.object({ type: z.literal('pin.remove'), appId: IdRef }),
  z.object({ type: z.literal('pin.move'), appId: IdRef, toIndex: Index }),
  z.object({ type: z.literal('pin.reorder'), order: z.array(IdRef).max(200) }),
  z.object({ type: z.literal('app.setHidden'), appId: IdRef, hidden: z.boolean() }),
  z.object({ type: z.literal('service.setShown'), appId: IdRef, shown: z.boolean() }),
  z.object({ type: z.literal('app.upsert'), app: z.unknown(), index: Index.optional() }),
  z.object({ type: z.literal('app.delete'), appId: IdRef }),
  z.object({ type: z.literal('app.move'), appId: IdRef, toIndex: Index, categoryId: IdRef.optional() }),
  z.object({ type: z.literal('categories.replace'), categories: z.array(z.unknown()).max(50) }),
  z.object({ type: z.literal('category.move'), categoryId: IdRef, toIndex: Index }),
  z.object({ type: z.literal('engine.upsert'), engine: z.unknown(), index: Index.optional() }),
  z.object({ type: z.literal('engine.delete'), engineId: IdRef }),
  z.object({ type: z.literal('engine.move'), engineId: IdRef, toIndex: Index }),
  z.object({ type: z.literal('settings.patch'), section: z.enum(['search', 'home', 'look', 'privacy', 'ui']), patch: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('config.replace'), config: z.unknown() }),
]);

export const OpBatchSchema = z.object({
  clientId: z.string().min(1).max(64),
  batchId: z.string().min(1).max(64),
  ops: z.array(OpSchema).min(1).max(100),
});
export type OpBatch = { clientId: string; batchId: string; ops: Op[] };

export type OpErrorCode = 'not_found' | 'pins_full' | 'not_pinnable' | 'invalid' | 'locked';

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function findApp(c: Config, id: string): AppEntry {
  const a = c.apps.find((x) => x.id === id);
  if (!a) throw new OpError('not_found', `应用 ${id} 不存在`);
  return a;
}

function insertAt<T>(list: readonly T[], item: T, index: number | undefined): T[] {
  const out = [...list];
  out.splice(index === undefined ? out.length : clamp(index, 0, out.length), 0, item);
  return out;
}

/**
 * Stable sort of `apps` into contiguous blocks following the category order. Within a block the
 * array order is the user's manual order; keeping the blocks contiguous makes every move (and its
 * undo) land at one well-defined array position.
 */
export function groupByCategory(apps: readonly AppEntry[], categories: readonly Category[]): AppEntry[] {
  const rank = new Map(categories.map((k, i) => [k.id, i]));
  const r = (a: AppEntry) => rank.get(a.categoryId) ?? categories.length;
  const sorted = apps.map((a, i) => ({ a, i })).sort((x, y) => r(x.a) - r(y.a) || x.i - y.i);
  return sorted.every((x, i) => x.i === i) ? [...apps] : sorted.map((x) => x.a);
}

/** Inserts `app` as the `index`-th app of its category (clamped; `Infinity` = last) in grouped `apps`. */
function placeIn(apps: AppEntry[], app: AppEntry, index: number, categories: readonly Category[]): AppEntry[] {
  const peers = apps.filter((a) => a.categoryId === app.categoryId);
  const j = Math.max(0, Math.min(index, peers.length));
  let at: number;
  if (j < peers.length) at = apps.indexOf(peers[j]!);
  else if (peers.length) at = apps.indexOf(peers.at(-1)!) + 1;
  else {
    // Empty category: its block starts before the first app of a later category.
    const rank = new Map(categories.map((k, i) => [k.id, i]));
    const mine = rank.get(app.categoryId) ?? categories.length;
    at = apps.findIndex((a) => (rank.get(a.categoryId) ?? categories.length) > mine);
    if (at < 0) at = apps.length;
  }
  const out = [...apps];
  out.splice(at, 0, app);
  return out;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new OpError('invalid', i ? `${i.path.join('.') || 'value'}: ${i.message}` : 'invalid');
  }
  return r.data;
}

/** Applies one op immutably. Throws `OpError` when the op cannot apply; no-ops return the same object. */
export function applyOp(c: Config, op: Op): Config {
  switch (op.type) {
    case 'pin.add': {
      const app = findApp(c, op.appId);
      if (app.kind !== 'site' || app.hidden) throw new OpError('not_pinnable', `${app.name} 不能固定到首页`);
      if (c.pins.includes(app.id)) return c;
      if (c.pins.length >= MAX_PINS) throw new OpError('pins_full', `首页最多固定 ${MAX_PINS} 个网站`);
      return { ...c, pins: insertAt(c.pins, app.id, op.index) };
    }
    case 'pin.remove':
      return c.pins.includes(op.appId) ? { ...c, pins: c.pins.filter((x) => x !== op.appId) } : c;
    case 'pin.move': {
      const i = c.pins.indexOf(op.appId);
      if (i < 0) return c;
      const j = clamp(op.toIndex, 0, c.pins.length - 1);
      if (i === j) return c;
      const pins = c.pins.filter((x) => x !== op.appId);
      pins.splice(j, 0, op.appId);
      return { ...c, pins };
    }
    case 'pin.reorder': {
      // Keep only ids that are still pinned, then append pins this client did not know about.
      const known = op.order.filter((id, k) => c.pins.includes(id) && op.order.indexOf(id) === k);
      const pins = [...known, ...c.pins.filter((id) => !known.includes(id))];
      return pins.every((id, k) => id === c.pins[k]) ? c : { ...c, pins };
    }
    case 'app.setHidden': {
      const app = findApp(c, op.appId);
      if (app.hidden === op.hidden) return c;
      return {
        ...c,
        apps: c.apps.map((a) => (a.id === app.id ? { ...a, hidden: op.hidden } : a)),
        pins: op.hidden ? c.pins.filter((x) => x !== app.id) : c.pins,
      };
    }
    case 'service.setShown': {
      const app = findApp(c, op.appId);
      if (app.kind !== 'service' || app.showInServices === op.shown) return c;
      return { ...c, apps: c.apps.map((a) => (a.id === app.id ? { ...a, showInServices: op.shown } : a)) };
    }
    case 'app.upsert': {
      const app = parse(AppSchema, op.app);
      if (!c.categories.some((k) => k.id === app.categoryId)) app.categoryId = LOCKED_CATEGORY.none;
      const prev = c.apps.find((a) => a.id === app.id);
      let apps: AppEntry[];
      if (prev && prev.categoryId === app.categoryId) apps = c.apps.map((a) => (a.id === app.id ? app : a));
      // An explicit index is an exact array position (undo of a delete).
      else if (!prev && op.index !== undefined) apps = insertAt(c.apps, app, op.index);
      // New app, or a new category: join the end of that category.
      else apps = placeIn(prev ? c.apps.filter((a) => a.id !== app.id) : c.apps, app, Infinity, c.categories);
      const unpin = app.kind !== 'site' || app.hidden;
      return { ...c, apps, pins: unpin ? c.pins.filter((x) => x !== app.id) : c.pins };
    }
    case 'app.delete': {
      if (!c.apps.some((a) => a.id === op.appId)) return c;
      return { ...c, apps: c.apps.filter((a) => a.id !== op.appId), pins: c.pins.filter((x) => x !== op.appId) };
    }
    case 'app.move': {
      const app = findApp(c, op.appId);
      const categoryId = op.categoryId ?? app.categoryId;
      if (categoryId !== app.categoryId) {
        if (!c.categories.some((k) => k.id === categoryId)) throw new OpError('not_found', '分类不存在');
        // Services always live under 我的服务, sites never move into it.
        if ((app.kind === 'service') !== (categoryId === LOCKED_CATEGORY.hosted)) throw new OpError('invalid', app.kind === 'service' ? '自托管服务只能放在「我的服务」' : '网站不能移到「我的服务」');
      }
      const moved = categoryId === app.categoryId ? app : { ...app, categoryId };
      const apps = placeIn(
        c.apps.filter((a) => a.id !== app.id),
        moved,
        op.toIndex,
        c.categories,
      );
      return apps.every((a, k) => a === c.apps[k]) ? c : { ...c, apps };
    }
    case 'category.move': {
      const i = c.categories.findIndex((k) => k.id === op.categoryId);
      if (i < 0) return c;
      const j = clamp(op.toIndex, 0, c.categories.length - 1);
      if (i === j) return c;
      const categories = [...c.categories];
      const [k] = categories.splice(i, 1);
      categories.splice(j, 0, k!);
      return { ...c, categories, apps: groupByCategory(c.apps, categories) };
    }
    case 'categories.replace': {
      const categories = op.categories.map((k) => parse(CategorySchema, k));
      for (const locked of Object.values(LOCKED_CATEGORY)) {
        if (!categories.some((k) => k.id === locked)) throw new OpError('locked', '「我的服务」与「未分类」不能删除');
      }
      const ids = new Set(categories.map((k) => k.id));
      const apps = c.apps.map((a) => (ids.has(a.categoryId) ? a : { ...a, categoryId: LOCKED_CATEGORY.none }));
      return { ...c, categories, apps: groupByCategory(apps, categories) };
    }
    case 'engine.upsert': {
      const engine = parse(EngineSchema, op.engine);
      const exists = c.engines.some((e) => e.id === engine.id);
      const engines = exists ? c.engines.map((e) => (e.id === engine.id ? engine : e)) : insertAt(c.engines, engine, op.index);
      return { ...c, engines };
    }
    case 'engine.delete': {
      const engine = c.engines.find((e) => e.id === op.engineId);
      if (!engine) return c;
      if (engine.builtin) throw new OpError('locked', '内置引擎不能删除');
      const engines = c.engines.filter((e) => e.id !== op.engineId);
      const search = c.settings.search.defaultEngine === op.engineId ? { ...c.settings.search, defaultEngine: engines[0]!.id } : c.settings.search;
      return { ...c, engines, settings: { ...c.settings, search } };
    }
    case 'engine.move': {
      const i = c.engines.findIndex((e) => e.id === op.engineId);
      if (i < 0) return c;
      const j = clamp(op.toIndex, 0, c.engines.length - 1);
      if (i === j) return c;
      const engines = [...c.engines];
      const [e] = engines.splice(i, 1);
      engines.splice(j, 0, e!);
      return { ...c, engines };
    }
    case 'settings.patch': {
      const shape = SettingsSchema.shape[op.section];
      if (!shape) throw new OpError('invalid', `未知设置分组 ${String(op.section)}`);
      const next = parse(shape as z.ZodType<Settings[typeof op.section]>, { ...c.settings[op.section], ...op.patch });
      if (op.section === 'search') {
        const s = next as Settings['search'];
        if (!c.engines.some((e) => e.id === s.defaultEngine)) throw new OpError('invalid', '默认引擎不存在');
      }
      return { ...c, settings: { ...c.settings, [op.section]: next } };
    }
    case 'config.replace':
      return normalizeConfig(parse(ConfigSchema, op.config));
  }
}

export function applyOps(c: Config, ops: readonly Op[]): Config {
  return ops.reduce(applyOp, c);
}

/** Repairs cross references that the schema alone cannot express. */
export function normalizeConfig(c: Config): Config {
  const ids = new Set(c.apps.map((a) => a.id));
  const catIds = new Set(c.categories.map((k) => k.id));
  const categories = [...c.categories];
  if (!catIds.has(LOCKED_CATEGORY.hosted)) categories.unshift({ id: LOCKED_CATEGORY.hosted, label: '我的服务', locked: true });
  if (!catIds.has(LOCKED_CATEGORY.none)) categories.push({ id: LOCKED_CATEGORY.none, label: '未分类', locked: true });
  const allCats = new Set(categories.map((k) => k.id));
  const apps = groupByCategory(
    c.apps.map((a) => (allCats.has(a.categoryId) ? a : { ...a, categoryId: LOCKED_CATEGORY.none })),
    categories,
  );
  const pinnable = new Set(apps.filter((a) => a.kind === 'site' && !a.hidden).map((a) => a.id));
  const pins = [...new Set(c.pins)].filter((id) => ids.has(id) && pinnable.has(id)).slice(0, MAX_PINS);
  const engines = c.engines.length ? c.engines : [];
  const defaultEngine = engines.some((e) => e.id === c.settings.search.defaultEngine) ? c.settings.search.defaultEngine : (engines[0]?.id ?? 'google');
  return { ...c, apps, categories, pins, settings: { ...c.settings, search: { ...c.settings.search, defaultEngine } } };
}

/** Moves `app` back to the category and position it has in `before`. */
function restorePlace(before: Config, app: AppEntry): Op {
  const index = before.apps.filter((a) => a.categoryId === app.categoryId).indexOf(app);
  return { type: 'app.move', appId: app.id, categoryId: app.categoryId, toIndex: index };
}

/**
 * Ops that undo `op` when applied after it. Computed from the state *before* `op` ran,
 * so that undo is itself an ordinary op that syncs like any other change.
 */
export function invertOp(before: Config, op: Op): Op[] {
  switch (op.type) {
    case 'pin.add':
      return before.pins.includes(op.appId) ? [] : [{ type: 'pin.remove', appId: op.appId }];
    case 'pin.remove': {
      const i = before.pins.indexOf(op.appId);
      return i < 0 ? [] : [{ type: 'pin.add', appId: op.appId, index: i }];
    }
    case 'pin.move': {
      const i = before.pins.indexOf(op.appId);
      return i < 0 ? [] : [{ type: 'pin.move', appId: op.appId, toIndex: i }];
    }
    case 'pin.reorder':
      return [{ type: 'pin.reorder', order: [...before.pins] }];
    case 'app.setHidden': {
      const app = before.apps.find((a) => a.id === op.appId);
      if (!app || app.hidden === op.hidden) return [];
      const out: Op[] = [{ type: 'app.setHidden', appId: op.appId, hidden: app.hidden }];
      const i = before.pins.indexOf(op.appId);
      if (i >= 0) out.push({ type: 'pin.add', appId: op.appId, index: i });
      return out;
    }
    case 'service.setShown': {
      const app = before.apps.find((a) => a.id === op.appId);
      return app ? [{ type: 'service.setShown', appId: op.appId, shown: app.showInServices }] : [];
    }
    case 'app.upsert': {
      const i = before.apps.findIndex((a) => a.id === op.app.id);
      if (i < 0) return [{ type: 'app.delete', appId: op.app.id }];
      const prev = before.apps[i]!;
      const out: Op[] = [{ type: 'app.upsert', app: prev }];
      // A category change moved it to the end of the new category; put it back where it was.
      if (op.app.categoryId !== prev.categoryId) out.push(restorePlace(before, prev));
      const p = before.pins.indexOf(op.app.id);
      if (p >= 0) out.push({ type: 'pin.add', appId: op.app.id, index: p });
      return out;
    }
    case 'app.move': {
      const app = before.apps.find((a) => a.id === op.appId);
      return app ? [restorePlace(before, app)] : [];
    }
    case 'category.move': {
      const i = before.categories.findIndex((k) => k.id === op.categoryId);
      return i < 0 ? [] : [{ type: 'category.move', categoryId: op.categoryId, toIndex: i }];
    }
    case 'app.delete': {
      const i = before.apps.findIndex((a) => a.id === op.appId);
      if (i < 0) return [];
      const out: Op[] = [{ type: 'app.upsert', app: before.apps[i]!, index: i }];
      const p = before.pins.indexOf(op.appId);
      if (p >= 0) out.push({ type: 'pin.add', appId: op.appId, index: p });
      return out;
    }
    case 'categories.replace': {
      const ids = new Set(op.categories.map((k) => k.id));
      const moved = before.apps.filter((a) => !ids.has(a.categoryId));
      return [{ type: 'categories.replace', categories: before.categories }, ...moved.flatMap((a): Op[] => [{ type: 'app.upsert', app: a }, restorePlace(before, a)])];
    }
    case 'engine.upsert': {
      const i = before.engines.findIndex((e) => e.id === op.engine.id);
      return i < 0 ? [{ type: 'engine.delete', engineId: op.engine.id }] : [{ type: 'engine.upsert', engine: before.engines[i]! }];
    }
    case 'engine.delete': {
      const i = before.engines.findIndex((e) => e.id === op.engineId);
      if (i < 0) return [];
      const out: Op[] = [{ type: 'engine.upsert', engine: before.engines[i]!, index: i }];
      if (before.settings.search.defaultEngine === op.engineId) out.push({ type: 'settings.patch', section: 'search', patch: { defaultEngine: op.engineId } });
      return out;
    }
    case 'engine.move': {
      const i = before.engines.findIndex((e) => e.id === op.engineId);
      return i < 0 ? [] : [{ type: 'engine.move', engineId: op.engineId, toIndex: i }];
    }
    case 'settings.patch': {
      const prev = before.settings[op.section] as Record<string, unknown>;
      const patch = Object.fromEntries(Object.keys(op.patch).map((k) => [k, prev[k]]));
      return [{ type: 'settings.patch', section: op.section, patch }];
    }
    case 'config.replace':
      return [{ type: 'config.replace', config: before }];
  }
}
