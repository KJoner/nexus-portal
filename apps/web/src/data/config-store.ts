import { applyOp, invertOp, OpError, type Config, type Op, type Snapshot } from '@nexus/shared';
import { create } from 'zustand';
import { localAdapter, type ConfigAdapter, type SaveState } from './adapter';

export type DispatchResult = { ok: true; changed: boolean; undo: Op[] } | { ok: false; error: OpError };

interface ConfigStore {
  snapshot: Snapshot;
  save: SaveState;
  dispatch(ops: Op | Op[]): DispatchResult;
}

let adapter: ConfigAdapter = localAdapter;

export const useConfigStore = create<ConfigStore>((set, get) => ({
  snapshot: adapter.boot(),
  save: { kind: 'saved', at: Date.now(), where: 'local' },
  dispatch(input) {
    const ops = Array.isArray(input) ? input : [input];
    let config = get().snapshot.config;
    const undo: Op[] = [];
    try {
      for (const op of ops) {
        undo.unshift(...invertOp(config, op));
        config = applyOp(config, op);
      }
    } catch (e) {
      if (e instanceof OpError) return { ok: false, error: e };
      throw e;
    }
    const prev = get().snapshot;
    if (config === prev.config) return { ok: true, changed: false, undo: [] };
    const next: Snapshot = { revision: prev.revision + 1, updatedAt: new Date().toISOString(), config };
    set({ snapshot: next, save: { kind: 'saving' } });
    void adapter.commit(ops, next).then((save) => {
      if (get().snapshot === next) set({ save });
    });
    return { ok: true, changed: true, undo };
  },
}));

let unsubscribe = adapter.subscribe((s) => useConfigStore.setState({ snapshot: s }));

/** Test / batch-2 hook: swap the persistence adapter. */
export function setConfigAdapter(next: ConfigAdapter) {
  unsubscribe();
  adapter = next;
  useConfigStore.setState({ snapshot: next.boot() });
  unsubscribe = adapter.subscribe((s) => useConfigStore.setState({ snapshot: s }));
}

export const useConfig = (): Config => useConfigStore((s) => s.snapshot.config);
export const dispatch = (ops: Op | Op[]) => useConfigStore.getState().dispatch(ops);
