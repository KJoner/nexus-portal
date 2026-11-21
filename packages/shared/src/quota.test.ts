import { describe, expect, it } from 'vitest';
import { defaultConfig, newUserConfig } from './defaults';
import { applyOps, OpError, type Op } from './ops';
import { CONFIG_LIMITS, ConfigSchema, type AppEntry, type Config } from './schema';

/**
 * TN-07 · per-account limits of the configuration document. The same ops run in the browser
 * (before anything is sent, so a form keeps its draft) and on the server (inside the account's
 * transaction). Going over must be a clear, typed error — never a document that fails to validate.
 */
const site = (i: number): AppEntry => ({ ...defaultConfig().apps.find((a) => a.kind === 'site')!, id: `site-${i}`, name: `站点 ${i}`, url: `https://s${i}.example.org/`, catalogId: undefined });

function withApps(n: number): Config {
  const c = newUserConfig();
  return { ...c, apps: Array.from({ length: n }, (_, i) => ({ ...site(i), categoryId: c.categories[0]!.id })) };
}

function quotaOf(f: () => unknown) {
  try {
    f();
  } catch (e) {
    if (e instanceof OpError) return { code: e.code, quota: e.quota, message: e.message };
    throw e;
  }
  throw new Error('expected an OpError');
}

describe('configuration limits (TN-07)', () => {
  it('the 501st app is refused with kind, limit and how many are used; replacing an existing one is fine', () => {
    const full = withApps(CONFIG_LIMITS.apps);
    expect(ConfigSchema.safeParse(full).success).toBe(true);
    const r = quotaOf(() => applyOps(full, [{ type: 'app.upsert', app: site(9999) }]));
    expect(r).toMatchObject({ code: 'quota_exceeded', quota: { kind: 'apps', limit: 500, used: 500 } });
    expect(r.message).toContain('500');
    // Editing an app that already exists does not count as one more.
    const edited = applyOps(full, [{ type: 'app.upsert', app: { ...full.apps[0]!, name: '改名' } }]);
    expect(edited.apps).toHaveLength(500);
  });

  it('categories, engines and pins have their own limits', () => {
    const c = newUserConfig();
    const tooMany = Array.from({ length: CONFIG_LIMITS.categories + 1 }, (_, i) => ({ id: `k${i}`, label: `分类${i}`, locked: false }));
    expect(quotaOf(() => applyOps(c, [{ type: 'categories.replace', categories: tooMany } as Op]))).toMatchObject({ code: 'quota_exceeded', quota: { kind: 'categories', limit: 50 } });

    const engine = c.engines[0]!;
    const engines = Array.from({ length: CONFIG_LIMITS.engines }, (_, i) => ({ ...engine, id: `e${i}`, builtin: false, name: `引擎${i}` }));
    expect(quotaOf(() => applyOps({ ...c, engines }, [{ type: 'engine.upsert', engine: { ...engine, id: 'one-more', builtin: false } }]))).toMatchObject({ code: 'quota_exceeded', quota: { kind: 'engines', limit: 30, used: 30 } });

    const sites = withApps(CONFIG_LIMITS.pins + 1);
    const pinned = { ...sites, pins: sites.apps.slice(0, CONFIG_LIMITS.pins).map((a) => a.id) };
    // Pins keep their historical code (the home page reacts to it) and now say the same details.
    expect(quotaOf(() => applyOps(pinned, [{ type: 'pin.add', appId: sites.apps.at(-1)!.id }]))).toMatchObject({ code: 'pins_full', quota: { kind: 'pins', limit: 36, used: 36 } });
  });

  it('an import over a limit says which limit, before any schema message', () => {
    const big = withApps(CONFIG_LIMITS.apps + 1);
    expect(quotaOf(() => applyOps(newUserConfig(), [{ type: 'config.replace', config: big }]))).toMatchObject({ code: 'quota_exceeded', quota: { kind: 'apps', limit: 500, used: 501 } });
  });

  it('nothing over the limit is ever produced by ops: the result always validates', () => {
    let c = withApps(CONFIG_LIMITS.apps - 2);
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        c = applyOps(c, [{ type: 'app.upsert', app: site(1000 + i) }]);
        results.push('ok');
      } catch (e) {
        results.push((e as OpError).code);
      }
    }
    expect(results).toEqual(['ok', 'ok', 'quota_exceeded', 'quota_exceeded', 'quota_exceeded']);
    expect(ConfigSchema.safeParse(c).success).toBe(true);
  });
});
