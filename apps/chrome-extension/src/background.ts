import { deviceApi } from './lib/api';
import { coalesce } from './lib/coalesce';
import { adoptDrafts, captureFromMenu, dropEntry, enqueue, flushQueue, forgetSent, MENU, migrateLegacyQueue, readQueue, type FlushStop, type SaveInput } from './lib/collect';
import { QUEUE_COMMANDS, type QueueCommand, type SaveReply } from './lib/queue-client';
import { idbQueueStore } from './lib/queue-store';
import { markRevoked, REVOKED_HINT } from './lib/revoke';
import { canSave, KEYS, readServer, type Area } from './lib/storage';
import { ext, removeAllMenus } from './lib/ext';

/**
 * Background work, all of it event-driven (the service worker may be stopped at any moment):
 *  - the first install opens the setup page;
 *  - 右键 收藏当前页面 / 收藏此链接 and the popup's 保存 are the same command (queue:save): the save
 *    is committed to the queue store first, then sent;
 *  - saves still waiting are sent again at browser start-up, on install/update, and whenever the
 *    popup or a new tab asks — never on a timer, never for pages the person did not choose.
 *
 * NEX-05: this is the queue's one writer for the popup and the menu (see lib/queue-client.ts for
 * the commands). The store is IndexedDB with one transaction per change, so a second context that
 * does write (the sign-out path) can never lose this one's writes, nor this one its.
 */
declare const __NEXUS_TEST__: boolean;

const area = ext.storage.local as unknown as Area;
const queue = idbQueueStore();
const server = async () => readServer((await area.get([KEYS.server]))[KEYS.server]);

/** Saves of 0.2.0 (one storage key) move into the store once, before anything reads or writes it. */
let migrated: Promise<unknown> | null = null;
const ready = () =>
  (migrated ??= migrateLegacyQueue(area, queue).catch(() => {
    migrated = null;
  }));

const unsent = (s: string) => s === 'pending' || s === 'draft' || s === 'held';

/**
 * The toolbar badge: how many saves are not on the server yet (a draft, waiting, or over a limit).
 * A revoked device says so at once — badge 「!」 and the button's title — not at the next new tab.
 */
async function badge(flash?: string) {
  await ready();
  const s = await server();
  const waiting = (await readQueue(queue)).filter((e) => unsent(e.state)).length;
  const revoked = !!s?.revoked;
  await ext.action.setTitle({ title: revoked ? `${REVOKED_HINT}（${waiting ? `${waiting} 条收藏仍保存在扩展里` : '收藏到 Nexus'}）` : '收藏到 Nexus' });
  await ext.action.setBadgeBackgroundColor({ color: flash === '✓' ? '#3f8f5f' : revoked ? '#b3412e' : '#b07a2a' });
  await ext.action.setBadgeText({ text: flash ?? (revoked ? '!' : waiting ? String(waiting) : '') });
  if (flash) setTimeout(() => void badge(), 2500);
}

/** Why the last send stopped with saves left (offline, 401…); kept for whoever asks. */
let lastStop: FlushStop | undefined;
/**
 * One send at a time; a save committed while a send is under way gets one more send after it
 * (coalesce) — joining the running one could leave it waiting until the next popup or new tab.
 */
const flush = coalesce(async () => {
  await ready();
  const s = await server();
  if (s) {
    lastStop = (await flushQueue(queue, s, deviceApi(s.origin)).catch((): { stopped: FlushStop } => ({ stopped: 'offline' }))).stopped;
    // 401 (ADR-019): this device is revoked — marked now, unsent saves kept as drafts (revoke.ts).
    if (lastStop === 'unauthorized') await markRevoked(area, queue, s);
  }
  await badge();
});

function menus() {
  void removeAllMenus().then(() => {
    ext.contextMenus.create({ id: MENU.page, title: '收藏当前页面到 Nexus', contexts: ['page'] });
    ext.contextMenus.create({ id: MENU.link, title: '收藏此链接到 Nexus', contexts: ['link'] });
  });
}

/** One save, from the popup or the menu: committed to the store first, then (when allowed) sent. */
async function save(c: SaveInput, opId?: string): Promise<SaveReply> {
  await ready();
  const s = await server();
  const entry = await enqueue(queue, s, c, { opId });
  if (!canSave(s)) {
    await badge();
    return { ok: true, persisted: true, entry, ...(s?.revoked ? { revoked: true, message: REVOKED_HINT } : {}) };
  }
  await flush();
  const now = (await readQueue(queue)).find((e) => e.opId === entry.opId) ?? entry;
  // Refused as revoked just now: kept (a draft), and the person is told what to do.
  return { ok: true, persisted: true, entry: now, ...(lastStop === 'unauthorized' ? { revoked: true, message: REVOKED_HINT } : {}) };
}

async function saveFromMenu(info: { menuItemId: string | number; linkUrl?: string; pageUrl?: string; selectionText?: string }, tab?: { title?: string; url?: string }): Promise<SaveReply & { state?: string; url?: string }> {
  const c = captureFromMenu(info, tab);
  if ('error' in c) {
    await badge('!');
    return { ok: false, persisted: false, message: c.error };
  }
  const r = await save(c);
  // Kept as a draft (not connected, read-only, or just revoked): the person connects / authorizes
  // first — the options page says why — then confirms the account.
  if (r.entry?.state === 'draft') await ext.runtime.openOptionsPage();
  await badge(r.entry?.state === 'saved' ? '✓' : undefined);
  return { ...r, state: r.entry?.state, url: c.url };
}

async function handle(msg: QueueCommand): Promise<unknown> {
  switch (msg.type) {
    case 'queue:save':
      return save(msg.capture, msg.opId);
    case 'queue:adopt': {
      await ready();
      const s = await server();
      const adopted = s ? await adoptDrafts(queue, s, msg.opIds) : 0;
      await flush();
      return { adopted };
    }
    case 'queue:drop':
      await ready();
      await dropEntry(queue, msg.opId);
      await badge();
      return { ok: true };
    case 'queue:forget':
      await ready();
      await forgetSent(queue);
      await badge();
      return { ok: true };
    case 'flush':
      await flush();
      return lastStop ? { stopped: lastStop } : true;
  }
}

ext.runtime.onInstalled.addListener(({ reason }) => {
  menus();
  if (reason === 'install') void ext.tabs.create({ url: ext.runtime.getURL('options.html?welcome=1') });
  void flush();
});
ext.runtime.onStartup.addListener(() => {
  menus();
  void flush();
});
ext.contextMenus.onClicked.addListener((info, tab) => void saveFromMenu(info, tab));

ext.runtime.onMessage.addListener((msg: QueueCommand | { type?: string; info?: Parameters<typeof saveFromMenu>[0]; tab?: Parameters<typeof saveFromMenu>[1] }, _sender, reply) => {
  if (msg?.type && (QUEUE_COMMANDS as readonly string[]).includes(msg.type)) {
    void handle(msg as QueueCommand).then(reply, (e: unknown) => reply({ ok: false, persisted: false, message: e instanceof Error ? e.message : '保存失败' }));
    return true;
  }
  // End-to-end tests of the test build drive the very same handler (automation cannot open Chrome's context menu).
  if (__NEXUS_TEST__ && msg?.type === 'test:menu' && 'info' in msg && msg.info) {
    void saveFromMenu(msg.info, msg.tab).then(reply);
    return true;
  }
  return false;
});
