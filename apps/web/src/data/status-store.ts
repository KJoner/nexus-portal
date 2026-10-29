import type { ServiceStatus } from '@nexus/shared';
import { create } from 'zustand';

type Event = ServiceStatus | { appId: string; removed: true };

/** Latest health results from the Nexus checker, keyed by app id. */
export const useStatusStore = create<{ byId: Record<string, ServiceStatus>; replace(list: ServiceStatus[]): void; apply(e: Event): void }>((set) => ({
  byId: {},
  replace: (list) => set({ byId: Object.fromEntries(list.map((s) => [s.appId, s])) }),
  apply: (e) =>
    set((st) => {
      const byId = { ...st.byId };
      if ('removed' in e) delete byId[e.appId];
      else byId[e.appId] = e;
      return { byId };
    }),
}));
