import { UNFILED, type BookmarkImportPreview, type Category, type Item, type ItemInput } from '@nexus/shared';
import { Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '../../components/toast-store';
import { conflictChoices, libraryApi, loadLibrary, pullLibrary, resolveConflict, type LibraryChoice, type LibraryConflict } from '../../data/library';
import { HttpError, type RestoreAnswer, type RestoreDuplicates } from '../../data/transport';
import { isBackupFile, previewImport, readBackup, toInputs, type ImportCandidate, type ImportPreview } from '../library/import-files';
import { Button, Dialog, Segmented, Spinner } from '../settings/ui';
import { pathLabel } from './model';
import { GroupSelect } from './parts';

/**
 * 导入 (UI v2 · spec 03 §6, 06 B13–B15): a browser bookmark file keeps its folders as nested groups
 * by default (保留文件夹层级, previewed first: which groups are created, which are reused, what is too
 * deep), or goes into one group; a Nexus backup (v1–v3) is restored with its tree and orders.
 * Nothing is written before the preview is confirmed; every import can be undone.
 */
type Picked = { name: string; kind: 'bookmarks'; preview: ImportPreview } | { name: string; kind: 'backup'; file: unknown; version: number; answer: RestoreAnswer; duplicates: RestoreDuplicates };
type Mode = 'tree' | 'single';

const DUPLICATE_CHOICES: { value: RestoreDuplicates; label: string }[] = [
  { value: 'skip', label: '跳过，保留我的收藏里的' },
  { value: 'update', label: '用备份更新我的收藏里的' },
  { value: 'keep-both', label: '两条都保留' },
];

const treeInputs = (items: ImportCandidate[]): (ItemInput & { path: string[] })[] => items.map((i) => ({ kind: i.kind ?? 'page', title: i.title, url: i.url, tags: i.tags, note: i.note, path: i.path, ...(i.catalogId ? { catalogId: i.catalogId } : {}) }));

export function ImportDialog({ open, categories, existing, onClose }: { open: boolean; categories: readonly Category[]; existing: ReadonlySet<string>; onClose(): void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [mode, setMode] = useState<Mode>('tree');
  const [parentId, setParentId] = useState<string>(UNFILED);
  const [folderId, setFolderId] = useState<string>(UNFILED);
  const [keepTags, setKeepTags] = useState(true);
  const [tree, setTree] = useState<BookmarkImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setPicked(null);
      setTree(null);
      setError('');
    }
  }, [open]);
  const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
  const bookmarks = picked?.kind === 'bookmarks' ? picked.preview : null;
  const hasFolders = !!bookmarks && bookmarks.folders.length > 0;
  const treeMode = hasFolders && mode === 'tree';

  // The tree's plan comes from the same rules the import uses (groups created / reused / too deep).
  useEffect(() => {
    if (!bookmarks || !treeMode) return setTree(null);
    let live = true;
    setBusy(true);
    libraryApi
      .previewBookmarks({ folderMode: 'tree', parentId: parentId === UNFILED ? null : parentId, items: treeInputs(bookmarks.items) })
      .then((p) => live && setTree(p))
      .catch((e: unknown) => live && setError(message(e, '预览失败')))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [bookmarks, treeMode, parentId]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const text = await file.text();
      if (isBackupFile(file.name, text)) {
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
        if (treeMode) {
          const r = await libraryApi.importBookmarks({ folderMode: 'tree', parentId: parentId === UNFILED ? null : parentId, items: treeInputs(picked.preview.items) });
          await loadLibrary();
          onClose();
          toast({ msg: `已导入 ${r.imported} 条${r.skipped ? `，跳过 ${r.skipped} 条重复` : ''}${r.folders?.create.length ? `，新建 ${r.folders.create.length} 个分组` : ''}`, tone: 'info', action: { label: '撤销本次导入', run: () => undo(r.importId) } });
          return;
        }
        const r = await libraryApi.importItems(toInputs(picked.preview.items, keepTags), folderId);
        await pullLibrary();
        onClose();
        toast({ msg: `已导入 ${r.imported} 条到「${pathLabel(categories, folderId)}」${r.skipped ? `，跳过 ${r.skipped} 条重复` : ''}`, tone: 'info', action: { label: '撤销本次导入', run: () => undo(r.importId) } });
        return;
      }
      const r = await libraryApi.restoreBackup(picked.file, picked.duplicates, picked.answer.basis);
      await loadLibrary();
      onClose();
      const s = r.summary;
      const parts = [`恢复 ${s.items.create} 条`, s.items.update ? `更新 ${s.items.update} 条` : '', s.items.skip ? `跳过 ${s.items.skip} 条重复` : '', s.folders.create.length ? `新建 ${s.folders.create.length} 个分组` : '', s.pins.restore ? `固定 ${s.pins.restore} 个` : '', s.pins.notPinned ? `${s.pins.notPinned} 个未能固定` : ''].filter(Boolean);
      toast({ msg: `已从备份恢复：${parts.join('，')}`, tone: 'info', action: r.importId ? { label: '撤销本次恢复', run: () => undo(r.importId!) } : undefined });
    } catch (e) {
      if (e instanceof HttpError && e.code === 'PLAN_STALE' && picked.kind === 'backup') {
        setPicked({ ...picked, answer: await libraryApi.previewRestore(picked.file, picked.duplicates).catch(() => picked.answer) });
        setError('我的收藏在预览之后有了变化，已按现在的内容重新预览，请确认后再恢复');
      } else setError(message(e, '导入失败'));
    } finally {
      setBusy(false);
    }
  };
  const importable = bookmarks ? (treeMode ? (tree?.imported ?? 0) : bookmarks.items.length - bookmarks.existing - bookmarks.repeated) : 0;
  const s = picked?.kind === 'backup' ? picked.answer.summary : null;
  const restorable = s ? s.items.create + s.items.update : 0;
  const cell = 'rounded-lg px-3 py-2';
  const cellBg = { background: 'rgb(var(--nx-ink-rgb)/0.05)' };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      width={600}
      title={picked?.kind === 'backup' ? '从 Nexus 备份恢复' : '导入收藏'}
      description={picked?.kind === 'backup' ? '按备份恢复分组（含子分组）、收藏、目录关联、图标和首页固定顺序；已有的内容不会被覆盖，除非你选择「用备份更新」。恢复后可以撤销。' : '浏览器导出的书签 HTML：默认保留文件夹层级，变成分组和子分组；Nexus 导出的 JSON 按备份恢复。先看预览再导入，导入后可以撤销。'}
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
        {bookmarks && (
          <>
            {hasFolders && (
              <Segmented
                label="书签文件夹"
                className="self-start"
                value={mode}
                options={[
                  { value: 'tree', label: '保留文件夹层级（推荐）' },
                  { value: 'single', label: '全部放进一个分组' },
                ]}
                onChange={(v) => setMode(v as Mode)}
              />
            )}
            {treeMode ? (
              <>
                <GroupSelect categories={categories} value={parentId} onChange={setParentId} label="放在哪个分组下（未分组 = 作为顶层分组）" />
                {tree?.folders && (
                  <dl aria-label="导入预览" className="m-0 grid grid-cols-2 gap-2 text-[13px]">
                    <div className={cell} style={cellBg}>
                      <dt className="text-ink/52">将导入</dt>
                      <dd className="m-0 text-[18px] tabular-nums">{tree.imported}</dd>
                    </div>
                    <div className={cell} style={cellBg}>
                      <dt className="text-ink/52">已在我的收藏（跳过）</dt>
                      <dd className="m-0 text-[18px] tabular-nums">{tree.skipped}</dd>
                    </div>
                    {/* What the file has that is never imported, as the single-group preview says it. */}
                    {bookmarks && bookmarks.repeated > 0 && (
                      <div className={cell} style={cellBg}>
                        <dt className="text-ink/52">文件内重复（跳过）</dt>
                        <dd className="m-0 text-[18px] tabular-nums">{bookmarks.repeated}</dd>
                      </div>
                    )}
                    {bookmarks && bookmarks.unsupported > 0 && (
                      <div className={cell} style={cellBg}>
                        <dt className="text-ink/52">不支持的地址（跳过）</dt>
                        <dd className="m-0 text-[18px] tabular-nums">{bookmarks.unsupported}</dd>
                      </div>
                    )}
                    <div className={`${cell} col-span-2`} style={cellBg}>
                      <dt className="text-ink/52">分组</dt>
                      <dd className="m-0 leading-[1.6]">
                        新建 {tree.folders.create.length} 个{tree.folders.create.length ? `：${tree.folders.create.slice(0, 6).map((f) => f.path.join(' / ')).join('、')}${tree.folders.create.length > 6 ? ' 等' : ''}` : ''}；沿用已有 {tree.folders.matched.length} 个
                      </dd>
                    </div>
                    {(tree.folders.overDepth.length > 0 || tree.folders.overLimit > 0) && (
                      <div className={`${cell} col-span-2 text-[var(--nx-warn-ink)]`} style={cellBg}>
                        {tree.folders.overDepth.length > 0 && `${tree.folders.overDepth.length} 个文件夹超过 8 层，里面的书签放进最深允许的上级分组。`}
                        {tree.folders.overLimit > 0 && `分组数量会超过 50 个上限，${tree.folders.overLimit} 个文件夹不新建，书签放进最近的上级分组。`}
                      </div>
                    )}
                  </dl>
                )}
              </>
            ) : (
              <>
                <dl aria-label="导入预览" className="m-0 grid grid-cols-2 gap-2 text-[13px]">
                  {[
                    ['可导入', importable],
                    ['已在我的收藏（跳过）', bookmarks.existing],
                    ['文件内重复（跳过）', bookmarks.repeated],
                    ['不支持的地址（跳过）', bookmarks.unsupported],
                  ].map(([k, v]) => (
                    <div key={k as string} className={cell} style={cellBg}>
                      <dt className="text-ink/52">{k}</dt>
                      <dd className="m-0 text-[18px] tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
                <GroupSelect categories={categories} value={folderId} onChange={setFolderId} label="导入到分组" />
                {hasFolders && (
                  <label className="flex min-h-9 items-center gap-2 text-[13px] text-ink/76">
                    <input type="checkbox" className="size-4 accent-[var(--color-amber)]" checked={keepTags} onChange={(e) => setKeepTags(e.target.checked)} />
                    把书签文件夹名作为标签保留
                  </label>
                )}
              </>
            )}
          </>
        )}
        {s && picked?.kind === 'backup' && (
          <>
            <dl aria-label="恢复预览" className="m-0 grid grid-cols-2 gap-2 text-[13px]">
              {[
                ['新建收藏', `${s.items.create}（应用 ${s.items.kinds.app} · 网页 ${s.items.kinds.page}）`],
                ['地址已在我的收藏', `${s.duplicateCount}${picked.duplicates === 'update' ? '（更新）' : picked.duplicates === 'skip' ? '（跳过）' : '（另存）'}`],
                ['分组', s.folders.create.length ? `新建 ${s.folders.create.length}：${s.folders.create.map((f) => f.label).join('、')}` : '都已存在'],
                ['首页固定', `恢复 ${s.pins.restore}${s.pins.notPinned ? ` · ${s.pins.notPinned} 个不能固定（首页最多 ${s.pins.limit} 个）` : ''}`],
                ['自定义图标', `${s.icons.upload} 个随备份恢复${s.icons.missing ? ` · ${s.icons.missing} 个缺少图片，改用网站图标` : ''}`],
                ['跳过', `文件内重复 ${s.items.repeated} · 不支持的地址 ${s.items.unsupported}`],
              ].map(([k, v]) => (
                <div key={k} className={cell} style={cellBg}>
                  <dt className="text-ink/52">{k}</dt>
                  <dd className="m-0 text-[14px]">{v}</dd>
                </div>
              ))}
            </dl>
            {s.folders.map.length > 0 && <p className="m-0 text-[12.5px] text-ink/60">对应到已有分组：{s.folders.map.map((m) => `${m.from} → ${m.label}`).join('、')}</p>}
            {picked.version < 2 && <p className="m-0 text-[12.5px] text-warn">这是旧版本（第 1 版）的备份：没有首页设置和图标图片，会恢复分组、类型、目录关联、标签和固定。</p>}
            {s.duplicateCount > 0 && (
              <label className="flex flex-col gap-1.5 text-[13px] text-ink/76">
                已在我的收藏里的 {s.duplicateCount} 个地址（如「{s.duplicates[0]!.existingTitle}」）
                <select value={picked.duplicates} disabled={busy} onChange={(e) => void choose(e.target.value as RestoreDuplicates)} aria-label="已在我的收藏里的地址" className="h-9 w-fit rounded-lg border-0 bg-ink/9 px-2.5 text-[13px] text-ink outline-none">
                  {DUPLICATE_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
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

const MINE_LABEL = (c: LibraryConflict) =>
  c.op.kind === 'patch' || c.op.kind === 'save' ? (c.code === 'ITEM_DELETED' ? '恢复并应用修改' : '用我的修改') : c.op.kind === 'remove' ? '仍然删除' : c.op.kind === 'restore' ? '仍然恢复' : c.op.kind === 'move' ? '仍然移动' : c.code === 'DUPLICATE' ? '更新原来那条' : '重试';
const CHOICE_LABEL: Record<Exclude<LibraryChoice, 'mine'>, string> = { copy: '另存一条', discard: '放弃' };
const CHOICE_DONE: Record<LibraryChoice, string> = { mine: '已重新提交', copy: '已另存一条', discard: '已放弃这项更改' };

/** A change made offline that another device got ahead of (NEX-04): what happened and what to do. */
export function ConflictLine({ conflict, index }: { conflict: LibraryConflict; index: number }) {
  const [busy, setBusy] = useState(false);
  const decide = async (choice: LibraryChoice) => {
    setBusy(true);
    const r = await resolveConflict(index, choice);
    setBusy(false);
    toast(r.ok ? { msg: r.queued ? '已保存在本机，联网后同步' : CHOICE_DONE[choice], tone: 'ok' } : { msg: `没有完成：${r.message}`, tone: 'warn' });
  };
  const title = conflict.op.seen?.title ?? (conflict.details?.item as Item | undefined)?.title ?? '';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'rgb(var(--nx-ink-rgb)/0.05)' }}>
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
