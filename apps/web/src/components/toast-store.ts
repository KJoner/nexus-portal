import type { Op } from '@nexus/shared';
import { create } from 'zustand';
import { dispatch } from '../data/config-store';

export type ToastTone = 'ok' | 'warn' | 'error' | 'info' | 'undo';

export interface Toast {
  id: number;
  msg: string;
  tone: ToastTone;
  undo?: Op[];
  action?: { label: string; run: () => void };
}

interface ToastStore {
  current: Toast | null;
  show(t: Omit<Toast, 'id'>): void;
  dismiss(id?: number): void;
}

let seq = 0;

/** One toast at a time; a new one replaces the old (R2 提示条规则). */
export const useToastStore = create<ToastStore>((set, get) => ({
  current: null,
  show: (t) => set({ current: { ...t, id: ++seq } }),
  dismiss: (id) => {
    if (id === undefined || get().current?.id === id) set({ current: null });
  },
}));

export const toast = (t: Omit<Toast, 'id'>) => useToastStore.getState().show(t);

export function runUndo(t: Toast) {
  if (!t.undo?.length) return;
  const r = dispatch(t.undo);
  toast(r.ok ? { msg: '已撤销', tone: 'ok' } : { msg: `无法撤销：${r.error.message}`, tone: 'error' });
}
