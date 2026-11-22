import { httpTransport } from '../transport';
import { bundledCatalog } from './catalog';
import { idbLocalStore } from './store';
import { localTransport, type LocalTransport } from './transport';

/**
 * The portal's local collection (IndexedDB `nexus-local` of the portal's origin). 应用目录 asks the
 * portal's public catalog first (it knows this deployment's LiteSync address) and falls back to the
 * copy that ships with the app within a few seconds — offline, or with the server down.
 */
let instance: LocalTransport | null = null;

const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** The local collection of this page: the portal's own, or the one a host (the extension) set. */
export function webLocalTransport(): LocalTransport {
  instance ??= localTransport({ store: idbLocalStore(), bundledCatalog, onlineCatalog: () => within(httpTransport.catalog(), 3000) });
  return instance;
}

/** The browser extension runs the same pages over its own collection (no portal to ask for the catalog). */
export function setLocalTransport(t: LocalTransport) {
  instance = t;
}
