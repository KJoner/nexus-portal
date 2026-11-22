import { canonicalUrl, hostOf, ITEM_LIMITS, LOCKED_CATEGORY, type Item } from '@nexus/shared';
import { Check, Cloud, CloudOff, ExternalLink, LibraryBig, Pin, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, deviceApi } from '../lib/api';
import { adoptable, readQueue, type QueueEntry } from '../lib/collect';
import { queueCommand, saveThroughBackground } from '../lib/queue-client';
import { idbQueueStore } from '../lib/queue-store';
import { canSave, KEYS, readServer, type Area, type ServerRecord } from '../lib/storage';
import { readSpace, type ExtSpace } from '../lib/local';
import { ext } from '../lib/ext';
import { SAVED, saveTarget } from '../lib/where';
import { LocalPopup } from './LocalPopup';

/**
 * 工具栏按钮 (需求 §9.1 · EX-01): the current page, prefilled; title, folder, tags and 固定到首页
 * (off by default) can be changed before saving. The save is written to this device first; the
 * popup says 已同步 only after the server confirmed it, otherwise 已保存在此设备，待同步.
 *
 * NEX-05: saving, confirming drafts and dropping go through the background's queue commands (one
 * writer, IndexedDB transactions); the popup only reads the queue itself. 「已保存」 is shown only
 * for a save that is in the store — also when the background was stopped before it answered.
 */
declare const __NEXUS_TEST__: boolean;
const area = ext.storage.local as unknown as Area;
const queue = idbQueueStore();
type Folder = { id: string; label: string };
type Phase = 'loading' | 'ready' | 'saving' | 'done';

const askFlush = () => queueCommand({ type: 'flush' });

function Status({ entry }: { entry: QueueEntry }) {
  const map: Record<QueueEntry['state'], { icon: typeof Check; text: string; tone: string }> = {
    saved: { icon: Check, text: entry.message ? `${SAVED.account.saved}；${entry.message}` : SAVED.account.saved, tone: entry.message ? 'text-warn' : 'text-ok' },
    pending: { icon: CloudOff, text: SAVED.account.pending, tone: 'text-warn' },
    duplicate: { icon: LibraryBig, text: SAVED.account.duplicate, tone: 'text-ink/80' },
    held: { icon: TriangleAlert, text: entry.message ?? '没有保存', tone: 'text-danger-ink' },
    draft: { icon: TriangleAlert, text: SAVED.account.draft, tone: 'text-warn' },
  };
  const s = map[entry.state];
  return (
    <p role="status" className={`m-0 flex items-center gap-2 text-[13px] ${s.tone}`}>
      <s.icon className="size-4 flex-none" />
      {s.text}
    </p>
  );
}

/** v0.5: saves go to the collection the new tab shows — this extension's own, or the paired account. */
export function Popup() {
  const [space, setSpace] = useState<ExtSpace | null>(null);
  useEffect(() => void readSpace(area).then(setSpace, () => setSpace('local')), []);
  if (!space) return <main className="w-[360px] bg-base p-4 text-[13px] text-ink/60">正在读取…</main>;
  return space === 'local' ? <LocalPopup /> : <AccountPopup />;
}

function AccountPopup() {
  const [server, setServer] = useState<ServerRecord | null>(null);
  const [tab, setTab] = useState<{ title: string; url: string } | null>(null);
  const [title, setTitle] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string>(LOCKED_CATEGORY.none);
  const [tags, setTags] = useState('');
  const [pin, setPin] = useState(false);
  const [existing, setExisting] = useState<Item | null>(null);
  const [drafts, setDrafts] = useState<QueueEntry[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [result, setResult] = useState<QueueEntry | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      const s = readServer((await area.get([KEYS.server]))[KEYS.server]);
      setServer(s);
      // activeTab: the page the person clicked the button on — and only that one.
      // (Test builds only: end-to-end tests open the popup as a page and name the tab to read.)
      const forced = __NEXUS_TEST__ ? Number(new URLSearchParams(location.search).get('tab')) || null : null;
      const t = forced ? await ext.tabs.get(forced) : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
      const page = { title: (t?.title ?? '').slice(0, ITEM_LIMITS.title), url: t?.url ?? '' };
      setTab(page);
      setTitle(page.title || hostOf(page.url));
      setDrafts((await readQueue(queue)).filter((e) => adoptable(e, s)));
      void askFlush();
      if (canSave(s) && canonicalUrl(page.url)) {
        const api = deviceApi(s!.origin);
        const [f, found] = await Promise.all([api.folders(s!.token).catch(() => null), api.findItem(s!.token, page.url).catch(() => null)]);
        if (f) setFolders(f.folders);
        if (found) {
          setExisting(found);
          setFolderId(found.folderId);
          setTitle(found.title);
          setTags(found.tags.join('，'));
        }
      }
      setPhase('ready');
    })().catch((e: unknown) => {
      setError(e instanceof ApiError ? e.message : '读取当前页面失败');
      setPhase('ready');
    });
  }, []);

  const save = async () => {
    if (!tab) return;
    setPhase('saving');
    setError('');
    const r = await saveThroughBackground({ title: title.trim() || hostOf(tab.url), url: tab.url, folderId, tags: [...new Set(tags.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean))], pinToHome: pin }, { store: queue });
    if (!r.persisted || !r.entry) {
      setError(r.message ?? '没有保存，请再试一次');
      setPhase('ready');
      return;
    }
    setResult(r.entry);
    // Revoked just now (401): kept as a draft — say so at once, with what to do.
    if (r.revoked) {
      setServer((s) => (s ? { ...s, revoked: true } : s));
      setError(`${r.message ?? '授权已被撤销，请重新连接'}。这条收藏已保存在扩展里，重新连接并确认账号后再发送。`);
    }
    setPhase('done');
  };

  const adopt = async () => {
    if (!server) return;
    await queueCommand({ type: 'queue:adopt' });
    setDrafts((await readQueue(queue)).filter((e) => adoptable(e, server)));
  };

  const shell = (children: React.ReactNode) => (
    <main className="flex w-[380px] flex-col gap-3 bg-base p-4 text-ink">
      <header className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-amber" />
        <h1 className="m-0 flex-1 text-[15px] font-medium">收藏到 Nexus</h1>
        {server && (
          <a href={`${server.origin}/library`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[12.5px] text-ink/60 no-underline hover:text-ink">
            收藏库 <ExternalLink className="size-3.5" />
          </a>
        )}
      </header>
      {server && (
        <p className="m-0 -mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] text-ink/56" title="收藏保存到这个 Nexus 账号，登录同一账号的设备都能看到">
          <Cloud className="size-3.5 flex-none" />
          <span className="truncate">{saveTarget('account', server.account?.label)}</span>
        </p>
      )}
      {children}
    </main>
  );

  if (phase === 'loading') return shell(<p className="m-0 text-[13px] text-ink/60">正在读取当前页面…</p>);
  if (!server)
    return shell(
      <>
        <p className="m-0 text-[13.5px] leading-[1.6] text-ink/76">还没有连接 Nexus Portal。连接并批准「保存收藏」的权限后，就能把网页收进你的收藏库。</p>
        <button type="button" onClick={() => void ext.runtime.openOptionsPage()} className="h-10 rounded-xl border-0 bg-amber text-[14px] font-semibold text-on-amber">
          连接 Nexus Portal
        </button>
      </>,
    );

  const pageOk = !!tab && !!canonicalUrl(tab.url);
  return shell(
    <>
      {!pageOk && <p role="alert" className="m-0 text-[13px] text-ink/70">这个页面不能收藏：只支持 http/https 网页（浏览器内部页面、本地文件、扩展页面不行）。</p>}
      {pageOk && phase !== 'done' && (
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
            <p className="m-0 rounded-lg bg-ink/7 px-3 py-2 text-[12.5px] text-ink/80">
              已在收藏库：「{existing.title}」{folders.find((f) => f.id === existing.folderId)?.label ? `，在「${folders.find((f) => f.id === existing.folderId)!.label}」` : ''}。保存会新建一条前先提示你。
            </p>
          )}
          <label className="flex flex-col gap-1 text-[12px] text-ink/56">
            标题
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ITEM_LIMITS.title} aria-label="标题" className="h-9 rounded-lg border-0 bg-ink/8 px-2.5 text-[13.5px] text-ink outline-none" />
          </label>
          {canSave(server) && (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[12px] text-ink/56">
                分组
                <select value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="分组" className="h-9 rounded-lg border-0 bg-ink/8 px-2 text-[13px] text-ink outline-none">
                  {(folders.length ? folders : [{ id: LOCKED_CATEGORY.none, label: '收件箱' }]).map((f) => (
                    <option key={f.id} value={f.id} className="bg-[#2a2824]">
                      {f.id === LOCKED_CATEGORY.none ? '收件箱（未分组）' : f.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-ink/56">
                标签
                <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="逗号分隔" aria-label="标签" className="h-9 rounded-lg border-0 bg-ink/8 px-2.5 text-[13px] text-ink outline-none" />
              </label>
            </div>
          )}
          {server.scopes?.includes('pins:write') && (
            <label className="flex min-h-8 items-center gap-2 text-[13px] text-ink/76">
              <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} className="size-4 accent-[#e6c08a]" />
              <Pin className="size-3.5" /> 同时固定到首页
            </label>
          )}
          {!canSave(server) && <p className="m-0 text-[12.5px] leading-[1.6] text-warn">这个扩展目前只有读取导航的授权。保存会先存成草稿，请在设置里「授权收藏」后再提交。</p>}
          <button type="submit" disabled={phase === 'saving'} className="h-10 rounded-xl border-0 bg-amber text-[14px] font-semibold text-on-amber disabled:opacity-50">
            {phase === 'saving' ? '正在保存…' : canSave(server) ? '保存' : '存为草稿'}
          </button>
        </form>
      )}
      {phase === 'done' && result && (
        <div className="flex flex-col gap-2">
          <Status entry={result} />
          {result.state === 'duplicate' && (
            <button type="button" onClick={() => void queueCommand({ type: 'queue:drop', opId: result.opId }).then(() => window.close())} className="h-9 rounded-lg border-0 bg-ink/9 text-[13px] text-ink">
              知道了
            </button>
          )}
          {result.state === 'draft' && (
            <button type="button" onClick={() => void ext.runtime.openOptionsPage()} className="h-9 rounded-lg border-0 bg-amber text-[13px] font-semibold text-on-amber">
              去授权收藏
            </button>
          )}
        </div>
      )}
      {canSave(server) && drafts.length > 0 && server.account && (
        <div className="flex flex-col gap-2 rounded-lg bg-ink/6 p-3">
          <p className="m-0 text-[12.5px] text-ink/76">
            有 {drafts.length} 条授权前存下的草稿。确认保存到「{server.account.label}」吗？
          </p>
          <button type="button" onClick={() => void adopt()} className="h-9 rounded-lg border-0 bg-ink/12 text-[13px] text-ink">
            保存到这个账号
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12.5px] text-danger-ink">
          {error}
        </p>
      )}
    </>,
  );
}
