import { canonicalUrl, hostOf, ITEM_LIMITS, LOCKED_CATEGORY, localItems, pinnedIds, type Item, type ItemWriteResult } from '@nexus/shared';
import { pinNotice } from '@web/data/library';
import { HttpError } from '@web/data/transport';
import { Check, HardDrive, LibraryBig, Pin, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { readQueue, type QueueEntry } from '../lib/collect';
import { extLocal, newLocalOpId, storeLocalSave, type LocalSaveCommand, type LocalSaveReply } from '../lib/local';
import { queueCommand } from '../lib/queue-client';
import { idbQueueStore } from '../lib/queue-store';
import { ext } from '../lib/ext';

/**
 * 收藏当前页面 into this extension's own collection (v0.5 · U1, 03-DESIGN-SPEC §5): title, folder,
 * tags and 固定到首页, saved here — no account, no server. 「已保存」 only once the save is stored
 * (the IndexedDB transaction committed); the same address already saved is shown and updated, not
 * saved twice. The save goes through the background (it outlives the popup); when the background
 * does not answer, the popup stores it itself with the same opId — one save either way.
 */
declare const __NEXUS_TEST__: boolean;
type Folder = { id: string; label: string };
type Phase = 'loading' | 'ready' | 'saving' | 'done';
type Done = { result: ItemWriteResult; undone?: boolean };

async function saveThroughBackground(body: LocalSaveCommand['body']): Promise<LocalSaveReply> {
  try {
    const r = (await ext.runtime.sendMessage({ type: 'local:save', opId: body.opId, body } satisfies LocalSaveCommand)) as LocalSaveReply | undefined;
    if (r) return r;
  } catch {
    /* the background was stopped: store it here */
  }
  return storeLocalSave(body);
}

export function LocalPopup() {
  const [tab, setTab] = useState<{ title: string; url: string } | null>(null);
  const [title, setTitle] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string>(LOCKED_CATEGORY.none);
  const [tags, setTags] = useState('');
  const [pin, setPin] = useState(false);
  const [existing, setExisting] = useState<Item | null>(null);
  const [drafts, setDrafts] = useState<QueueEntry[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      const forced = __NEXUS_TEST__ ? Number(new URLSearchParams(location.search).get('tab')) || null : null;
      const t = forced ? await ext.tabs.get(forced) : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
      const page = { title: (t?.title ?? '').slice(0, ITEM_LIMITS.title), url: t?.url ?? '' };
      setTab(page);
      setTitle(page.title || hostOf(page.url));
      const state = await extLocal().state();
      setFolders(localItems.folders(state).filter((f) => f.id !== LOCKED_CATEGORY.hosted));
      if (canonicalUrl(page.url)) {
        const found = localItems.findByUrl(state, page.url);
        if (found) {
          setExisting(found);
          setTitle(found.title);
          setFolderId(found.folderId);
          setTags(found.tags.join('，'));
          setPin(pinnedIds(state).includes(found.id));
        }
      }
      // Saves of an earlier version kept as drafts (never connected): offered, never moved silently.
      setDrafts((await readQueue(idbQueueStore())).filter((e) => e.state === 'draft' && !e.owner));
      setPhase('ready');
    })().catch((e: unknown) => {
      setError(e instanceof HttpError ? e.message : '读取当前页面或本地收藏失败');
      setPhase('ready');
    });
  }, []);

  const save = async () => {
    if (!tab) return;
    setPhase('saving');
    setError('');
    const body = { opId: newLocalOpId(), source: 'extension' as const, item: { kind: 'page' as const, title: title.trim() || hostOf(tab.url), url: tab.url, folderId, tags: [...new Set(tags.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean))].slice(0, ITEM_LIMITS.tags) }, pinToHome: pin, duplicatePolicy: existing ? ('update' as const) : ('prompt' as const) };
    const r = await saveThroughBackground(body);
    if (r.ok) {
      setDone({ result: r.result });
      setPhase('done');
      return;
    }
    if (r.code === 'DUPLICATE' && r.item) {
      // Saved meanwhile (the context menu, another window): show it; saving again updates it.
      setExisting(r.item);
      setError('这个网址已经在收藏里，再点一次「保存」会更新它。');
    } else setError(r.message);
    setPhase('ready');
  };

  const undo = async () => {
    if (!done || done.result.result !== 'created') return;
    try {
      await extLocal().items.remove(done.result.item.id, newLocalOpId(), done.result.item.version);
      setDone({ ...done, undone: true });
    } catch (e) {
      setError(e instanceof HttpError ? e.message : '没有撤销');
    }
  };

  const adoptDrafts = async () => {
    let moved = 0;
    for (const d of drafts) {
      const r = await storeLocalSave({ opId: d.opId, source: 'extension', item: { kind: 'page', title: d.title, url: d.url, tags: d.tags }, pinToHome: false, duplicatePolicy: 'update' });
      if (r.ok) {
        await queueCommand({ type: 'queue:drop', opId: d.opId }, async () => undefined);
        moved++;
      }
    }
    setDrafts((await readQueue(idbQueueStore())).filter((e) => e.state === 'draft' && !e.owner));
    setError(moved ? '' : '没有放入本地收藏，请再试一次');
  };

  const openLibrary = () => void ext.tabs.create({ url: ext.runtime.getURL('newtab.html#/library') }).then(() => window.close());
  const pageOk = !!tab && !!canonicalUrl(tab.url);
  const notice = done ? pinNotice(done.result.pin) : null;

  return (
    <main className="flex w-[360px] flex-col gap-3 bg-base p-4 text-ink">
      <header className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-amber" />
        <h1 className="m-0 flex-1 text-[15px] font-medium">收藏当前页面</h1>
        <span className="flex items-center gap-1 text-[12px] text-ink/56" title="收藏保存在这个浏览器扩展里，不需要账号">
          <HardDrive className="size-3.5" />
          保存到此扩展
        </span>
      </header>
      {phase === 'loading' && <p className="m-0 text-[13px] text-ink/60">正在读取当前页面…</p>}
      {phase !== 'loading' && !pageOk && <p role="alert" className="m-0 text-[13px] leading-[1.6] text-ink/70">这个页面不能收藏：只支持 http/https 网页（浏览器内部页面、本地文件、扩展页面不行）。可以在新标签页的「收藏 › 新增」里手动添加网址。</p>}
      {pageOk && (phase === 'ready' || phase === 'saving') && (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="m-0 truncate font-mono text-[11.5px] text-ink/50" title={tab!.url}>
            {tab!.url}
          </p>
          {existing && (
            <p className="m-0 rounded-lg bg-ink/7 px-3 py-2 text-[12.5px] leading-[1.6] text-ink/80">
              已在收藏里：「{existing.title}」{folders.find((f) => f.id === existing.folderId) ? `，在「${folders.find((f) => f.id === existing.folderId)!.label}」` : ''}。保存会更新这一条，不会再存一份。
            </p>
          )}
          <label className="flex flex-col gap-1 text-[12px] text-ink/56">
            标题
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ITEM_LIMITS.title} aria-label="标题" className="h-9 rounded-lg border-0 bg-ink/8 px-2.5 text-[13.5px] text-ink outline-none" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[12px] text-ink/56">
              分组
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="分组" className="h-9 rounded-lg border-0 bg-ink/8 px-2 text-[13px] text-ink outline-none">
                {(folders.length ? folders : [{ id: LOCKED_CATEGORY.none, label: '未分类' }]).map((f) => (
                  <option key={f.id} value={f.id} className="bg-[#2a2824]">
                    {f.id === LOCKED_CATEGORY.none ? '未分类' : f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink/56">
              标签
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="逗号分隔" aria-label="标签" className="h-9 rounded-lg border-0 bg-ink/8 px-2.5 text-[13px] text-ink outline-none" />
            </label>
          </div>
          <label className="flex min-h-8 items-center gap-2 text-[13px] text-ink/76">
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} className="size-4 accent-[#e6c08a]" />
            <Pin className="size-3.5" /> 同时固定到首页
          </label>
          <button type="submit" disabled={phase === 'saving'} className="h-10 rounded-xl border-0 bg-amber text-[14px] font-semibold text-on-amber disabled:opacity-50">
            {phase === 'saving' ? '正在保存…' : existing ? '更新这条收藏' : '保存到此扩展'}
          </button>
        </form>
      )}
      {phase === 'done' && done && (
        <div className="flex flex-col gap-2.5">
          <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-ok">
            {done.undone ? <Undo2 className="size-4 flex-none" /> : <Check className="size-4 flex-none" />}
            {done.undone ? '已撤销，这条没有保存' : done.result.result === 'updated' ? '已更新此扩展里的收藏' : '已保存到此扩展'}
          </p>
          {notice && !done.undone && (
            <p className="m-0 flex items-center gap-2 text-[12.5px] text-warn">
              <TriangleAlert className="size-4 flex-none" />
              {notice}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={openLibrary} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border-0 bg-ink/9 text-[13px] text-ink">
              <LibraryBig className="size-4" />
              查看收藏
            </button>
            {done.result.result === 'created' && !done.undone && (
              <button type="button" onClick={() => void undo()} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border-0 bg-ink/9 px-3 text-[13px] text-ink">
                <Undo2 className="size-4" />
                撤销
              </button>
            )}
          </div>
        </div>
      )}
      {drafts.length > 0 && phase !== 'loading' && (
        <div className="flex flex-col gap-2 rounded-lg bg-ink/6 p-3">
          <p className="m-0 text-[12.5px] leading-[1.6] text-ink/76">有 {drafts.length} 条以前存下、还没保存到任何地方的草稿。要放进此扩展的本地收藏吗？</p>
          <button type="button" onClick={() => void adoptDrafts()} className="h-9 rounded-lg border-0 bg-ink/12 text-[13px] text-ink">
            放入本地收藏
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12.5px] leading-[1.6] text-danger-ink">
          {error}
        </p>
      )}
      <button type="button" onClick={() => void ext.runtime.openOptionsPage()} className="self-start border-0 bg-transparent p-0 text-[12px] text-ink/50 hover:text-ink/80">
        想在多台设备使用？连接 Nexus 账号
      </button>
    </main>
  );
}
