import { hostOf, itemUrlKey, LOCKED_CATEGORY, matchApp, type AppEntry, type Item } from '@nexus/shared';
import { ArrowLeft, Download, FolderInput, Grid2x2, List, Pin, PinOff, Plus, RotateCcw, Search, Tag as TagIcon, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PageBackdrop } from '../../components/PageBackdrop';
import { toast } from '../../components/toast-store';
import { ToastHost } from '../../components/ToastHost';
import { currentTransport, useConfig, useConfigStore } from '../../data/config-store';
import { conflictChoices, libraryApi, loadLibrary, pinNotice, pullLibrary, resolveConflict, useLibrary, type Folder, type LibraryChoice, type LibraryConflict, type WriteOutcome } from '../../data/library';
import { AppTile } from '../../icons/AppTile';
import { cn } from '../../lib/cn';
import { useViewport } from '../../lib/hooks';
import { usePinyin } from '../../lib/pinyin';
import { Button, Dialog, Spinner } from '../settings/ui';
import { HttpError, type RestoreAnswer, type RestoreDuplicates } from '../../data/transport';
import { isBackupFile, previewImport, readBackup, toInputs, type ImportPreview } from './import-files';

/**
 * 收藏库 (需求 §10.4 · NP-04/05, EX-05): every item of the account — apps and saved pages — with a
 * 220 px folder sidebar, search across name / pinyin / domain / tags, list or cards, multi-select
 * and batch actions, trash with restore, import with preview and undo, export. Rows are windowed:
 * thousands of items never put thousands of rows in the document.
 */
type View = { kind: 'all' } | { kind: 'pinned' } | { kind: 'folder'; id: string } | { kind: 'trash' };
const ROW = 56;
const CARD_H = 112;

const asApp = (i: Item, real: Map<string, AppEntry>): AppEntry =>
  real.get(i.id) ?? { id: i.id, kind: 'site', name: i.title, description: i.note.slice(0, 40), url: i.url, lanUrl: '', prefer: 'ext', categoryId: i.folderId, hidden: false, showInServices: true, aliases: i.tags, icon: { source: 'auto', ref: '', letter: '', tone: 0 }, openIn: 'new', health: { enabled: false, target: '/', intervalSec: 60 } };

function useWindow(count: number, rowHeight: number, scroller: React.RefObject<HTMLDivElement | null>) {
  const [range, setRange] = useState({ start: 0, end: 30 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - 6);
      const end = Math.min(count, Math.ceil((el.scrollTop + el.clientHeight) / rowHeight) + 6);
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [count, rowHeight, scroller]);
  return range;
}

function Sidebar({ view, setView, folders, counts }: { view: View; setView(v: View): void; folders: Folder[]; counts: { all: number; pinned: number; trash: number; folder: Map<string, number> } }) {
  const entry = (v: View, label: ReactNode, n: number, key: string) => {
    const on = JSON.stringify(v) === JSON.stringify(view);
    return (
      <button key={key} type="button" aria-current={on ? 'page' : undefined} onClick={() => setView(v)} className={cn('flex h-10 w-full items-center gap-2 rounded-lg border-0 px-3 text-left text-[13.5px] transition-colors duration-150', on ? 'bg-amber/18 text-ink' : 'bg-transparent text-ink/72 hover:bg-ink/7')}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-[11.5px] text-ink/42 tabular-nums">{n}</span>
      </button>
    );
  };
  return (
    <nav aria-label="收藏库分组" className="flex w-[220px] flex-none flex-col gap-0.5 overflow-y-auto pr-2">
      {entry({ kind: 'all' }, '全部', counts.all, 'all')}
      {entry({ kind: 'pinned' }, '已固定到首页', counts.pinned, 'pinned')}
      <div className="mx-3 my-2 h-px bg-ink/8" />
      {folders.map((f) => entry({ kind: 'folder', id: f.id }, f.id === LOCKED_CATEGORY.none ? '收件箱（未分组）' : f.label, counts.folder.get(f.id) ?? 0, f.id))}
      <div className="mx-3 my-2 h-px bg-ink/8" />
      {entry({ kind: 'trash' }, '回收站', counts.trash, 'trash')}
    </nav>
  );
}

function ItemDialog({ open, item, folders, defaultFolder, onClose }: { open: boolean; item: Item | null; folders: Folder[]; defaultFolder: string; onClose(): void }) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [folderId, setFolderId] = useState(defaultFolder);
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<Item | null>(null);
  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setUrl(item?.url ?? '');
    setFolderId(item?.folderId ?? defaultFolder);
    setTags(item?.tags.join('，') ?? '');
    setNote(item?.note ?? '');
    setPin(false);
    setError('');
    setDuplicate(null);
  }, [open, item, defaultFolder]);

  const save = async (policy: 'prompt' | 'update' | 'create' = 'prompt') => {
    const tagList = [...new Set(tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))];
    setBusy(true);
    setError('');
    let r: WriteOutcome;
    if (item) {
      const patch = { ...(title.trim() !== item.title ? { title: title.trim() } : {}), ...(url.trim() !== item.url ? { url: url.trim() } : {}), ...(folderId !== item.folderId ? { folderId } : {}), ...(JSON.stringify(tagList) !== JSON.stringify(item.tags) ? { tags: tagList } : {}), ...(note !== item.note ? { note } : {}) };
      r = Object.keys(patch).length ? await libraryApi.patch(item, patch) : { ok: true };
    } else r = await libraryApi.create({ kind: 'page', title: title.trim() || url.trim(), url: url.trim(), folderId, tags: tagList, note }, { pinToHome: pin, duplicatePolicy: policy });
    setBusy(false);
    // The form stays open with what was typed unless the save went through (or waits on this device).
    if (r.ok) {
      const refused = pinNotice(r.pin);
      toast(refused ? { msg: `已加入收藏库；${refused}`, tone: 'warn' } : { msg: r.queued ? '已保存在本机，联网后同步' : item ? '已保存修改' : '已加入收藏库', tone: 'ok' });
      onClose();
    } else if (r.code === 'DUPLICATE') setDuplicate((r.details?.item as Item) ?? null);
    else if (r.code === 'FIELD_CONFLICT') setError(`这条收藏刚在别处被修改（${((r.details?.conflictFields as string[]) ?? []).join('、')}），已显示最新内容，请确认后再改`);
    else setError(r.message);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      width={520}
      title={item ? '编辑收藏' : '新增收藏'}
      footer={
        duplicate ? (
          <>
            <Button className="h-10 px-4" disabled={busy} onClick={() => void save('create')}>
              另存一条
            </Button>
            <Button variant="primary" className="h-10 px-4" disabled={busy} onClick={() => void save('update')}>
              更新原来那条
            </Button>
          </>
        ) : (
          <>
            <Button className="h-10 px-[18px]" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" className="h-10 px-5" disabled={busy || !url.trim()} onClick={() => void save()}>
              {busy ? <Spinner /> : '保存'}
            </Button>
          </>
        )
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => (e.preventDefault(), void save())}>
        <label className="flex flex-col gap-1.5 text-[12.5px] text-ink/60">
          网址
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="网址" spellCheck={false} autoComplete="off" className="h-10 rounded-lg border-0 bg-ink/7 px-3 font-mono text-[13.5px] text-ink outline-none" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] text-ink/60">
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="标题" className="h-10 rounded-lg border-0 bg-ink/7 px-3 text-[14px] text-ink outline-none" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-[12.5px] text-ink/60">
            分组
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="分组" className="h-10 rounded-lg border-0 bg-ink/7 px-2.5 text-[13.5px] text-ink outline-none">
              {folders.map((f) => (
                <option key={f.id} value={f.id} className="bg-[#2a2824]">
                  {f.id === LOCKED_CATEGORY.none ? '收件箱（未分组）' : f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-[12.5px] text-ink/60">
            标签（逗号分隔）
            <input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="标签" className="h-10 rounded-lg border-0 bg-ink/7 px-3 text-[13.5px] text-ink outline-none" />
          </label>
        </div>
        <label className="flex flex-col gap-1.5 text-[12.5px] text-ink/60">
          备注
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} aria-label="备注" className="rounded-lg border-0 bg-ink/7 px-3 py-2 text-[13.5px] text-ink outline-none" />
        </label>
        {!item && (
          <label className="flex min-h-9 items-center gap-2 text-[13px] text-ink/76">
            <input type="checkbox" className="size-4 accent-[#e6c08a]" checked={pin} onChange={(e) => setPin(e.target.checked)} />
            同时固定到首页（默认不固定）
          </label>
        )}
        {duplicate && (
          <p role="alert" className="m-0 rounded-lg bg-warn/12 px-3 py-2 text-[13px] text-ink/86">
            这个网址已在收藏库：「{duplicate.title}」。可以更新原来那条，或另存一条。
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-danger-ink">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** A browser bookmark file (imported as pages) or a Nexus backup (restored, NEX-06). */
type Picked = { name: string; kind: 'bookmarks'; preview: ImportPreview } | { name: string; kind: 'backup'; file: unknown; version: number; answer: RestoreAnswer; duplicates: RestoreDuplicates };

const DUPLICATE_CHOICES: { value: RestoreDuplicates; label: string }[] = [
  { value: 'skip', label: '跳过，保留收藏库里的' },
  { value: 'update', label: '用备份更新收藏库里的' },
  { value: 'keep-both', label: '两条都保留' },
];

function ImportDialog({ open, folders, existing, onClose }: { open: boolean; folders: Folder[]; existing: ReadonlySet<string>; onClose(): void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [folderId, setFolderId] = useState<string>(LOCKED_CATEGORY.none);
  const [keepFolders, setKeepFolders] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setPicked(null);
      setError('');
    }
  }, [open]);
  const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const text = await file.text();
      if (isBackupFile(file.name, text)) {
        // A Nexus backup: the server plans the restore (folders, ids, pins…) and shows it first.
        const backup = readBackup(text);
        setPicked({ name: file.name, kind: 'backup', file: backup.file, version: backup.version, answer: await libraryApi.previewRestore(backup.file, 'skip'), duplicates: 'skip' });
      } else setPicked({ name: file.name, kind: 'bookmarks', preview: previewImport(file.name, text, existing) });
    } catch (e) {
      setError(message(e, '无法读取这个文件'));
    } finally {
      setBusy(false);
    }
  };
  const choose = async (duplicates: RestoreDuplicates) => {
    if (picked?.kind !== 'backup') return;
    setBusy(true);
    setError('');
    try {
      setPicked({ ...picked, duplicates, answer: await libraryApi.previewRestore(picked.file, duplicates) });
    } catch (e) {
      setError(message(e, '预览失败'));
    } finally {
      setBusy(false);
    }
  };
  const undo = (importId: string) =>
    void libraryApi.undoImport(importId).then(async (u) => {
      await loadLibrary();
      const extra = [u.kept ? `${u.kept} 条导入后被修改过，已保留` : '', u.unpinned ? `取消了 ${u.unpinned} 个固定` : '', u.removedFolders ? `移除了 ${u.removedFolders} 个空分组` : '', u.keptFolders ? `${u.keptFolders} 个分组里已有内容，已保留` : ''].filter(Boolean).join('，');
      toast({ msg: `已撤销导入：移入回收站 ${u.removed} 条${extra ? `，${extra}` : ''}`, tone: 'ok' });
    });
  const run = async () => {
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      if (picked.kind === 'bookmarks') {
        const r = await libraryApi.importItems(toInputs(picked.preview.items, keepFolders), folderId);
        await pullLibrary();
        onClose();
        toast({ msg: `已导入 ${r.imported} 条${r.skipped ? `，跳过 ${r.skipped} 条重复` : ''}`, tone: 'info', action: { label: '撤销本次导入', run: () => undo(r.importId) } });
        return;
      }
      const r = await libraryApi.restoreBackup(picked.file, picked.duplicates, picked.answer.basis);
      // Folders and pins changed too: start again from a full snapshot.
      await loadLibrary();
      onClose();
      const s = r.summary;
      const parts = [`恢复 ${s.items.create} 条`, s.items.update ? `更新 ${s.items.update} 条` : '', s.items.skip ? `跳过 ${s.items.skip} 条重复` : '', s.folders.create.length ? `新建 ${s.folders.create.length} 个分组` : '', s.pins.restore ? `固定 ${s.pins.restore} 个` : '', s.pins.notPinned ? `${s.pins.notPinned} 个未能固定` : ''].filter(Boolean);
      toast({ msg: `已从备份恢复：${parts.join('，')}`, tone: 'info', action: r.importId ? { label: '撤销本次恢复', run: () => undo(r.importId!) } : undefined });
    } catch (e) {
      if (e instanceof HttpError && e.code === 'PLAN_STALE' && picked.kind === 'backup') {
        // The collection changed since the preview: show the new plan, ask again.
        setPicked({ ...picked, answer: await libraryApi.previewRestore(picked.file, picked.duplicates).catch(() => picked.answer) });
        setError('收藏库在预览之后有了变化，已按现在的内容重新预览，请确认后再恢复');
      } else setError(message(e, '导入失败'));
    } finally {
      setBusy(false);
    }
  };
  const importable = picked?.kind === 'bookmarks' ? picked.preview.items.length - picked.preview.existing - picked.preview.repeated : 0;
  const s = picked?.kind === 'backup' ? picked.answer.summary : null;
  const restorable = s ? s.items.create + s.items.update : 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      width={560}
      title={picked?.kind === 'backup' ? '从 Nexus 备份恢复' : '导入收藏'}
      description={picked?.kind === 'backup' ? '按备份恢复分组、应用与网页、目录关联、图标和首页固定顺序；收藏库里已有的内容不会被覆盖，除非你选择「用备份更新」。恢复后可以撤销本次恢复。' : '浏览器导出的书签 HTML 会作为网页导入到你选的分组；Nexus 收藏库导出的 JSON 会按备份恢复结构。导入前先看预览；导入后可以撤销。'}
      footer={
        <>
          <Button className="h-10 px-[18px]" disabled={busy} onClick={onClose}>
            取消
          </Button>
          {picked?.kind === 'backup' ? (
            <Button variant="primary" className="h-10 px-5" disabled={busy || restorable <= 0} onClick={() => void run()}>
              {busy ? <Spinner /> : `恢复 ${restorable} 条`}
            </Button>
          ) : (
            <Button variant="primary" className="h-10 px-5" disabled={busy || !picked || importable <= 0} onClick={() => void run()}>
              {busy ? <Spinner /> : `导入 ${Math.max(0, importable)} 条`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="inline-flex h-10 w-fit cursor-pointer items-center gap-2 rounded-[10px] bg-ink/9 px-3.5 text-[13px] text-ink hover:bg-ink/15">
          <input type="file" accept=".html,.htm,.json,text/html,application/json" className="sr-only" aria-label="选择要导入的文件" disabled={busy} onChange={(e) => void pick(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
          <Upload className="size-[15px]" />
          {picked ? picked.name : '选择文件'}
        </label>
        {picked?.kind === 'bookmarks' && (
          <>
            <dl aria-label="导入预览" className="m-0 grid grid-cols-2 gap-2 text-[13px]">
              {[
                ['可导入', importable],
                ['已在收藏库（跳过）', picked.preview.existing],
                ['文件内重复（跳过）', picked.preview.repeated],
                ['不支持的地址（跳过）', picked.preview.unsupported],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-lg bg-ink/5 px-3 py-2">
                  <dt className="text-ink/52">{k}</dt>
                  <dd className="m-0 text-[18px] tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <label className="flex items-center gap-2 text-[13px] text-ink/76">
              导入到
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label="导入到分组" className="h-9 rounded-lg border-0 bg-ink/9 px-2.5 text-[13px] text-ink outline-none">
                {folders.map((f) => (
                  <option key={f.id} value={f.id} className="bg-[#2a2824]">
                    {f.id === LOCKED_CATEGORY.none ? '收件箱（未分组）' : f.label}
                  </option>
                ))}
              </select>
            </label>
            {picked.preview.folders.length > 0 && (
              <label className="flex min-h-9 items-center gap-2 text-[13px] text-ink/76">
                <input type="checkbox" className="size-4 accent-[#e6c08a]" checked={keepFolders} onChange={(e) => setKeepFolders(e.target.checked)} />
                把书签文件夹名作为标签保留（{picked.preview.folders.slice(0, 4).join('、')}
                {picked.preview.folders.length > 4 ? ' 等' : ''}）
              </label>
            )}
          </>
        )}
        {s && picked?.kind === 'backup' && (
          <>
            <dl aria-label="恢复预览" className="m-0 grid grid-cols-2 gap-2 text-[13px]">
              {[
                ['新建收藏', `${s.items.create}（应用 ${s.items.kinds.app} · 网页 ${s.items.kinds.page}）`],
                ['地址已在收藏库', `${s.duplicateCount}${picked.duplicates === 'update' ? '（更新）' : picked.duplicates === 'skip' ? '（跳过）' : '（另存）'}`],
                ['分组', s.folders.create.length ? `新建 ${s.folders.create.length}：${s.folders.create.map((f) => f.label).join('、')}` : '都已存在'],
                ['首页固定', `恢复 ${s.pins.restore}${s.pins.notPinned ? ` · ${s.pins.notPinned} 个不能固定（首页最多 ${s.pins.limit} 个）` : ''}`],
                ['自定义图标', `${s.icons.upload} 个随备份恢复${s.icons.missing ? ` · ${s.icons.missing} 个缺少图片，改用网站图标` : ''}`],
                ['跳过', `文件内重复 ${s.items.repeated} · 不支持的地址 ${s.items.unsupported}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-ink/5 px-3 py-2">
                  <dt className="text-ink/52">{k}</dt>
                  <dd className="m-0 text-[14px]">{v}</dd>
                </div>
              ))}
            </dl>
            {s.folders.map.length > 0 && <p className="m-0 text-[12.5px] text-ink/60">按名称或编号对应到已有分组：{s.folders.map.map((m) => `${m.from} → ${m.label}`).join('、')}</p>}
            {picked.version < 2 && <p className="m-0 text-[12.5px] text-warn">这是旧版本（格式第 1 版）的备份：没有首页设置和图标图片，会恢复分组、类型、目录关联、标签和固定。</p>}
            {s.duplicateCount > 0 && (
              <label className="flex flex-col gap-1.5 text-[13px] text-ink/76">
                已在收藏库里的 {s.duplicateCount} 个地址（如「{s.duplicates[0]!.existingTitle}」）
                <select value={picked.duplicates} disabled={busy} onChange={(e) => void choose(e.target.value as RestoreDuplicates)} aria-label="已在收藏库里的地址" className="h-9 w-fit rounded-lg border-0 bg-ink/9 px-2.5 text-[13px] text-ink outline-none">
                  {DUPLICATE_CHOICES.map((c) => (
                    <option key={c.value} value={c.value} className="bg-[#2a2824]">
                      {c.label}
                    </option>
                  ))}
                </select>
                {picked.duplicates === 'update' && <span className="text-[12px] text-ink/50">撤销本次恢复只会移除新建的内容，不会还原这些更新。</span>}
              </label>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-danger-ink">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export default function LibraryPage() {
  const { w } = useViewport();
  const compact = w < 900;
  const config = useConfig();
  // The collection shown: the verified account's, or (v0.5) this browser's local collection.
  const account = useConfigStore((s) => (s.space === 'local' ? s.localId : (s.account?.account.id ?? null)));
  const { status, error, items, pins, folders, queued, conflicts } = useLibrary();
  const pinyin = usePinyin((s) => s.fn);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'grid'>('list');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [tagInput, setTagInput] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const lastClicked = useRef<number | null>(null);

  useEffect(() => {
    usePinyin.getState().load();
    if (account) void loadLibrary();
  }, [account]);
  // The account's revision moves with every change (SSE): pull what changed since the cursor.
  useEffect(() => useConfigStore.subscribe((s, prev) => void (s.confirmed?.revision !== prev.confirmed?.revision && pullLibrary())), []);

  const real = useMemo(() => new Map(config.apps.map((a) => [a.id, a])), [config.apps]);
  const all = useMemo(() => Object.values(items).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)), [items]);
  const live = useMemo(() => all.filter((i) => i.deletedAt === null), [all]);
  const pinnedSet = useMemo(() => new Set(pins), [pins]);
  const counts = useMemo(() => {
    const folder = new Map<string, number>();
    for (const i of live) folder.set(i.folderId, (folder.get(i.folderId) ?? 0) + 1);
    return { all: live.length, pinned: live.filter((i) => pinnedSet.has(i.id)).length, trash: all.length - live.length, folder };
  }, [all, live, pinnedSet]);
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const i of live) for (const t of i.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [live]);

  const shown = useMemo(() => {
    const base = view.kind === 'trash' ? all.filter((i) => i.deletedAt !== null) : live.filter((i) => (view.kind === 'pinned' ? pinnedSet.has(i.id) : view.kind === 'folder' ? i.folderId === view.id : true));
    const tagged = tag ? base.filter((i) => i.tags.includes(tag)) : base;
    const q = query.trim();
    if (!q) return tagged;
    // Name, pinyin, aliases (tags) and domain — the same matcher as the home page.
    return tagged.filter((i) => matchApp(asApp(i, real), q, pinyin) !== null || i.note.includes(q));
  }, [all, live, view, tag, query, pinnedSet, real, pinyin]);

  useEffect(() => {
    setSelected(new Set());
    setActive(0);
  }, [view, tag, query]);

  const columns = mode === 'grid' ? Math.max(1, Math.floor(((scroller.current?.clientWidth ?? w - 300) - 8) / 232)) : 1;
  const rowCount = Math.ceil(shown.length / columns);
  const rowH = mode === 'grid' ? CARD_H : ROW;
  const range = useWindow(rowCount, rowH, scroller);
  const chosen = shown.filter((i) => selected.has(i.id));

  const toggle = (index: number, range?: boolean) => {
    const item = shown[index];
    if (!item) return;
    // Read the anchor now: the updater runs later, after lastClicked has moved on.
    const from = lastClicked.current;
    setSelected((s) => {
      const next = new Set(s);
      if (range && from !== null) {
        const [a, b] = [Math.min(from, index), Math.max(from, index)];
        for (let k = a; k <= b; k++) next.add(shown[k]!.id);
      } else if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    lastClicked.current = index;
    setActive(index);
  };

  const reveal = (index: number) => {
    const el = scroller.current;
    if (!el) return;
    const row = Math.floor(index / columns);
    if (row * rowH < el.scrollTop) el.scrollTop = row * rowH;
    else if ((row + 1) * rowH > el.scrollTop + el.clientHeight) el.scrollTop = (row + 1) * rowH - el.clientHeight;
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const step = e.key === 'ArrowDown' ? columns : e.key === 'ArrowUp' ? -columns : e.key === 'ArrowRight' && mode === 'grid' ? 1 : e.key === 'ArrowLeft' && mode === 'grid' ? -1 : 0;
    if (step) {
      e.preventDefault();
      const next = Math.max(0, Math.min(shown.length - 1, active + step));
      setActive(next);
      reveal(next);
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle(active);
    } else if (e.key === 'Enter' && shown[active]) window.open(shown[active].url, '_blank', 'noopener,noreferrer');
    else if (e.key === 'Escape') setSelected(new Set());
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(shown.map((i) => i.id)));
    }
  };

  const batch = async (label: string, f: (i: Item) => Promise<WriteOutcome>, opts: { inOrder?: boolean } = {}) => {
    const list = chosen;
    // Pins are one ordered list with a limit (NEX-07): one at a time, so every answer is the newest
    // and the ones past the limit are refused in the order they were chosen.
    const results: WriteOutcome[] = [];
    if (opts.inOrder) for (const i of list) results.push(await f(i));
    else results.push(...(await Promise.all(list.map(f))));
    if (opts.inOrder) await pullLibrary();
    const failed = results.filter((r) => !r.ok) as Extract<WriteOutcome, { ok: false }>[];
    const queuedN = results.filter((r) => r.ok && r.queued).length;
    setSelected(new Set());
    toast(failed.length ? { msg: `${label}：${list.length - failed.length} 条完成，${failed.length} 条未完成（${failed[0]!.message}）`, tone: 'warn' } : { msg: `${label}：${list.length} 条${queuedN ? '（部分已存在本机，联网后同步）' : ''}`, tone: 'ok' });
  };
  const removeSelected = async () => {
    const list = chosen;
    await batch('已移入回收站', libraryApi.remove);
    toast({ msg: `已移入回收站 ${list.length} 条`, tone: 'info', action: { label: '撤销', run: () => void Promise.all(list.map((i) => libraryApi.restore(i))) } });
  };

  const exportAll = async () => {
    const data = await currentTransport().items.exportAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `nexus-collection-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const folderLabel = (id: string) => (id === LOCKED_CATEGORY.none ? '收件箱' : (folders.find((f) => f.id === id)?.label ?? '—'));
  const existingUrls = useMemo(() => new Set(live.map((i) => itemUrlKey(i.url))), [live]);

  const renderItem = (i: Item, index: number) => {
    const on = selected.has(i.id);
    const pinned = pinnedSet.has(i.id);
    const isActive = index === active;
    const common = { id: `lib-${i.id}`, role: 'option', 'aria-selected': on } as const;
    const check = <input type="checkbox" checked={on} aria-label={`选择 ${i.title}`} onClick={(e) => toggle(index, e.shiftKey)} onChange={() => undefined} className="size-4 flex-none accent-[#e6c08a]" />;
    if (mode === 'grid') {
      return (
        <div key={i.id} {...common} className={cn('flex h-[100px] flex-col gap-2 rounded-xl p-3', on ? 'bg-amber/14' : 'bg-ink/[0.05]', isActive && 'group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-amber/60')}>
          <div className="flex items-center gap-2">
            {check}
            <AppTile target={{ kind: 'app', app: asApp(i, real) }} size={28} lazy />
            <a href={i.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-[13.5px] text-ink no-underline hover:underline" title={i.title}>
              {i.title}
            </a>
            {pinned && <Pin className="size-3.5 flex-none text-amber-hi" aria-label="已固定" />}
          </div>
          <span className="truncate text-[12px] text-ink/50">{hostOf(i.url)} · {folderLabel(i.folderId)}</span>
          <span className="truncate text-[11.5px] text-ink/46">{i.tags.map((t) => `#${t}`).join(' ')}</span>
        </div>
      );
    }
    return (
      <div key={i.id} {...common} className={cn('flex h-[52px] items-center gap-3 rounded-lg px-3', on ? 'bg-amber/14' : 'hover:bg-ink/[0.045]', isActive && 'group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-amber/60')}>
        {check}
        <AppTile target={{ kind: 'app', app: asApp(i, real) }} size={28} lazy />
        <a href={i.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-[2] truncate text-[14px] text-ink no-underline hover:underline" title={i.title}>
          {i.title}
        </a>
        {!compact && <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink/50">{hostOf(i.url)}</span>}
        {!compact && <span className="w-24 flex-none truncate text-[12.5px] text-ink/56">{folderLabel(i.folderId)}</span>}
        {!compact && <span className="min-w-0 flex-1 truncate text-[12px] text-ink/50">{i.tags.map((t) => `#${t}`).join(' ')}</span>}
        {view.kind === 'trash' ? (
          <Button size="sm" onClick={() => void libraryApi.restore(i)}>
            <RotateCcw className="size-3.5" /> 恢复
          </Button>
        ) : (
          <>
            <button type="button" aria-label={pinned ? `取消固定 ${i.title}` : `固定 ${i.title} 到首页`} aria-pressed={pinned} onClick={() => void (pinned ? libraryApi.unpin(i) : libraryApi.pin(i))} className={cn('grid size-9 flex-none place-items-center rounded-lg border-0 bg-transparent', pinned ? 'text-amber-hi' : 'text-ink/40 hover:text-ink/80')}>
              {pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
            </button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
              编辑
            </Button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-base text-ink">
      <PageBackdrop />
      <div className="relative mx-auto flex h-full max-w-[1320px] flex-col">
        <header className={cn('flex flex-wrap items-center gap-2', compact ? 'px-4 pt-4 pb-2' : 'px-8 pt-7 pb-3')}>
          <Link to="/" aria-label="返回首页" className="grid size-11 flex-none place-items-center rounded-full text-ink/80 no-underline hover:bg-ink/8">
            <ArrowLeft className="size-[18px]" />
          </Link>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className={cn('m-0 font-medium tracking-[-0.01em] whitespace-nowrap', compact ? 'text-[20px]' : 'text-[26px]')}>收藏库</h1>
            {!compact && <p className="m-0 text-[13px] text-ink/56">{counts.all} 条收藏{queued ? ` · ${queued} 项更改保存在本机，联网后同步` : ''}。首页只显示你固定的项目。</p>}
          </div>
          <Button variant="primary" className={compact ? 'order-2' : 'order-last'} onClick={() => setEditing('new')}>
            <Plus className="size-[15px]" /> 新增
          </Button>
          <div className={cn('flex items-center gap-2', compact && 'order-3 w-full')}>
            <Link to="/catalog" className="flex h-10 items-center rounded-xl px-3 text-[13.5px] text-ink/80 no-underline hover:bg-ink/8">
              应用目录
            </Link>
            <Button onClick={() => setImporting(true)}>
              <Upload className="size-[15px]" /> 导入
            </Button>
            <Button onClick={() => void exportAll()}>
              <Download className="size-[15px]" /> 导出
            </Button>
          </div>
        </header>

        <div className={cn('flex min-h-0 flex-1 gap-4', compact ? 'flex-col px-4' : 'px-8')}>
          {!compact ? (
            <Sidebar view={view} setView={setView} folders={folders} counts={counts} />
          ) : (
            <select aria-label="收藏库分组" value={JSON.stringify(view)} onChange={(e) => setView(JSON.parse(e.target.value) as View)} className="h-11 rounded-xl border-0 bg-ink/8 px-3 text-[14px] text-ink outline-none">
              <option value={JSON.stringify({ kind: 'all' })}>全部（{counts.all}）</option>
              <option value={JSON.stringify({ kind: 'pinned' })}>已固定到首页（{counts.pinned}）</option>
              {folders.map((f) => (
                <option key={f.id} value={JSON.stringify({ kind: 'folder', id: f.id })}>
                  {f.id === LOCKED_CATEGORY.none ? '收件箱（未分组）' : f.label}（{counts.folder.get(f.id) ?? 0}）
                </option>
              ))}
              <option value={JSON.stringify({ kind: 'trash' })}>回收站（{counts.trash}）</option>
            </select>
          )}

          <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3.5" style={{ background: 'rgba(239,234,225,0.07)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.09)' }}>
                <Search className="size-4 flex-none text-ink/50" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索收藏库" placeholder="名称、拼音、域名或标签（只在收藏库里找）" spellCheck={false} autoComplete="off" className="h-full min-w-0 flex-1 border-0 bg-transparent text-[14.5px] text-ink caret-amber outline-none" />
                {query && (
                  <button type="button" aria-label="清空搜索" onClick={() => setQuery('')} className="grid size-8 place-items-center rounded-full border-0 bg-transparent text-ink/60 hover:bg-ink/8">
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div role="group" aria-label="显示方式" className="flex rounded-xl bg-ink/7 p-1">
                {(['list', 'grid'] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={mode === m} aria-label={m === 'list' ? '紧凑列表' : '卡片'} onClick={() => setMode(m)} className={cn('grid size-9 place-items-center rounded-lg border-0', mode === m ? 'bg-ink/14 text-ink' : 'bg-transparent text-ink/56')}>
                    {m === 'list' ? <List className="size-4" /> : <Grid2x2 className="size-4" />}
                  </button>
                ))}
              </div>
            </div>
            {tags.length > 0 && (
              <div role="group" aria-label="按标签筛选" className="nx-scroll-hidden flex gap-1.5 overflow-x-auto">
                {tags.map(([t, n]) => (
                  <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)} className={cn('flex h-8 flex-none items-center gap-1 rounded-full border-0 px-3 text-[12.5px]', tag === t ? 'bg-amber text-on-amber' : 'bg-ink/8 text-ink/76 hover:bg-ink/13')}>
                    #{t} <span className="text-[11px] opacity-60">{n}</span>
                  </button>
                ))}
              </div>
            )}

            {conflicts.length > 0 && (
              <div role="region" aria-label="待处理的离线更改" className="flex flex-col gap-2 rounded-xl bg-warn/10 p-3">
                <p className="m-0 text-[13.5px] text-ink/86">{conflicts.length} 项离线时的更改没有完成：在别处已被删除或修改。它们保留在本机，请逐项决定。</p>
                {conflicts.map((c, i) => (
                  <ConflictLine key={`${c.op.opId}-${c.at}`} conflict={c} index={i} />
                ))}
              </div>
            )}
            {status === 'loading' && (
              <p role="status" className="flex items-center gap-2 text-[13.5px] text-ink/60">
                <Spinner /> 正在加载收藏库…
              </p>
            )}
            {status === 'error' && (
              <div role="alert" className="flex items-center gap-3 rounded-xl bg-error/10 p-4 text-[14px]">
                {error}
                <Button onClick={() => void loadLibrary()}>重试</Button>
              </div>
            )}
            {status === 'ready' && shown.length === 0 && (
              <div className="flex flex-col items-start gap-3 rounded-xl bg-ink/[0.045] p-5">
                <p className="m-0 text-[14.5px]">{query.trim() ? `收藏库里没有「${query.trim()}」` : view.kind === 'trash' ? '回收站是空的' : '这里还没有收藏'}</p>
                {view.kind !== 'trash' && (
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => setEditing('new')}>
                      <Plus className="size-3.5" /> 新增收藏
                    </Button>
                    <Link to="/catalog" className="flex h-9 items-center rounded-[10px] bg-ink/9 px-3.5 text-[13px] text-ink no-underline hover:bg-ink/15">
                      去应用目录
                    </Link>
                  </div>
                )}
              </div>
            )}

            <div
              ref={scroller}
              role="listbox"
              aria-multiselectable="true"
              aria-label={`收藏（${shown.length} 条）`}
              aria-activedescendant={shown[active] ? `lib-${shown[active].id}` : undefined}
              tabIndex={0}
              onKeyDown={onKey}
              className={cn('group relative min-h-0 flex-1 overflow-y-auto rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-amber/50', chosen.length ? 'pb-24' : 'pb-6')}
            >
              <div style={{ height: rowCount * rowH, position: 'relative' }}>
                {Array.from({ length: Math.max(0, range.end - range.start) }, (_, k) => range.start + k).map((row) => (
                  <div key={row} className={cn('absolute right-0 left-0', mode === 'grid' && 'grid gap-2')} style={{ top: row * rowH, height: rowH - 4, gridTemplateColumns: mode === 'grid' ? `repeat(${columns}, minmax(0, 1fr))` : undefined }}>
                    {shown.slice(row * columns, row * columns + columns).map((i, c) => renderItem(i, row * columns + c))}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        {chosen.length > 0 && (
          <div role="region" aria-label="批量操作" className={cn('absolute right-0 bottom-0 left-0 flex flex-wrap items-center gap-2 border-t border-ink/8 backdrop-blur-[24px]', compact ? 'px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]' : 'px-8 py-3')} style={{ background: 'rgba(30,28,25,0.9)' }}>
            <span className="mr-2 text-[13.5px] text-ink/80">已选 {chosen.length} 条</span>
            {view.kind === 'trash' ? (
              <Button variant="primary" onClick={() => void batch('已恢复', libraryApi.restore)}>
                <RotateCcw className="size-3.5" /> 恢复
              </Button>
            ) : (
              <>
                <label className="flex items-center gap-1.5">
                  <FolderInput className="size-4 text-ink/60" />
                  <select aria-label="批量移动到分组" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="h-9 rounded-lg border-0 bg-ink/9 px-2 text-[13px] text-ink outline-none">
                    <option value="" className="bg-[#2a2824]">
                      移动到…
                    </option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id} className="bg-[#2a2824]">
                        {f.id === LOCKED_CATEGORY.none ? '收件箱' : f.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button disabled={!moveTo} onClick={() => void batch('已移动', (i) => (i.folderId === moveTo ? Promise.resolve({ ok: true } as WriteOutcome) : libraryApi.patch(i, { folderId: moveTo }))).then(() => setMoveTo(''))}>
                  移动
                </Button>
                <label className="flex items-center gap-1.5">
                  <TagIcon className="size-4 text-ink/60" />
                  <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="标签" aria-label="批量添加标签" className="h-9 w-24 rounded-lg border-0 bg-ink/9 px-2.5 text-[13px] text-ink outline-none" />
                </label>
                <Button disabled={!tagInput.trim()} onClick={() => void batch('已添加标签', (i) => (i.tags.includes(tagInput.trim()) ? Promise.resolve({ ok: true } as WriteOutcome) : libraryApi.patch(i, { tags: [...i.tags, tagInput.trim()] }))).then(() => setTagInput(''))}>
                  加标签
                </Button>
                <Button onClick={() => void batch('已固定到首页', (i) => (pinnedSet.has(i.id) ? Promise.resolve({ ok: true } as WriteOutcome) : libraryApi.pin(i)), { inOrder: true })}>
                  <Pin className="size-3.5" /> 固定
                </Button>
                <Button onClick={() => void batch('已取消固定', (i) => (pinnedSet.has(i.id) ? libraryApi.unpin(i) : Promise.resolve({ ok: true } as WriteOutcome)), { inOrder: true })}>
                  <PinOff className="size-3.5" /> 取消固定
                </Button>
                <Button variant="danger" onClick={() => void removeSelected()}>
                  <Trash2 className="size-3.5" /> 删除
                </Button>
              </>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
          </div>
        )}

        <ItemDialog open={editing !== null} item={editing === 'new' ? null : editing} folders={folders} defaultFolder={view.kind === 'folder' ? view.id : LOCKED_CATEGORY.none} onClose={() => setEditing(null)} />
        <ImportDialog open={importing} folders={folders} existing={existingUrls} onClose={() => setImporting(false)} />
        <ToastHost variant={compact ? 'mobile' : 'desktop'} bottom={chosen.length ? 96 : 24} />
      </div>
    </div>
  );
}

const MINE_LABEL = (c: LibraryConflict) =>
  c.op.kind === 'patch' ? (c.code === 'ITEM_DELETED' ? '恢复并应用修改' : '用我的修改') : c.op.kind === 'remove' ? '仍然删除' : c.op.kind === 'restore' ? '仍然恢复' : c.code === 'DUPLICATE' ? '更新原来那条' : '重试';
const CHOICE_LABEL: Record<Exclude<LibraryChoice, 'mine'>, string> = { copy: '另存一条', discard: '放弃' };
const CHOICE_DONE: Record<LibraryChoice, string> = { mine: '已重新提交', copy: '已另存一条', discard: '已放弃这项更改' };

/** A change made offline that another device got ahead of (NEX-04): what happened and what to do. */
function ConflictLine({ conflict, index }: { conflict: LibraryConflict; index: number }) {
  const [busy, setBusy] = useState(false);
  const decide = async (choice: LibraryChoice) => {
    setBusy(true);
    const r = await resolveConflict(index, choice);
    setBusy(false);
    toast(r.ok ? { msg: r.queued ? '已保存在本机，联网后同步' : CHOICE_DONE[choice], tone: 'ok' } : { msg: `没有完成：${r.message}`, tone: 'warn' });
  };
  const title = conflict.op.seen?.title ?? (conflict.details?.item as Item | undefined)?.title ?? '';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-ink/5 px-3 py-2">
      <span className="min-w-0 flex-1 text-[13px] text-ink/86">
        {title && <span className="font-medium">「{title}」</span>}
        {conflict.message}
      </span>
      {conflictChoices(conflict).map((choice) => (
        <Button key={choice} size="sm" variant={choice === 'mine' ? 'primary' : choice === 'discard' ? 'ghost' : 'secondary'} disabled={busy} onClick={() => void decide(choice)}>
          {choice === 'mine' ? MINE_LABEL(conflict) : CHOICE_LABEL[choice]}
        </Button>
      ))}
    </div>
  );
}
