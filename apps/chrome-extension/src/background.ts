import { deviceApi } from './lib/api';
import { captureFromMenu, enqueue, flushQueue, MENU, readQueue } from './lib/collect';
import { canSave, KEYS, readServer, type Area } from './lib/storage';
import { ext, removeAllMenus } from './lib/ext';

/**
 * Background work, all of it event-driven (the service worker may be stopped at any moment):
 *  - the first install opens the setup page;
 *  - 右键 收藏当前页面 / 收藏此链接 put a save on disk, then try to send it;
 *  - saves still waiting are sent again at browser start-up, on install/update, and whenever the
 *    popup or a new tab asks — never on a timer, never for pages the person did not choose.
 */
declare const __NEXUS_TEST__: boolean;

const area = ext.storage.local as unknown as Area;
const server = async () => readServer((await area.get([KEYS.server]))[KEYS.server]);

/** The toolbar badge: how many saves are not on the server yet (a draft, waiting, or over a limit). */
async function badge(flash?: string) {
  const waiting = (await readQueue(area)).filter((e) => e.state === 'pending' || e.state === 'draft' || e.state === 'held').length;
  await ext.action.setBadgeBackgroundColor({ color: flash === '✓' ? '#3f8f5f' : '#b07a2a' });
  await ext.action.setBadgeText({ text: flash ?? (waiting ? String(waiting) : '') });
  if (flash) setTimeout(() => void badge(), 2500);
}

let flushing: Promise<void> | null = null;
function flush(): Promise<void> {
  flushing ??= (async () => {
    const s = await server();
    if (s) await flushQueue(area, s, deviceApi(s.origin)).catch(() => undefined);
    await badge();
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function menus() {
  void removeAllMenus().then(() => {
    ext.contextMenus.create({ id: MENU.page, title: '收藏当前页面到 Nexus', contexts: ['page'] });
    ext.contextMenus.create({ id: MENU.link, title: '收藏此链接到 Nexus', contexts: ['link'] });
  });
}

async function saveFromMenu(info: { menuItemId: string | number; linkUrl?: string; pageUrl?: string; selectionText?: string }, tab?: { title?: string; url?: string }): Promise<{ ok: boolean; state?: string; message?: string; url?: string }> {
  const c = captureFromMenu(info, tab);
  if ('error' in c) {
    await badge('!');
    return { ok: false, message: c.error };
  }
  const s = await server();
  const entry = await enqueue(area, s, c);
  if (!canSave(s)) {
    // Kept as a draft; the person connects / authorizes first, then confirms the account.
    await badge();
    await ext.runtime.openOptionsPage();
    return { ok: true, state: 'draft', url: c.url };
  }
  await flush();
  const done = (await readQueue(area)).find((e) => e.opId === entry.opId);
  await badge(done?.state === 'saved' ? '✓' : undefined);
  return { ok: true, state: done?.state, url: c.url };
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

ext.runtime.onMessage.addListener((msg: { type?: string; info?: Parameters<typeof saveFromMenu>[0]; tab?: Parameters<typeof saveFromMenu>[1] }, _sender, reply) => {
  if (msg?.type === 'flush') {
    void flush().then(() => reply(true));
    return true;
  }
  // End-to-end tests drive the very same handler (automation cannot open Chrome's context menu).
  if (__NEXUS_TEST__ && msg?.type === 'test:menu' && msg.info) {
    void saveFromMenu(msg.info, msg.tab).then(reply);
    return true;
  }
  return false;
});
