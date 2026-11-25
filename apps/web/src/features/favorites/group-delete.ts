import { descendantIds, UNFILED, type Category, type Item, type Op } from '@nexus/shared';
import type { WriteOutcome } from '../../data/library';
import { byPosition, pathLabel } from './model';

/**
 * 删除分组 › 连同内容删除 (spec 02 N4, 03 §4, 06 B09): an option of its own, never the default.
 * Nothing is deleted for good — the favorites go to 回收站 first, one by one, and only when every
 * one of them is there are the group and its subgroups deleted. The first one that does not go
 * stops it: no group is deleted, and the person is told exactly which ones are in 回收站.
 *
 * Where a favorite comes back when it is restored: its group no longer exists, so the server and
 * the browser's local engine both file it (with the tombstone, quietly) under the nearest group
 * that is left — the deleted group's parent, or 未分组 for a top-level group (`reassignRemovedGroups`
 * in apps/server/src/items/store.ts and packages/shared/src/local-engine.ts; restore keeps that
 * folder). The preview and the messages say that place.
 */
export interface ContentDeletePlan {
  groupId: string;
  label: string;
  /** Every group below it (they are deleted too), in tree order. */
  subgroups: { id: string; label: string; path: string }[];
  /** Live favorites in the group and every group below it, in tree order then their own order. */
  items: Item[];
  /** How many of them are pinned to the home page (a deleted favorite leaves the home page). */
  pinned: number;
  /** Where they come back when restored from 回收站: the parent group, or 未分组. */
  restoreTo: { id: string; path: string };
  /** The group deletes, deepest first (each group is empty of subgroups when it goes). */
  ops: Op[];
}

export function contentDeletePlan(categories: readonly Category[], items: readonly Item[], pins: ReadonlySet<string>, groupId: string): ContentDeletePlan | null {
  const g = categories.find((c) => c.id === groupId);
  if (!g || g.locked || g.id === UNFILED) return null;
  const below = descendantIds(categories, groupId);
  const order = new Map([groupId, ...below].map((id, k) => [id, k]));
  const list = items.filter((i) => i.deletedAt === null && order.has(i.folderId)).sort((a, b) => order.get(a.folderId)! - order.get(b.folderId)! || byPosition(a, b));
  const parent = g.parentId && categories.some((c) => c.id === g.parentId) ? g.parentId : UNFILED;
  return {
    groupId,
    label: g.label,
    subgroups: below.map((id) => ({ id, label: categories.find((c) => c.id === id)!.label, path: pathLabel(categories, id) })),
    items: list,
    pinned: list.filter((i) => pins.has(i.id)).length,
    restoreTo: { id: parent, path: pathLabel(categories, parent) },
    ops: [...below].reverse().map((id): Op => ({ type: 'group.delete', groupId: id })).concat({ type: 'group.delete', groupId }),
  };
}

export type ContentDeleteResult =
  /** Every favorite is in 回收站 and the groups are deleted. `stayed`: favorites that arrived meanwhile (kept, filed under restoreTo). */
  | { ok: true; trashed: Item[]; stayed: number }
  /** Stopped at `failed` while moving to 回收站: `trashed` are there, the rest (`left`, after `failed`) and every group are untouched. */
  | { ok: false; stage: 'items'; trashed: Item[]; failed: Item; reason: string; queued: boolean; left: number }
  /** Every favorite is in 回收站, but the groups were not deleted. */
  | { ok: false; stage: 'groups'; trashed: Item[]; reason: string };

export interface ContentDeleteDeps {
  /** libraryApi.remove: to 回收站, against the version shown. */
  remove(i: Item): Promise<WriteOutcome>;
  /** Live favorites in these groups now (one may have been added meanwhile, here or elsewhere). */
  liveIn(groupIds: ReadonlySet<string>): Item[];
  /** Deletes the groups (one batch); the reason when it is refused. */
  deleteGroups(ops: Op[]): { ok: true } | { ok: false; reason: string };
  progress?(done: number, total: number): void;
}

export async function runContentDelete(plan: ContentDeletePlan, deps: ContentDeleteDeps): Promise<ContentDeleteResult> {
  const trashed: Item[] = [];
  const total = plan.items.length;
  for (const [k, item] of plan.items.entries()) {
    let r: WriteOutcome;
    try {
      r = await deps.remove(item);
    } catch (e) {
      r = { ok: false, code: 'ERROR', message: e instanceof Error ? e.message : String(e) };
    }
    const left = total - k - 1;
    if (!r.ok) return { ok: false, stage: 'items', trashed, failed: item, reason: r.message, queued: false, left };
    // Kept on this device (the connection dropped): it is not in 回收站 yet, so nothing goes on.
    if (r.queued) return { ok: false, stage: 'items', trashed, failed: item, reason: '网络中断，这一条已保存在本机，联网后会移到回收站', queued: true, left };
    trashed.push(r.item ?? item);
    deps.progress?.(trashed.length, total);
  }
  const doomed = new Set([plan.groupId, ...plan.subgroups.map((s) => s.id)]);
  const stayed = deps.liveIn(doomed).length;
  const d = deps.deleteGroups(plan.ops);
  if (!d.ok) return { ok: false, stage: 'groups', trashed, reason: d.reason };
  return { ok: true, trashed, stayed };
}

const names = (list: readonly Item[], max = 3) => list.slice(0, max).map((i) => `「${i.title}」`).join('、') + (list.length > max ? ` 等 ${list.length} 个` : '');

/** What the person reads when it stopped (the dialog stays open with it). */
export function contentDeleteReport(plan: ContentDeletePlan, r: Exclude<ContentDeleteResult, { ok: true }>): { title: string; lines: string[] } {
  const inTrash = r.trashed.length ? `已移到回收站的 ${r.trashed.length} 个：${names(r.trashed)}（可以在回收站恢复，恢复后放到「${plan.restoreTo.path}」）` : '还没有收藏被移到回收站';
  if (r.stage === 'groups')
    return { title: '收藏都已移到回收站，但分组没有删除', lines: [`原因：${r.reason}`, inTrash, `分组「${plan.label}」${plan.subgroups.length ? `和它的 ${plan.subgroups.length} 个子分组` : ''}还在，现在是空的，可以再删除一次。`] };
  return {
    title: '没有全部完成，分组没有删除',
    lines: [
      r.queued ? `「${r.failed.title}」暂时没有移到回收站：${r.reason}。` : `「${r.failed.title}」没有移到回收站：${r.reason}`,
      inTrash,
      `分组「${plan.label}」${plan.subgroups.length ? `和它的 ${plan.subgroups.length} 个子分组都` : ''}没有删除；${r.left ? `另外 ${r.left} 个收藏` : '其余收藏'}还在原来的分组里。`,
    ],
  };
}

export function contentDeleteDone(plan: ContentDeletePlan, r: Extract<ContentDeleteResult, { ok: true }>): string {
  const groups = plan.subgroups.length ? `分组「${plan.label}」及 ${plan.subgroups.length} 个子分组` : `分组「${plan.label}」`;
  const items = r.trashed.length ? `；${r.trashed.length} 个收藏已移到回收站，恢复后放到「${plan.restoreTo.path}」` : '';
  const stayed = r.stayed ? `；另有 ${r.stayed} 个刚加入的收藏没有删除，已放到「${plan.restoreTo.path}」` : '';
  return `已删除${groups}${items}${stayed}`;
}
