// The manifest per browser (批次 G). Chrome and Edge share one MV3 manifest (Edge without the key);
// Firefox needs its own: an event page instead of a service worker, its add-on ID and minimum
// version, and no Chrome-only fields. Used by the build (vite.config.ts) and by the tests.

/** Firefox add-on ID: stable, needed for storage and for signing on addons.mozilla.org. */
export const FIREFOX_ID = 'nexus-portal@nexus-portal.extensions';

export function firefoxManifest(m) {
  const { key: _key, minimum_chrome_version: _min, background, ...rest } = m;
  return {
    ...rest,
    // Firefox MV3 runs background scripts as an event page (no service workers yet).
    background: { scripts: [background.service_worker], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_ID,
        // 140: the first desktop release that reads data_collection_permissions (required by
        // addons.mozilla.org for new add-ons). Desktop only: Firefox for Android has no new-tab override.
        strict_min_version: '140.0',
        // Sent only when the person saves a page: its address and title, to the server they
        // connected (their own Nexus). Reviewed again before submitting to addons.mozilla.org.
        data_collection_permissions: { required: ['bookmarksInfo'] },
      },
    },
  };
}

export function edgeManifest(m) {
  const { key: _key, ...rest } = m;
  return rest;
}
