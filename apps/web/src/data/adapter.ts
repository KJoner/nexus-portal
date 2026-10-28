import { ConfigSchema, defaultConfig, normalizeConfig, type Op, type Snapshot } from '@nexus/shared';
import { storage } from '../lib/storage';

export type SaveState =
  | { kind: 'saved'; at: number; where: 'local' | 'server' }
  | { kind: 'saving' }
  | { kind: 'offline'; pending: number }
  | { kind: 'error'; message: string };

/**
 * Where configuration lives. Batch 1 ships the local adapter; batch 2 swaps in a server adapter
 * with an outbox, keeping the store and every component unchanged.
 */
export interface ConfigAdapter {
  /** Synchronous boot snapshot so the first paint never waits on the network. */
  boot(): Snapshot;
  commit(ops: Op[], next: Snapshot): Promise<SaveState>;
  /** Changes made elsewhere (another tab or device). */
  subscribe(onRemote: (s: Snapshot) => void): () => void;
}

const KEY = 'nexus.config.v1';

function readLocal(): Snapshot | null {
  const raw = storage.get<Snapshot>(KEY);
  if (!raw || typeof raw.revision !== 'number') return null;
  const parsed = ConfigSchema.safeParse(raw.config);
  return parsed.success ? { revision: raw.revision, updatedAt: raw.updatedAt, config: normalizeConfig(parsed.data) } : null;
}

export function freshSnapshot(): Snapshot {
  return { revision: 0, updatedAt: new Date(0).toISOString(), config: defaultConfig() };
}

export const localAdapter: ConfigAdapter = {
  boot: () => readLocal() ?? freshSnapshot(),
  async commit(_ops, next) {
    return storage.set(KEY, next) ? { kind: 'saved', at: Date.now(), where: 'local' } : { kind: 'error', message: '浏览器存储不可用，更改只在本页面有效' };
  },
  subscribe(onRemote) {
    const fn = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      const s = readLocal();
      if (s) onRemote(s);
    };
    window.addEventListener('storage', fn);
    return () => window.removeEventListener('storage', fn);
  },
};
