import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { forUpdate, type DB } from './db';
import { QuotaExceededError, type AccountQuotas } from './quota-types';

export { DEFAULT_QUOTAS, QuotaExceededError, type AccountQuotas, type StorageQuotaKind } from './quota-types';

/** Total size of the files directly inside `dir` (wallpaper variants), 0 when it does not exist. */
export async function folderBytes(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const sizes = await Promise.all(names.map((n) => stat(join(dir, n)).then((s) => (s.isFile() ? s.size : 0), () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/**
 * Per-account storage quotas (TN-07): kept wallpapers, uploaded icons, and the disk space their
 * files take. Checked inside the account's transaction, after the expensive work (decoding,
 * encoding, downloading) is done and before the row is written: concurrent uploads of one account
 * queue on its row, so the account never ends up over its limit.
 */
export class Quota {
  constructor(
    private db: DB,
    private dirs: { wallpapers: string; icons: string },
    /** The account's limits, or null when it has none (the administrator). */
    private limitsFor: (ownerId: string) => Promise<AccountQuotas | null>,
  ) {}

  /** What the account stores now. */
  async usage(ownerId: string): Promise<{ wallpapers: number; icons: number; storageBytes: number }> {
    const walls = await this.db.all<{ id: string; remote: string }>('select id, remote from wallpapers where owner_id = ?', [ownerId]);
    const icons = await this.db.all<{ id: string }>('select id from icons where owner_id = ?', [ownerId]);
    const wallBytes = await Promise.all(walls.filter((w) => !w.remote).map((w) => folderBytes(join(this.dirs.wallpapers, w.id))));
    const iconBytes = await Promise.all(icons.map((i) => stat(join(this.dirs.icons, `${i.id}.png`)).then((s) => s.size, () => 0)));
    return { wallpapers: walls.length, icons: icons.length, storageBytes: [...wallBytes, ...iconBytes].reduce((a, b) => a + b, 0) };
  }

  /**
   * Runs `write` in the account's transaction if one more `kind` of `bytes` still fits; otherwise
   * throws QuotaExceededError and writes nothing.
   */
  async admit<T>(ownerId: string, kind: 'wallpapers' | 'icons', bytes: number, write: () => Promise<T>): Promise<T> {
    return this.db.tx(async () => {
      const limits = await this.limitsFor(ownerId);
      if (limits) {
        await this.db.get(`select id from users where id = ?${forUpdate(this.db)}`, [ownerId]);
        const used = await this.usage(ownerId);
        if (used[kind] + 1 > limits[kind]) {
          throw new QuotaExceededError(kind, limits[kind], used[kind], kind === 'wallpapers' ? `最多保存 ${limits.wallpapers} 张壁纸，请先删除一些` : `最多上传 ${limits.icons} 个图标，请先删除不用的应用图标`);
        }
        if (used.storageBytes + bytes > limits.storageBytes) {
          throw new QuotaExceededError('storage', limits.storageBytes, used.storageBytes, `存储空间不足：已用 ${mb(used.storageBytes)}，上限 ${mb(limits.storageBytes)}`);
        }
      }
      return write();
    });
  }
}
