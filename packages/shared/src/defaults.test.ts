import { describe, expect, it } from 'vitest';
import { defaultConfig, newUserConfig } from './defaults';
import { normalizeConfig } from './ops';
import { ConfigSchema } from './schema';

describe('newUserConfig (公开注册用户模板)', () => {
  it('is a valid, already normalised configuration', () => {
    const c = newUserConfig();
    expect(ConfigSchema.safeParse(c).success).toBe(true);
    expect(normalizeConfig(c)).toEqual(c);
  });

  it('starts empty: nothing pinned, nothing collected, no self-hosted services', () => {
    const c = newUserConfig();
    expect(c.apps).toEqual([]);
    expect(c.pins).toEqual([]);
    expect(c.settings.home.showServices).toBe(false);
  });

  it('carries nothing of the operator’s private setup', () => {
    const c = newUserConfig();
    // Entries, engines and groups — the settings object only holds the (switched off) linkwarden flag.
    expect(JSON.stringify([c.apps, c.engines, c.categories, c.pins]).toLowerCase()).not.toMatch(/litebox|linkwarden|obsync|\.home\b/);
    expect(c.engines.every((e) => e.kind === 'web')).toBe(true);
    expect(c.settings.search.linkwarden).toBe(false);
    expect(c.engines.some((e) => e.id === c.settings.search.defaultEngine)).toBe(true);
  });

  it('leaves the self-hosted seed exactly as before', () => {
    const legacy = defaultConfig();
    expect(legacy.apps.filter((a) => a.kind === 'service').map((a) => a.id)).toEqual(['litebox', 'obsync', 'linkwarden']);
    expect(legacy.pins).toEqual(['github', 'gmail', 'youtube', 'bilibili', 'notion']);
  });
});
