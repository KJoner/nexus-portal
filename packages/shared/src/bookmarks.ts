import { z } from 'zod';
import { depthOf, GROUP_LIMITS, labelKey, placeGroup, UNFILED } from './groups';
import { ItemInputSchema, OpIdSchema } from './items';
import type { Category } from './schema';

/**
 * 浏览器书签导入 (UI v2 · v12.0.3 N2). The browser parses the bookmark file (the folders each
 * bookmark is in, outermost first: `path`) and sends the pages; the server — or the local collection —
 * builds the groups:
 *  - `folderMode: 'tree'` (the default of the new import page): the bookmark folders become groups,
 *    nested as in the file, under `parentId` (null: as root groups). A folder that already exists AT
 *    THE SAME PLACE (same names from the import's root down) is used, not recreated; the same leaf
 *    name somewhere else is a different group. Deeper than the limit: the pages go to the deepest
 *    allowed group; over the group limit: to the nearest group that could be made — both listed in
 *    the preview (`dryRun`), nothing flattened silently.
 *  - `folderMode: 'single'` (older pages): everything into `folderId`, folder names as tags.
 * One transaction; 撤销本次导入 removes what it added (pages unchanged since, groups left empty).
 */
export const BookmarkImportSchema = z.object({
  opId: OpIdSchema,
  folderMode: z.enum(['single', 'tree']).default('single'),
  /** single: the group for everything (an existing one), or 未分组. */
  folderId: z.string().max(64).optional(),
  /** tree: the group the file's top-level folders go under (null / absent: root groups). */
  parentId: z.string().max(64).nullable().optional(),
  items: z.array(ItemInputSchema.extend({ kind: z.enum(['app', 'page']).default('page'), path: z.array(z.string().max(200)).max(64).optional() })).min(1).max(5000),
  /** Addresses already in the collection are skipped unless asked otherwise. */
  skipDuplicates: z.boolean().default(true),
  /** The preview: what would be created and where, nothing written. */
  dryRun: z.boolean().default(false),
});
export type BookmarkImportRequest = z.input<typeof BookmarkImportSchema>;

const clip = (s: string, n: number) => [...s.trim()].slice(0, n).join('').trim();
/** A path as a key (labels as they compare among siblings). */
export const pathKey = (path: readonly string[]) => path.map(labelKey).join('\u0000');

export interface BookmarkTreePlan {
  /** The groups after the import (created ones placed after their siblings). */
  categories: Category[];
  created: { id: string; label: string; parentId: string | null; path: string[] }[];
  /** Folders of the file that are groups already (same place, same names). */
  matched: { path: string[]; id: string }[];
  /** Group of each folder path of the file (pathKey → group id; '' → the import's root). */
  groupOf: Map<string, string>;
  /** Folder paths deeper than the limit (their pages go to the deepest allowed group). */
  overDepth: string[];
  /** Folders that could not be created (group limit): their pages go to the nearest planned group. */
  overLimit: number;
}

/**
 * Plans the groups of a bookmark import: the folder paths (outermost first) under `parentId`.
 * `newId` gives an unused group id. Pure: the caller writes `categories` and the items.
 */
export function planBookmarkTree(categories: readonly Category[], paths: readonly (readonly string[])[], parentId: string | null, newId: () => string): BookmarkTreePlan {
  let groups = [...categories];
  const root = parentId && groups.some((k) => k.id === parentId) && parentId !== UNFILED ? parentId : null;
  const plan: BookmarkTreePlan = { categories: groups, created: [], matched: [], groupOf: new Map([['', root ?? UNFILED]]), overDepth: [], overLimit: 0 };
  const done = new Set<string>();
  for (const raw of paths) {
    const path = raw.map((l) => clip(l, 16)).filter(Boolean);
    let at: string | null = root;
    const walked: string[] = [];
    for (const label of path) {
      walked.push(label);
      const key = pathKey(walked);
      if (plan.groupOf.has(key)) {
        const g = plan.groupOf.get(key)!;
        at = g === UNFILED ? null : g;
        continue;
      }
      const existing = groups.find((k) => k.id !== UNFILED && (k.parentId ?? null) === at && labelKey(k.label) === labelKey(label));
      if (existing) {
        plan.groupOf.set(key, existing.id);
        if (!done.has(key)) plan.matched.push({ path: [...walked], id: existing.id });
        done.add(key);
        at = existing.id;
        continue;
      }
      if (depthOf(groups, at) + 1 > GROUP_LIMITS.depth) {
        // Too deep: this folder and those below it are the deepest allowed group.
        plan.groupOf.set(key, at ?? UNFILED);
        if (!plan.overDepth.includes(walked.join(' / '))) plan.overDepth.push(walked.join(' / '));
        continue;
      }
      if (groups.length >= GROUP_LIMITS.total) {
        plan.groupOf.set(key, at ?? UNFILED);
        plan.overLimit++;
        continue;
      }
      const group: Category = { id: newId(), label, locked: false, parentId: at };
      groups = placeGroup(groups, group);
      plan.created.push({ id: group.id, label, parentId: at, path: [...walked] });
      plan.groupOf.set(key, group.id);
      at = group.id;
    }
  }
  plan.categories = groups;
  return plan;
}

/** The group a page of the file goes to (its path's group, else the import's root, else 未分组). */
export function bookmarkGroup(plan: BookmarkTreePlan, path: readonly string[] | undefined): string {
  const labels = (path ?? []).map((l) => clip(l, 16)).filter(Boolean);
  for (let n = labels.length; n > 0; n--) {
    const g = plan.groupOf.get(pathKey(labels.slice(0, n)));
    if (g) return g;
  }
  return plan.groupOf.get('') ?? UNFILED;
}

/** A free group id (`g` + 10 letters / digits) not in `taken`. */
export function newGroupId(taken: ReadonlySet<string>): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let s = 'g';
    for (const b of crypto.getRandomValues(new Uint8Array(10))) s += alphabet[b % alphabet.length];
    if (!taken.has(s)) return s;
  }
}

/** The groups a bookmark import creates or uses (preview and result). */
export interface BookmarkImportFolders {
  create: { id: string; label: string; parentId: string | null; path: string[] }[];
  matched: { path: string[]; id: string }[];
  overDepth: string[];
  overLimit: number;
}

/** The preview of a bookmark import (`dryRun`): nothing written; `basis` is the revision it saw. */
export interface BookmarkImportPreview {
  dryRun: true;
  importId: null;
  imported: number;
  skipped: number;
  folders: BookmarkImportFolders | null;
  basis: number;
}

/** What a bookmark import did. `undo`: the groups it created (撤销本次导入 removes them when empty). */
export interface BookmarkImportAnswer {
  importId: string;
  imported: number;
  skipped: number;
  folders?: BookmarkImportFolders;
  undo?: { folders: { id: string; label: string }[]; pins: string[] };
  ownerRevision?: number;
}
