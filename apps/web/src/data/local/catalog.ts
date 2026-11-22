import { servedCatalog, type CatalogResponse } from '@nexus/shared';

/**
 * 应用目录 that ships with the app (v0.5 · U1): the public catalog file, filtered exactly as the
 * server serves it — public, active entries only; an entry whose address is deployment-specific
 * (LiteSync) is left out, the portal's online catalog adds it. Loaded on first use (its own chunk),
 * so a local collection can browse and add templates with no server at all.
 */
let loaded: Promise<CatalogResponse> | null = null;

export function bundledCatalog(): Promise<CatalogResponse> {
  loaded ??= import('@nexus/shared/catalog-data').then(({ CATALOG }) => {
    const items = servedCatalog(CATALOG, {});
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    return {
      catalogVersion: CATALOG.catalogVersion,
      categories: CATALOG.categories.filter((c) => counts.has(c.id)).map((c) => ({ ...c, count: counts.get(c.id)! })),
      items,
      nextCursor: null,
    };
  });
  return loaded;
}
