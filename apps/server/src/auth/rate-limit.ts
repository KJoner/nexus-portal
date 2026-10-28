/** Failed-login limiter: per-client and global windows, both in memory (single process). */
export class LoginLimiter {
  private perClient = new Map<string, { fails: number; resetAt: number }>();
  private global = { fails: 0, resetAt: 0 };

  constructor(
    private maxPerClient = 5,
    private maxGlobal = 30,
    private windowMs = 15 * 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Seconds until the client may try again, or 0. */
  retryAfter(client: string): number {
    const t = this.now();
    const c = this.perClient.get(client);
    const wait = Math.max(c && c.resetAt > t && c.fails >= this.maxPerClient ? c.resetAt - t : 0, this.global.resetAt > t && this.global.fails >= this.maxGlobal ? this.global.resetAt - t : 0);
    return Math.ceil(wait / 1000);
  }

  fail(client: string) {
    const t = this.now();
    const c = this.perClient.get(client);
    if (!c || c.resetAt <= t) this.perClient.set(client, { fails: 1, resetAt: t + this.windowMs });
    else c.fails++;
    if (this.global.resetAt <= t) this.global = { fails: 1, resetAt: t + this.windowMs };
    else this.global.fails++;
    if (this.perClient.size > 10_000) this.perClient.clear();
  }

  succeed(client: string) {
    this.perClient.delete(client);
  }
}
