/**
 * One WebExtensions API for Chrome, Edge and Firefox (批次 G). Firefox's promise-based API is
 * `browser`; Chrome and Edge use `chrome` (promise-based in MV3 as well). Everything in the
 * extension calls `ext.*`, never `chrome.*` directly, so the same code runs everywhere.
 */
type Api = typeof chrome;
const g = globalThis as { browser?: Api; chrome?: Api };

export const isFirefox = typeof g.browser !== 'undefined' && !!g.browser?.runtime?.getURL && g.browser !== g.chrome;
export const ext: Api = (isFirefox ? g.browser : g.chrome)!;

/**
 * contextMenus.removeAll: Chrome before 123 only takes a callback, Firefox's `browser.*` only
 * returns a promise (and rejects an extra argument). Resolves once the menus are gone.
 */
export function removeAllMenus(): Promise<void> {
  if (isFirefox) return Promise.resolve(ext.contextMenus.removeAll()).then(() => undefined);
  return new Promise((resolve) => ext.contextMenus.removeAll(() => resolve()));
}
