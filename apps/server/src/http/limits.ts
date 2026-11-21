/**
 * Request rate limits and in-flight caps per identity (TN-07). In memory: one Nexus process.
 *
 * Every bucket is per account (or per paired device, or per client address for anonymous
 * requests), so one account hammering the server — or waiting on slow upstreams — never costs
 * another account its share: B's normal requests are not slowed by A.
 */
export type LimitKind = 'read' | 'write' | 'upload' | 'fetch' | 'suggest' | 'public' | 'auth' | 'internal';

export interface BucketSpec {
  /** Tokens refilled per second. */
  rate: number;
  /** Bucket size: how many requests may arrive at once. */
  burst: number;
}

export const DEFAULT_LIMITS: Record<LimitKind, BucketSpec> = {
  // Reading is cheap and the web app reads in bursts (startup, SSE reconnects).
  read: { rate: 20, burst: 300 },
  // Config ops, devices, account actions.
  write: { rate: 2, burst: 120 },
  // Wallpapers and icons: image decoding is the expensive part of Nexus.
  upload: { rate: 1 / 3, burst: 20 },
  // Anything that makes the server fetch from elsewhere (imports, gallery, Unsplash, health test).
  fetch: { rate: 1 / 5, burst: 10 },
  suggest: { rate: 5, burst: 30 },
  // Unauthenticated: the public catalog, per client address.
  public: { rate: 5, burst: 120 },
  // Starting a sign-in creates a stored login attempt: per client address.
  auth: { rate: 1 / 3, burst: 20 },
  // The other product's revocation events (ADR-019 §2.4), per client address and before the
  // signature is even checked: a backlog after an outage fits, a flood does not.
  internal: { rate: 1, burst: 60 },
};

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private inflight = new Map<string, number>();

  constructor(
    private specs: Record<LimitKind, BucketSpec> = DEFAULT_LIMITS,
    private now: () => number = Date.now,
    /** Concurrent upstream fetches per identity (a slow upstream must not pile up work). */
    readonly maxInflight = 2,
  ) {}

  /** Takes one token; returns 0 when allowed, otherwise the seconds until one is available. */
  take(kind: LimitKind, identity: string): number {
    const spec = this.specs[kind];
    const key = `${kind}:${identity}`;
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: spec.burst, at: t };
    b.tokens = Math.min(spec.burst, b.tokens + ((t - b.at) / 1000) * spec.rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      this.sweep(t);
      return 0;
    }
    this.buckets.set(key, b);
    return (1 - b.tokens) / spec.rate;
  }

  /** Reserves an in-flight slot; returns a release function, or null when the identity is at its cap. */
  enter(identity: string): (() => void) | null {
    const n = this.inflight.get(identity) ?? 0;
    if (n >= this.maxInflight) return null;
    this.inflight.set(identity, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inflight.get(identity) ?? 1) - 1;
      if (left > 0) this.inflight.set(identity, left);
      else this.inflight.delete(identity);
    };
  }

  /** Full buckets carry no information: drop them now and then so the map stays small. */
  private sweep(t: number) {
    if (this.buckets.size < 10_000) return;
    for (const [key, b] of this.buckets) {
      const spec = this.specs[key.slice(0, key.indexOf(':')) as LimitKind];
      if (!spec || b.tokens + ((t - b.at) / 1000) * spec.rate >= spec.burst) this.buckets.delete(key);
    }
  }
}
