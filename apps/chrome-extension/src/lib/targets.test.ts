import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeManifest, FIREFOX_ID, firefoxManifest } from '../../scripts/manifest-targets.mjs';

/**
 * 批次 G · one code base, three browsers. The manifests differ only where the browsers differ;
 * the permissions are the same everywhere (需求 §9.1), and the code reaches the API through `ext`.
 */
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../manifest.json'), 'utf8')) as Record<string, unknown> & { permissions: string[]; background: { service_worker: string } };

describe('manifest per browser', () => {
  it('Firefox: an event page, its own add-on ID and minimum version, no Chrome-only keys, same permissions', () => {
    const f = firefoxManifest(manifest) as Record<string, unknown> & { background: unknown; browser_specific_settings: { gecko: Record<string, unknown> } };
    expect(f.background).toEqual({ scripts: [manifest.background.service_worker], type: 'module' });
    expect(f.browser_specific_settings.gecko).toMatchObject({ id: FIREFOX_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['bookmarksInfo'] } });
    expect(f).not.toHaveProperty('key');
    expect(f).not.toHaveProperty('minimum_chrome_version');
    expect(f.permissions).toEqual(['storage', 'activeTab', 'contextMenus']);
    expect(f).not.toHaveProperty('host_permissions');
    expect(f.optional_host_permissions).toEqual(manifest.optional_host_permissions);
    expect(f.chrome_url_overrides).toEqual({ newtab: 'newtab.html' });
    expect(f.action).toEqual(manifest.action);
  });

  it('Edge: the Chrome manifest without the key (the Edge store assigns the ID)', () => {
    const e = edgeManifest(manifest);
    expect(e).not.toHaveProperty('key');
    expect({ ...e, key: manifest.key }).toEqual(manifest);
  });
});

describe('ext: one API object for every browser', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as { browser?: unknown }).browser;
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('Firefox’s promise-based `browser` is used when present; otherwise `chrome`', async () => {
    const chromeApi = { runtime: { getURL: () => 'chrome-extension://x/' }, contextMenus: { removeAll: (cb: () => void) => cb() } };
    const browserApi = { runtime: { getURL: () => 'moz-extension://x/' }, contextMenus: { removeAll: () => Promise.resolve() } };
    (globalThis as { chrome?: unknown }).chrome = chromeApi;
    expect((await import('./ext')).ext).toBe(chromeApi);
    vi.resetModules();
    (globalThis as { browser?: unknown }).browser = browserApi;
    const mod = await import('./ext');
    expect(mod.ext).toBe(browserApi);
    expect(mod.isFirefox).toBe(true);
    // Firefox's removeAll takes no callback and returns a promise; Chrome's is called back.
    await expect(mod.removeAllMenus()).resolves.toBeUndefined();
  });
});
