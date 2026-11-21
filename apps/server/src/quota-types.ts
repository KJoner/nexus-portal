/** Per-account storage quotas (TN-07): types and defaults, free of imports (env.ts reads them). */
export type StorageQuotaKind = 'wallpapers' | 'icons' | 'storage';

export interface AccountQuotas {
  /** Live items of 我的收藏 (需求 §8.3: a limit of its own, not the home page's 500 apps). */
  items: number;
  wallpapers: number;
  icons: number;
  storageBytes: number;
}

/** Defaults for accounts other than the administrator (whose server it is: no limits). */
export const DEFAULT_QUOTAS: AccountQuotas = { items: 5000, wallpapers: 50, icons: 200, storageBytes: 200 * 1024 * 1024 };

export class QuotaExceededError extends Error {
  constructor(
    readonly kind: StorageQuotaKind,
    readonly limit: number,
    readonly used: number,
    message: string,
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }

  /** Counts are a conflict with what is stored (409); space is "too large" (413), as in LiteSync. */
  get status(): 409 | 413 {
    return this.kind === 'storage' ? 413 : 409;
  }

  get details() {
    return { kind: this.kind, limit: this.limit, used: this.used };
  }
}
