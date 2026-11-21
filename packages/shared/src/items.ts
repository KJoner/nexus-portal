import { z } from 'zod';
import { canonicalUrl } from './url';

/**
 * 我的收藏 (v0.4 · 需求 §8.3, 契约 §6): one personal item model for apps and saved pages. Items
 * live in their own table with row versions; the home page's `config.apps`/`config.pins` are a
 * view over them (pinned items, and items of kind `app`), so older clients keep working.
 */
export const ITEM_LIMITS = { title: 200, note: 2000, tags: 20, tag: 32, url: 2048 } as const;

export type ItemKind = 'app' | 'page';
export type ItemSource = 'manual' | 'catalog' | 'extension' | 'import' | 'legacy';

export interface Item {
  id: string;
  kind: ItemKind;
  source: ItemSource;
  catalogId: string | null;
  title: string;
  url: string;
  /** A category of the configuration (`none` = 未分类 / 收件箱). */
  folderId: string;
  tags: string[];
  note: string;
  iconRef: string;
  /** Row version: every change adds one; PATCH compares against it (baseVersion). */
  version: number;
  pinned: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
  /** Set when deleted (a tombstone): restore is a separate, explicit operation. */
  deletedAt: number | null;
  importId: string | null;
}

const Title = z.string().trim().min(1).max(ITEM_LIMITS.title);
const Tags = z.array(z.string().trim().min(1).max(ITEM_LIMITS.tag)).max(ITEM_LIMITS.tags);
const FolderId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i);
/** Only http(s), never with a user name or password (需求 §8.3); kept exactly as given otherwise. */
export const ItemUrl = z
  .string()
  .trim()
  .max(ITEM_LIMITS.url)
  .refine((u) => canonicalUrl(u) !== null, '只能收藏 http 或 https 网址，且不能包含用户名或密码');

export const ItemInputSchema = z.object({
  kind: z.enum(['app', 'page']).default('page'),
  title: Title,
  url: ItemUrl,
  folderId: FolderId.optional(),
  tags: Tags.default([]),
  note: z.string().max(ITEM_LIMITS.note).default(''),
  iconRef: z.string().max(256).default(''),
  catalogId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).optional(),
});
export type ItemInput = z.input<typeof ItemInputSchema>;

/** Fields a PATCH may change (field-level CAS against baseVersion, 契约 §6). */
export const ItemPatchSchema = z
  .object({
    title: Title,
    url: ItemUrl,
    folderId: FolderId,
    tags: Tags,
    note: z.string().max(ITEM_LIMITS.note),
    iconRef: z.string().max(256),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, '没有要修改的字段');
export type ItemPatch = z.infer<typeof ItemPatchSchema>;
export type ItemField = keyof ItemPatch;

export const OpIdSchema = z.string().min(8).max(80).regex(/^[A-Za-z0-9_.:-]+$/);

export const CreateItemSchema = z.object({
  opId: OpIdSchema,
  source: z.enum(['manual', 'catalog', 'extension', 'import']).default('manual'),
  item: ItemInputSchema,
  pinToHome: z.boolean().default(false),
  /** `prompt`: an existing item with the same address is reported (409 DUPLICATE) instead of saved twice. */
  duplicatePolicy: z.enum(['prompt', 'update', 'create']).default('prompt'),
});

export const PatchItemSchema = z.object({ opId: OpIdSchema, baseVersion: z.number().int().min(1), patch: ItemPatchSchema });

export interface ItemWriteResult {
  item: Item;
  result: 'created' | 'updated' | 'deleted' | 'restored' | 'unchanged';
  /** The account's configuration revision after the write (the home page view changes with it). */
  ownerRevision: number;
}

export interface ItemChange {
  seq: number;
  entity: 'item' | 'pins' | 'folders';
  id: string;
  version: number;
  action: 'upsert' | 'delete' | 'restore' | 'pins';
  /** The item as it is now (for `item` changes), so a client applies a page without more requests. */
  item?: Item;
}

export interface ChangesResponse {
  changes: ItemChange[];
  nextCursor: string;
  hasMore: boolean;
}

export interface SnapshotResponse {
  items: Item[];
  /** Ordered item ids pinned to the home page (shared layout). */
  pins: string[];
  folders: { id: string; label: string; locked: boolean }[];
  /** The change sequence this snapshot is consistent with; changes continue from `cursor`. */
  watermark: number;
  cursor: string;
  /** More pages of this snapshot (same watermark). */
  nextPage: string | null;
}

/** Duplicate detection (需求 §8.3): within one account, conservative canonical form. */
export const itemUrlKey = (url: string) => canonicalUrl(url) ?? url;
