import { forgetSent, newOpId, readQueue, type QueueEntry, type SaveInput } from './collect';
import { ext } from './ext';
import { idbQueueStore, type QueueStore } from './queue-store';

/**
 * The background's queue commands (NEX-05): the popup and the context menu change the save queue
 * only through these, so there is one writer that also sends; pages may read the queue directly.
 *
 *  queue:save    { opId, capture }  → SaveReply once the save is committed (and, if this device may,
 *                                     after one attempt to send it)
 *  queue:adopt   { opIds? }         → drafts become pending for the connected account, then sent
 *  queue:drop    { opId }           → removes one entry (a duplicate the person acknowledged)
 *  queue:forget  {}                 → the authorization is gone: unsent saves become drafts, nothing
 *                                     unsent is deleted (sign-out / 401 path, see sync.ts)
 *
 * A 401 while the background itself sends (device revoked, ADR-019) is handled there and then
 * (lib/revoke.ts markRevoked): the device is marked revoked, unsent saves become drafts, the
 * badge shows 「!」 and the reply to queue:save carries revoked: true. A 503 IDENTITY_UNAVAILABLE
 * (or any 5xx / 429 / no network) keeps everything as it is, to be sent again later.
 *  flush         {}                 → send what is pending
 */
export type QueueCommand = { type: 'queue:save'; opId: string; capture: SaveInput } | { type: 'queue:adopt'; opIds?: string[] } | { type: 'queue:drop'; opId: string } | { type: 'queue:forget' } | { type: 'flush' };

export interface SaveReply {
  ok: boolean;
  /** The save is on disk (in the queue store) — only then may the person be told it is kept. */
  persisted: boolean;
  entry?: QueueEntry;
  message?: string;
  /** The server refused this device just now (401, ADR-019): the save is kept as a draft; reconnect. */
  revoked?: boolean;
}

export const QUEUE_COMMANDS: readonly QueueCommand['type'][] = ['queue:save', 'queue:adopt', 'queue:drop', 'queue:forget', 'flush'];

type Send = (msg: QueueCommand) => Promise<unknown>;
const sendToBackground: Send = (msg) => ext.runtime.sendMessage(msg);

/**
 * A save from the popup. The background may be stopped at any moment (Chrome ends an idle service
 * worker; a crash or an update does too): when no answer comes, the queue store is the truth —
 * the same opId sent again is the same save (never a second one), and only a save that is
 * actually stored is reported as kept.
 */
export async function saveThroughBackground(capture: SaveInput, opts: { store?: QueueStore; send?: Send; opId?: string; attempts?: number } = {}): Promise<SaveReply> {
  const store = opts.store ?? idbQueueStore();
  const send = opts.send ?? sendToBackground;
  const opId = opts.opId ?? newOpId();
  const attempts = opts.attempts ?? 3;
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const r = (await send({ type: 'queue:save', opId, capture })) as SaveReply | undefined;
      if (r?.persisted) return r;
      last = r?.message ?? '';
    } catch (e) {
      last = e instanceof Error ? e.message : '';
    }
    const kept = (await readQueue(store)).find((e) => e.opId === opId);
    if (kept) return { ok: true, persisted: true, entry: kept };
  }
  return { ok: false, persisted: false, message: last || '扩展后台没有响应，这次没有保存，请再试一次' };
}

/** Other commands: through the background; `fallback` runs here when it cannot be reached. */
export async function queueCommand<T>(msg: Exclude<QueueCommand, { type: 'queue:save' }>, fallback?: () => Promise<T>, send: Send = sendToBackground): Promise<T | undefined> {
  try {
    return (await send(msg)) as T;
  } catch {
    return fallback ? fallback() : undefined;
  }
}

/**
 * The sign-out / revoked path (sync.ts): through the background, or — if it cannot be reached —
 * directly, which is the same single transaction on the same store.
 */
export const forgetQueue = () => queueCommand({ type: 'queue:forget' }, () => forgetSent(idbQueueStore())).then(() => undefined);
