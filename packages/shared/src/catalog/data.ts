import raw from './catalog.json';
import { loadCatalog } from './catalog';

/**
 * The bundled public catalog, validated when it is loaded (an invalid file fails the build and the
 * tests, never a running server). Server-only entry point: `@nexus/shared/catalog-data`.
 */
export const CATALOG = loadCatalog(raw);
