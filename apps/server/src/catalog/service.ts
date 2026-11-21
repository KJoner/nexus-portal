import { searchCatalog, servedCatalog, type CatalogDocument, type CatalogItem, type CatalogResponse } from '@nexus/shared';
import { CATALOG } from '@nexus/shared/catalog-data';
import { createHash } from 'node:crypto';

export const CATALOG_PAGE_MAX = 200;

export class CatalogCursorError extends Error {}

/**
 * The public 应用目录 as served to every visitor (`GET /api/v2/catalog`). Built once at start: the
 * catalog only changes with a release, and the only deployment input is the LiteSync address.
 * Nothing here is per user — whether a template is already in someone's collection is worked
 * out by their own client against their own data.
 */
export class CatalogService {
  readonly items: CatalogItem[];
  readonly etag: string;
  readonly version: string;

  constructor(
    env: { litesyncUrl: string | null },
    private doc: CatalogDocument = CATALOG,
  ) {
    this.items = servedCatalog(doc, { NEXUS_LITESYNC_URL: env.litesyncUrl ?? undefined });
    this.version = doc.catalogVersion;
    const digest = createHash('sha256').update(JSON.stringify(this.items)).digest('base64url').slice(0, 16);
    this.etag = `"catalog-${doc.catalogVersion}-${digest}"`;
  }

  private cursor(offset: number): string {
    return Buffer.from(`${this.version}:${offset}`).toString('base64url');
  }

  private offsetOf(cursor: string): number {
    const [version, n] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const offset = Number(n);
    // A cursor from another catalog version would skip or repeat templates: start over instead.
    if (version !== this.version || !Number.isInteger(offset) || offset < 0) throw new CatalogCursorError('目录已更新或游标无效，请从第一页重新加载');
    return offset;
  }

  query(opts: { q?: string; category?: string; cursor?: string; limit?: number }): CatalogResponse {
    const limit = Math.max(1, Math.min(CATALOG_PAGE_MAX, Math.floor(opts.limit ?? CATALOG_PAGE_MAX)));
    const category = opts.category?.trim() || null;
    const matches = searchCatalog(this.items, opts.q ?? '', { category, order: this.doc.categories });
    const offset = opts.cursor ? this.offsetOf(opts.cursor) : 0;
    const page = matches.slice(offset, offset + limit);
    const counts = new Map<string, number>();
    for (const i of this.items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    return {
      catalogVersion: this.version,
      categories: this.doc.categories.filter((c) => counts.has(c.id)).map((c) => ({ ...c, count: counts.get(c.id)! })),
      items: page,
      nextCursor: offset + limit < matches.length ? this.cursor(offset + limit) : null,
    };
  }
}
