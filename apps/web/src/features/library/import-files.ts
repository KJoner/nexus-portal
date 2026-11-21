import { canonicalUrl, ITEM_LIMITS, itemUrlKey, type ItemInput } from '@nexus/shared';

/**
 * 导入预览 (需求 §8.3): browser bookmark HTML (the Netscape format every browser exports) and
 * Nexus's own collection JSON. Parsing happens in the browser; nothing is sent until the person
 * confirms the preview.
 */
export interface ImportCandidate {
  title: string;
  url: string;
  /** Bookmark folders it was in (outermost first); they become tags, folders stay the person's choice. */
  path: string[];
  tags: string[];
  note: string;
  folderId?: string;
}

export interface ImportPreview {
  format: 'bookmarks-html' | 'nexus-json';
  items: ImportCandidate[];
  /** Same address as something already in the collection. */
  existing: number;
  /** Same address more than once in the file. */
  repeated: number;
  /** Not importable: javascript:, data:, file:, place:, addresses with a password… */
  unsupported: number;
  folders: string[];
}

const clip = (s: string, n: number) => [...s.trim()].slice(0, n).join('');

/** Folder names that every browser adds and that say nothing about the bookmark. */
const BROWSER_ROOTS = /^(书签栏|收藏夹栏|其他书签|其他收藏夹|移动设备书签|bookmarks bar|bookmarks toolbar|other bookmarks|mobile bookmarks|favorites bar|bookmarks menu)$/i;

export function parseBookmarksHtml(html: string): { items: ImportCandidate[]; unsupported: number } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items: ImportCandidate[] = [];
  let unsupported = 0;
  // Each <A> sits in a <DL>; that <DL> follows the <H3> naming its folder.
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (!canonicalUrl(href)) {
      unsupported++;
      continue;
    }
    const path: string[] = [];
    let dl: Element | null = a.closest('dl');
    while (dl) {
      let h: Element | null = dl.previousElementSibling;
      // <DT><H3>…</H3><DL>…</DL> — the heading is in the same <DT>, or the <DT> just before.
      if (!h || h.tagName !== 'H3') h = dl.parentElement?.querySelector(':scope > h3') ?? null;
      if (h && h.tagName === 'H3') path.unshift(h.textContent?.trim() ?? '');
      dl = dl.parentElement?.closest('dl') ?? null;
    }
    const folders = path.filter((p) => p && !BROWSER_ROOTS.test(p));
    const title = clip(a.textContent ?? '', ITEM_LIMITS.title) || clip(href, ITEM_LIMITS.title);
    items.push({ title, url: href.trim(), path: folders, tags: folders.slice(-2).map((f) => clip(f, ITEM_LIMITS.tag)), note: '' });
  }
  return { items, unsupported };
}

interface ExportFile {
  format?: string;
  items?: { title?: unknown; url?: unknown; tags?: unknown; note?: unknown; folderId?: unknown }[];
}

export function parseNexusJson(text: string): { items: ImportCandidate[]; unsupported: number } {
  let raw: ExportFile;
  try {
    raw = JSON.parse(text) as ExportFile;
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (raw.format !== 'nexus-collection' || !Array.isArray(raw.items)) throw new Error('不是 Nexus 收藏库导出的文件');
  const items: ImportCandidate[] = [];
  let unsupported = 0;
  for (const i of raw.items) {
    const url = typeof i.url === 'string' ? i.url : '';
    if (!canonicalUrl(url)) {
      unsupported++;
      continue;
    }
    const tags = Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === 'string').map((t) => clip(t, ITEM_LIMITS.tag)).filter(Boolean).slice(0, ITEM_LIMITS.tags) : [];
    items.push({ title: clip(typeof i.title === 'string' ? i.title : url, ITEM_LIMITS.title) || clip(url, ITEM_LIMITS.title), url, path: [], tags, note: typeof i.note === 'string' ? i.note.slice(0, ITEM_LIMITS.note) : '', folderId: typeof i.folderId === 'string' ? i.folderId : undefined });
  }
  return { items, unsupported };
}

/** Reads a chosen file and compares it with what the collection already holds. */
export function previewImport(name: string, text: string, existingUrls: ReadonlySet<string>): ImportPreview {
  const isJson = /\.json$/i.test(name) || text.trimStart().startsWith('{');
  const parsed = isJson ? parseNexusJson(text) : parseBookmarksHtml(text);
  const seen = new Set<string>();
  let existing = 0;
  let repeated = 0;
  for (const i of parsed.items) {
    const k = itemUrlKey(i.url);
    if (existingUrls.has(k)) existing++;
    else if (seen.has(k)) repeated++;
    seen.add(k);
  }
  const folders = [...new Set(parsed.items.flatMap((i) => i.path))];
  return { format: isJson ? 'nexus-json' : 'bookmarks-html', items: parsed.items, existing, repeated, unsupported: parsed.unsupported, folders };
}

/** What the server receives: only the fields of an item. */
export function toInputs(items: ImportCandidate[], keepFolders: boolean): ItemInput[] {
  return items.map((i) => ({ kind: 'page', title: i.title, url: i.url, tags: keepFolders ? i.tags : [], note: i.note, ...(i.folderId ? { folderId: i.folderId } : {}) }));
}
