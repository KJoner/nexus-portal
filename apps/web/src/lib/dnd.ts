import type { Announcements, ScreenReaderInstructions } from '@dnd-kit/core';

/**
 * Chinese screen-reader text for every sortable list (dnd-kit ships English). Items are named by
 * the `data-dnd-name` of their activator, falling back to the id.
 */
const nameOf = (id: string | number) => document.querySelector<HTMLElement>(`[data-dnd-id="${CSS.escape(String(id))}"]`)?.dataset.dndName ?? String(id);

const announcements: Announcements = {
  onDragStart: ({ active }) => `已拿起 ${nameOf(active.id)}。`,
  onDragOver: ({ active, over }) => (over ? `${nameOf(active.id)} 移到了 ${nameOf(over.id)} 的位置。` : `${nameOf(active.id)} 不在可放置区域内。`),
  onDragEnd: ({ active, over }) => (over ? `已放下 ${nameOf(active.id)}，位置在 ${nameOf(over.id)}。` : `已放下 ${nameOf(active.id)}。`),
  onDragCancel: ({ active }) => `已取消拖动，${nameOf(active.id)} 回到原位。`,
};

const screenReaderInstructions: ScreenReaderInstructions = {
  draggable: '按空格键拿起；拿起后用方向键移动，再按空格键放下，按 Esc 取消。',
};

export const dndAccessibility = { announcements, screenReaderInstructions };
