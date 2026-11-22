import { deviceApi } from './lib/api';
import { coalesce } from './lib/coalesce';
import { adoptDrafts, captureFromMenu, dropEntry, enqueue, flushQueue, forgetSent, MENU, migrateLegacyQueue, readQueue, type FlushStop, type SaveInput } from './lib/collect';
import { QUEUE_COMMANDS, type QueueCommand, type SaveReply } from './lib/queue-client';
import { idbQueueStore } from './lib/queue-store';
import { markRevoked, REVOKED_HINT } from './lib/revoke';
import { canSave, KEYS, readServer, type Area } from './lib/storage';
import { ext, removeAllMenus } from './lib/ext';
import { newLocalOpId, readSpace, storeLocalSave, type LocalSaveCommand } from './lib/local';
import { SAVED } from './lib/where';

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
 * `note` is what the button's title says meanwhile (after a menu save: where it went, U2b); it lasts
 * as long as the flash, or until the next update when there is none.
 */
async function badge(flash?: string, note?: string) {
  await ready();
  const s = await server();
  const waiting = (await readQueue(queue)).filter((e) => unsent(e.state)).length;
  const revoked = !!s?.revoked;
  await ext.action.setTitle({ title: note ?? (revoked ? `${REVOKED_HINT}（${waiting ? `${waiting} 条收藏仍保存在扩展里` : '添加到我的收藏'}）` : '添加到我的收藏') });
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
    ext.contextMenus.create({ id: MENU.page, title: '添加当前页面到我的收藏', contexts: ['page'] });
    ext.contextMenus.create({ id: MENU.link, title: '添加此链接到我的收藏', contexts: ['link'] });
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
  // v0.5: the new tab shows this extension's own collection — the save goes there, nothing opens.
  if ((await readSpace(area)) === 'local') {
    const r = await storeLocalSave({ opId: newLocalOpId(), source: 'extension', item: { kind: 'page', title: c.title, url: c.url, tags: [] }, pinToHome: false, duplicatePolicy: 'prompt' });
    const state = r.ok ? 'saved' : r.code === 'DUPLICATE' ? 'duplicate' : 'failed';
    await badge(state === 'saved' ? '✓' : state === 'duplicate' ? '=' : '!', state === 'saved' ? SAVED.local.saved : state === 'duplicate' ? SAVED.local.duplicate : `没有保存：${r.ok ? '' : r.message}`);
    return { ok: r.ok || state === 'duplicate', persisted: r.ok || state === 'duplicate', state, url: c.url, ...(r.ok ? {} : { message: r.message }) };
  }
  const r = await save(c);
  // Kept as a draft (not connected, read-only, or just revoked): the person connects / authorizes
  // first — the options page says why — then confirms the account.
  if (r.entry?.state === 'draft') await ext.runtime.openOptionsPage();
  const s = r.entry?.state;
  const note = s === 'saved' ? SAVED.account.saved : s === 'pending' ? SAVED.account.pending : s === 'draft' ? SAVED.account.draft : s === 'duplicate' ? SAVED.account.duplicate : s === 'held' ? (r.entry?.message ?? '没有保存') : undefined;
  await badge(s === 'saved' ? '✓' : s === 'duplicate' ? '=' : undefined, note);
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

ext.runtime.onMessage.addListener((msg: QueueCommand | LocalSaveCommand | { type?: string; info?: Parameters<typeof saveFromMenu>[0]; tab?: Parameters<typeof saveFromMenu>[1] }, _sender, reply) => {
  // v0.5: a popup save into this extension's own collection (one transaction; the opId makes a retry the same save).
  if (msg?.type === 'local:save' && 'body' in msg) {
    void storeLocalSave(msg.body).then(async (r) => {
      if (r.ok) await badge('✓');
      reply(r);
    });
    return true;
  }
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
