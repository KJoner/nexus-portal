import type { Item, ItemWriteResult } from '@nexus/shared';
import { bundledCatalog } from '@web/data/local/catalog';
import { idbLocalStore } from '@web/data/local/store';
import { localTransport, type LocalTransport } from '@web/data/local/transport';
import { HttpError } from '@web/data/transport';
import { KEYS, readServer, type Area } from './storage';

/**
 * 此扩展的本地收藏 (v0.5 · U1): the extension's own collection — IndexedDB `nexus-local` of the
 * extension's origin, shared by the new tab, the popup, the options page and the background (the
 * context menu). Every save is one IndexedDB transaction, so all of them can write at the same time
 * without losing each other's changes; the pages hear about it (BroadcastChannel) and reload it.
 * Not chrome.storage.sync and not the website's collection: nothing leaves the extension.
 */
let instance: LocalTransport | null = null;

export function extLocal(): LocalTransport {
  instance ??= localTransport({ store: idbLocalStore(), bundledCatalog });
  return instance;
}

export type ExtSpace = 'local' | 'account';

/**
 * Which collection the new tab shows and the popup saves to. Chosen by the person once paired;
 * until then a paired extension shows the account (as it always did) and an extension with no
 * pairing — a fresh install, or one that disconnected — its own local collection.
 */
export async function readSpace(area: Area): Promise<ExtSpace> {
  const raw = await area.get([KEYS.space, KEYS.server]);
  const server = readServer(raw[KEYS.server]);
  const chosen = raw[KEYS.space];
  if (chosen === 'local') return 'local';
  // Paired (revoked included: the new tab says so and offers the local collection, rather than
  // quietly showing another collection — a revoked authorization is not 「not signed in」).
  return server ? 'account' : 'local';
}

export const writeSpace = (area: Area, space: ExtSpace) => area.set({ [KEYS.space]: space });

export const newLocalOpId = () => `ext-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** A save into this extension's collection, from the popup to the background (which outlives the popup). */
export interface LocalSaveCommand {
  type: 'local:save';
  opId: string;
  body: Parameters<ReturnType<typeof extLocal>['items']['create']>[0];
}
export type LocalSaveReply = { ok: true; result: ItemWriteResult } | { ok: false; code: string; message: string; item?: Item };

/** Stores one save (background or popup — the same transaction, the same opId). */
export async function storeLocalSave(body: LocalSaveCommand['body']): Promise<LocalSaveReply> {
  try {
    return { ok: true, result: await extLocal().items.create(body) };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, code: e.code, message: e.message, item: (e.details?.item as Item | undefined) ?? undefined };
    return { ok: false, code: 'FAILED', message: e instanceof Error ? e.message : '没有保存' };
  }
}
