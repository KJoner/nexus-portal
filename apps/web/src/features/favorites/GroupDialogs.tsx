import { GROUP_LIMITS, groupDeleteImpact, groupPath, heightOf, isWithin, parentProblem, siblingNameTaken, UNFILED, type Category, type Item } from '@nexus/shared';
import { useMemo, useState } from 'react';
import { toast } from '../../components/toast-store';
import { dispatch, useConfigStore } from '../../data/config-store';
import { libraryApi, refileTrashed, useLibrary } from '../../data/library';
import { cn } from '../../lib/cn';
import { host } from '../../lib/host';
import { apply } from '../settings/model';
import { Button, Dialog, Spinner } from '../settings/ui';
import { contentDeleteDone, contentDeletePlan, contentDeleteReport, runContentDelete } from './group-delete';
import { pathLabel } from './model';
import { TextField } from './parts';

/**
 * 管理分组 (UI v2 · spec 02 N4, 03 §4): create (also as a sub-group), rename, move with the full new
 * path shown first, delete with what it affects shown first — by default its favorites and
 * sub-groups are kept (moved one level up / to 未分组); 连同内容删除 is a separate choice with its own
 * preview, and even then the favorites go to 回收站 (group-delete.ts), never deleted for good. Every
 * rule (cycle, depth 8, 50 groups, same name under the same parent) is checked here for the message
 * and again by the shared ops and the server.
 */
export type GroupTask = { kind: 'create'; parentId: string | null } | { kind: 'rename'; id: string } | { kind: 'move'; id: string } | { kind: 'delete'; id: string };

const LABEL_MAX = 16;
const newGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const nameProblem = (categories: readonly Category[], parentId: string | null, label: string, exceptId?: string) => {
  const t = label.trim();
  if (!t) return '请填写分组名称';
  if ([...t].length > LABEL_MAX) return `分组名称最多 ${LABEL_MAX} 个字`;
  if (siblingNameTaken(categories, parentId, t, exceptId)) return parentId ? '同一个上级下已经有这个名称的分组' : '已经有这个名称的分组';
  return null;
};

function ParentSelect({ categories, value, onChange, exclude }: { categories: readonly Category[]; value: string | null; onChange(id: string | null): void; exclude?: string }) {
  const options = categories.filter((c) => c.id !== UNFILED && !(exclude && isWithin(categories, exclude, c.id)));
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink/80">上级分组</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className="box-border h-11 rounded-[10px] border-0 px-3 text-[14px] text-ink outline-none" style={{ background: 'rgb(var(--nx-ink-rgb)/0.05)', boxShadow: 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.1)' }}>
        <option value="">（无，作为顶层分组）</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {pathLabel(categories, c.id)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function GroupDialog({ task, categories, items, onClose, onDone }: { task: GroupTask | null; categories: readonly Category[]; items: readonly Item[]; onClose(): void; onDone?(groupId: string | null): void }) {
  if (!task) return null;
  if (task.kind === 'create') return <CreateGroup key="create" parentId={task.parentId} categories={categories} onClose={onClose} onDone={onDone} />;
  const g = categories.find((c) => c.id === task.id);
  if (!g) return null;
  if (task.kind === 'rename') return <RenameGroup key={`r-${g.id}`} group={g} categories={categories} onClose={onClose} />;
  if (task.kind === 'move') return <MoveGroup key={`m-${g.id}`} group={g} categories={categories} onClose={onClose} />;
  return <DeleteGroup key={`d-${g.id}`} group={g} categories={categories} items={items} onClose={onClose} onDone={onDone} />;
}

function CreateGroup({ parentId: initial, categories, onClose, onDone }: { parentId: string | null; categories: readonly Category[]; onClose(): void; onDone?(id: string | null): void }) {
  const [label, setLabel] = useState('');
  const [parentId, setParentId] = useState<string | null>(initial);
  const [tried, setTried] = useState(false);
  const total = categories.filter((c) => c.id !== UNFILED).length;
  const problem = total >= GROUP_LIMITS.total ? `最多 ${GROUP_LIMITS.total} 个分组；先删除不用的分组` : (parentProblem(categories, null, parentId) ?? nameProblem(categories, parentId, label));
  const save = () => {
    setTried(true);
    if (problem) return;
    const id = newGroupId();
    if (apply({ type: 'group.create', group: { id, label: label.trim(), parentId } }, `已新建分组「${[...(parentId ? groupPath(categories, parentId) : []), label.trim()].join(' / ')}」`)) {
      onDone?.(id);
      onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={parentId ? '新建子分组' : '新建分组'}
      description="分组可以有子分组，同一个上级下名称不能重复；不同上级下可以同名。"
      footer={
        <>
          <Button className="h-10 px-4" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="h-10 px-5" onClick={save}>
            新建
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        // Enter that ends an IME composition (中文输入法选词) never submits.
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField label="分组名称" value={label} onChange={setLabel} autoFocus maxLength={LABEL_MAX + 4} error={tried ? (problem ?? undefined) : undefined} hint={!tried ? `最多 ${LABEL_MAX} 个字` : undefined} />
        <ParentSelect categories={categories} value={parentId} onChange={setParentId} />
        <p className="m-0 text-[12.5px] text-ink/56">位置：{[...(parentId ? groupPath(categories, parentId) : []), label.trim() || '新分组'].join(' / ')}</p>
      </form>
    </Dialog>
  );
}

function RenameGroup({ group, categories, onClose }: { group: Category; categories: readonly Category[]; onClose(): void }) {
  const [label, setLabel] = useState(group.label);
  const [tried, setTried] = useState(false);
  const parentId = group.parentId ?? null;
  const problem = nameProblem(categories, parentId, label, group.id);
  const save = () => {
    setTried(true);
    if (problem) return;
    if (label.trim() === group.label) return onClose();
    if (apply({ type: 'group.rename', groupId: group.id, label: label.trim() }, `已改名为「${label.trim()}」`)) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="重命名分组"
      footer={
        <>
          <Button className="h-10 px-4" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="h-10 px-5" onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <form
        // Enter that ends an IME composition (中文输入法选词) never submits.
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField label="分组名称" value={label} onChange={setLabel} autoFocus maxLength={LABEL_MAX + 4} error={tried ? (problem ?? undefined) : undefined} hint={`现在的位置：${pathLabel(categories, group.id)}`} />
      </form>
    </Dialog>
  );
}

function MoveGroup({ group, categories, onClose }: { group: Category; categories: readonly Category[]; onClose(): void }) {
  const [parentId, setParentId] = useState<string | null>(group.parentId ?? null);
  const height = heightOf(categories, group.id);
  const problem = parentProblem(categories, group.id, parentId, height) ?? nameProblem(categories, parentId, group.label, group.id);
  const newPath = [...(parentId ? groupPath(categories, parentId) : []), group.label].join(' / ');
  const save = () => {
    if (problem) return;
    if ((group.parentId ?? null) === parentId) return onClose();
    if (apply({ type: 'group.move', groupId: group.id, parentId }, `已把「${group.label}」移到「${newPath}」`)) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="移动分组"
      description="分组里的收藏和子分组会一起移动。"
      footer={
        <>
          <Button className="h-10 px-4" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="h-10 px-5" disabled={!!problem} onClick={save}>
            移动
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ParentSelect categories={categories} value={parentId} onChange={setParentId} exclude={group.id} />
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-ink/52">现在</dt>
          <dd className="m-0 break-words">{pathLabel(categories, group.id)}</dd>
          <dt className="text-ink/52">移动后</dt>
          <dd className="m-0 font-medium break-words">{newPath}</dd>
        </dl>
        {problem && (
          <p role="alert" className="m-0 text-[13px] text-danger-ink">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function DeleteGroup({ group, categories, items, onClose, onDone }: { group: Category; categories: readonly Category[]; items: readonly Item[]; onClose(): void; onDone?(id: string | null): void }) {
  const impact = useMemo(() => groupDeleteImpact(categories, items, group.id), [categories, items, group.id]);
  const pins = useLibrary((s) => s.pins);
  const queued = useLibrary((s) => s.queued);
  const space = useConfigStore((s) => s.space);
  const online = useConfigStore((s) => s.online);
  const plan = useMemo(() => contentDeletePlan(categories, items, new Set(pins), group.id), [categories, items, pins, group.id]);
  const [mode, setMode] = useState<'keep' | 'content'>('keep');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<{ title: string; lines: string[] } | null>(null);
  if (!impact) return null;
  // 连同内容删除 has to know that every favorite reached 回收站 before a group goes: not offline
  // (a removal would only be queued here), not behind changes still waiting, never read-only.
  const blocked = host.readOnly
    ? '这里只能查看收藏，不能删除'
    : space === 'account' && (!online || (typeof navigator !== 'undefined' && navigator.onLine === false))
      ? '现在离线：要先确认每个收藏都已移到回收站才能删除分组，联网后再试'
      : queued
        ? `还有 ${queued} 项更改等待同步，同步完成后才能连同内容删除`
        : !plan
          ? `「${group.label}」不能连同内容删除`
          : null;
  // Unavailable now (gone offline meanwhile): shown as what the button does — keep the content.
  const picked = blocked ? 'keep' : mode;
  const content = picked === 'content' && !!plan;
  const remove = () => {
    const before = useConfigStore.getState().snapshot.config.categories;
    if (apply({ type: 'group.delete', groupId: group.id }, `已删除分组「${group.label}」，里面的内容已移到「${impact.moveTo.label}」`, false)) {
      refileTrashed(before, useConfigStore.getState().snapshot.config.categories);
      onDone?.(null);
      onClose();
    }
  };
  const removeWithContent = async () => {
    if (!plan || blocked || busy) return;
    setFailure(null);
    setBusy({ done: 0, total: plan.items.length });
    const before = useConfigStore.getState().snapshot.config.categories;
    const r = await runContentDelete(plan, {
      remove: (i) => libraryApi.remove(i),
      liveIn: (ids) => Object.values(useLibrary.getState().items).filter((i) => i.deletedAt === null && ids.has(i.folderId)),
      deleteGroups: (ops) => {
        const d = dispatch(ops);
        return d.ok ? { ok: true } : { ok: false, reason: d.error.message };
      },
      progress: (done, total) => setBusy({ done, total }),
    });
    setBusy(null);
    if (!r.ok) return setFailure(contentDeleteReport(plan, r));
    refileTrashed(before, useConfigStore.getState().snapshot.config.categories);
    toast({ msg: contentDeleteDone(plan, r), tone: 'ok' });
    onDone?.(null);
    onClose();
  };
  const choice = (value: 'keep' | 'content', title: string, sub: string, disabled?: boolean) => (
    <label className={cn('flex items-start gap-3 rounded-xl px-3.5 py-3', disabled ? 'opacity-60' : 'cursor-pointer')} style={{ background: picked === value ? 'rgb(var(--nx-amber-rgb)/0.1)' : 'rgb(var(--nx-ink-rgb)/0.04)', boxShadow: picked === value ? 'inset 0 0 0 1.5px rgb(var(--nx-amber-rgb)/0.7)' : 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.1)' }}>
      <input type="radio" name={`delete-${group.id}`} value={value} checked={picked === value} disabled={disabled || !!busy} onChange={() => setMode(value)} className="mt-0.5 size-4 flex-none accent-[var(--color-amber)]" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{title}</span>
        <span className="text-[12.5px] leading-[1.6] text-ink/58">{sub}</span>
      </span>
    </label>
  );
  const n = plan?.items.length ?? 0;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`删除分组「${group.label}」`}
      width={500}
      description={content ? '分组和它的子分组会被删除；里面的收藏先移到回收站，不会被永久删除。' : '只删除分组本身。里面的收藏和子分组都会保留，不会被删除。'}
      footer={
        <>
          <Button className="h-10 px-4" disabled={!!busy} onClick={onClose}>
            取消
          </Button>
          {content ? (
            <Button variant="danger" className="h-10 px-5" disabled={!!busy} onClick={() => void removeWithContent()}>
              {failure ? '再试一次' : n ? '移到回收站并删除分组' : plan?.subgroups.length ? '删除分组和子分组' : '删除分组'}
            </Button>
          ) : (
            <Button variant="danger" className="h-10 px-5" disabled={!!busy} onClick={remove}>
              删除分组
            </Button>
          )}
        </>
      }
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-[13px] font-medium text-ink/80">删除方式</legend>
        {choice('keep', '只删除分组，保留内容（推荐）', `收藏移到「${impact.moveTo.label}」，子分组上移一层`)}
        {choice('content', '连同内容删除', blocked ?? `子分组一起删除；${n} 个收藏移到回收站，可以恢复`, !!blocked)}
      </fieldset>
      {content && plan ? (
        <ul aria-label="删除后的影响" className="m-0 flex flex-col gap-2 pl-5 text-[13.5px] leading-[1.6]">
          <li>
            删除分组「{pathLabel(categories, group.id)}」
            {plan.subgroups.length > 0 && `和它的 ${plan.subgroups.length} 个子分组（${plan.subgroups.map((g) => g.label).join('、')}）`}
          </li>
          <li>{n ? `${n} 个收藏移到回收站（不是永久删除，可以在「回收站」里恢复）` : '里面没有收藏'}</li>
          {n > 0 && <li>原来的分组已不在，恢复的收藏会放到「{plan.restoreTo.path}」</li>}
          {plan.pinned > 0 && <li>其中 {plan.pinned} 个固定在首页，会从首页取下；恢复后不会自动重新固定</li>}
          <li className="text-ink/60">先把收藏逐个移到回收站，全部完成后才删除分组；有一个没有完成就停下，分组不删除。</li>
        </ul>
      ) : (
        <ul aria-label="删除后的影响" className="m-0 flex flex-col gap-2 pl-5 text-[13.5px] leading-[1.6]">
          <li>
            直属的 {impact.directItems} 个收藏移到「{impact.moveTo.label}」
          </li>
          {impact.childGroups.length > 0 && (
            <li>
              {impact.childGroups.length} 个子分组（{impact.childGroups.map((c) => c.label).join('、')}）上移一层，放到「{impact.moveTo.id ? impact.moveTo.label : '顶层'}」，它们自己的 {impact.totalItems - impact.directItems} 个收藏和下级分组不变
            </li>
          )}
          {impact.renamed.map((r) => (
            <li key={r.id}>
              子分组「{r.from}」与上级已有分组同名，会改名为「{r.to}」
            </li>
          ))}
          <li className="text-ink/60">删除后不能自动撤销；需要时可以重新新建分组再把收藏移回去。</li>
        </ul>
      )}
      {busy && (
        <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-ink/70">
          <Spinner /> 正在移到回收站：{busy.done} / {busy.total}…
        </p>
      )}
      {failure && (
        <div role="alert" className="flex flex-col gap-1.5 rounded-xl p-3.5 text-[13px] leading-[1.6]" style={{ background: 'rgb(var(--nx-error-rgb)/0.1)' }}>
          <span className="font-medium text-danger-ink">{failure.title}</span>
          {failure.lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
    </Dialog>
  );
}
