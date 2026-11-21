import { forgetSent } from './collect';
import type { QueueStore } from './queue-store';
import { KEYS, readServer, type Area, type ServerRecord } from './storage';

/** What the person is told as soon as the background learns it (badge title, popup, options page). */
export const REVOKED_HINT = '授权已被撤销，请重新连接';

/**
 * The server refused this device's token while sending saves (401 device_unauthorized /
 * DEVICE_REVOKED: revoked in the portal, 退出全部设备 in Nexus or LiteSync, account disabled —
 * ADR-019). The same end state the pages reach when their sync is refused (sync.ts): the token is
 * gone and the cached private data goes; saves not sent yet are kept — as drafts, sent only after
 * reconnecting and confirming which account they go to. Nothing unsent is ever deleted, and nothing
 * is sent with another credential.
 *
 * Only for the device that was refused: if the person has connected again meanwhile (another
 * device id or token), the new connection is left alone. Returns whether it marked anything.
 */
export async function markRevoked(area: Area, queue: QueueStore, refused: ServerRecord): Promise<boolean> {
  const now = readServer((await area.get([KEYS.server]))[KEYS.server]);
  if (!now || now.revoked || now.deviceId !== refused.deviceId || now.token !== refused.token) return false;
  await area.remove([KEYS.cache, KEYS.sync]);
  await area.set({ [KEYS.server]: { ...now, token: '-', revoked: true } });
  await forgetSent(queue);
  return true;
}
