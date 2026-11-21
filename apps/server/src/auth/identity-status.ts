import type { User, Users } from '../users/users';
import type { Oidc } from './oidc';
import type { Revocations } from './revocation';

/** A request may wait for one check at most this long. */
const CHECK_TIMEOUT_MS = 3_000;
/** An account checked successfully within this long is not checked again. */
export const CHECK_EVERY_MS = 60_000;
/** The identity service unreachable: requests are still let through this long after the last success. */
export const GRACE_MS = 15 * 60_000;

export type StatusVerdict = 'ok' | 'revoked' | 'unavailable';
export type StatusError = 'network' | 'timeout' | 'unauthorized' | 'forbidden' | 'server_error' | 'bad_response' | 'token';

type Probe = { kind: 'enabled' } | { kind: 'disabled' } | { kind: 'deleted' } | { kind: 'error'; error: StatusError };

/**
 * 中心停用检查（ADR-019 §2.5 · 动作 D）. Whether the identity service still has the account enabled,
 * asked with this client's read-only service account: `GET {admin}/users/{sub}` → `enabled`, 404 =
 * deleted. A 403 is a configuration problem (the role is missing), never "disabled".
 *
 * - On demand: an authenticated request (web session or device) of an account whose last successful
 *   check is more than 60 s old checks first — one check per account however many requests wait
 *   for it, 3 s at most.
 * - Disabled or deleted: 动作 B for this product at once (`central-disabled` / `account-deleted`), and
 *   this request is answered as revoked.
 * - Unreachable: within 15 minutes of the last success requests go through and the check is tried
 *   again after 60 s; past that, device requests get 503 IDENTITY_UNAVAILABLE (web sessions keep the
 *   refresh re-check of ADR-011).
 * Accounts without a unified identity (the legacy administrator before the claim) are not checked.
 */
export class IdentityStatus {
  private inflight = new Map<string, Promise<Probe>>();
  /** After a failed check: no new attempt for this account until then. */
  private retryAt = new Map<string, number>();
  /** Successful checks of this process (the database copy may be older in a request already running). */
  private checked = new Map<string, number>();
  private token: { accessToken: string; expiresAt: number } | null = null;
  private lastLogged = 0;
  /** The most recent failure, for the administrator's page (a category, never a token). */
  lastError: { error: StatusError; at: number } | null = null;
  lastSuccessAt: number | null = null;

  constructor(
    private opts: {
      oidc: Oidc;
      adminUrl: string;
      users: Users;
      revocations: Revocations;
      now?: () => number;
    },
  ) {}

  private get now() {
    return this.opts.now ?? Date.now;
  }

  get adminUrl() {
    return this.opts.adminUrl;
  }

  async check(user: User, kind: 'device' | 'session'): Promise<StatusVerdict> {
    if (!user.issuer || !user.subject || user.issuer !== this.opts.oidc.settings.issuer) return 'ok';
    const t = this.now();
    const last = Math.max(user.identityCheckedAt ?? 0, this.checked.get(user.id) ?? 0);
    if (t - last < CHECK_EVERY_MS) return 'ok';
    const grace = () => (t - last <= GRACE_MS || kind === 'session' ? 'ok' : 'unavailable');
    if ((this.retryAt.get(user.id) ?? 0) > t) return grace();
    let pending = this.inflight.get(user.id);
    if (!pending) {
      pending = this.probe(user).finally(() => this.inflight.delete(user.id));
      this.inflight.set(user.id, pending);
    }
    const r = await pending;
    if (r.kind === 'enabled') return 'ok';
    if (r.kind === 'disabled' || r.kind === 'deleted') return 'revoked';
    return grace();
  }

  private async probe(user: User): Promise<Probe> {
    const r = await Promise.race([this.ask(user.subject!), new Promise<Probe>((ok) => setTimeout(() => ok({ kind: 'error', error: 'timeout' }), CHECK_TIMEOUT_MS).unref?.())]);
    const t = this.now();
    if (r.kind === 'enabled') {
      this.retryAt.delete(user.id);
      this.checked.set(user.id, t);
      this.lastSuccessAt = t;
      await this.opts.users.markIdentityChecked(user.id, t);
    } else if (r.kind === 'disabled' || r.kind === 'deleted') {
      this.retryAt.delete(user.id);
      this.lastSuccessAt = t;
      await this.opts.revocations.revokeProduct(user.id, r.kind === 'disabled' ? 'central-disabled' : 'account-deleted');
    } else {
      this.retryAt.set(user.id, t + CHECK_EVERY_MS);
      this.lastError = { error: r.error, at: t };
      if (t - this.lastLogged > 60_000) {
        this.lastLogged = t;
        console.warn(`[nexus] 中心停用检查失败（${r.error}）：${r.error === 'forbidden' ? '服务账号没有 realm-management 的 view-users 角色，或它没有进 client 的作用域映射' : '身份服务暂时不可用'}；15 分钟宽限内放行，之后扩展请求返回 503`);
      }
    }
    return r;
  }

  private async ask(sub: string, retried = false): Promise<Probe> {
    let accessToken: string;
    try {
      accessToken = await this.serviceToken();
    } catch {
      return { kind: 'error', error: 'token' };
    }
    let res: Response;
    try {
      res = await this.opts.oidc.fetchImpl(`${this.opts.adminUrl}/users/${encodeURIComponent(sub)}`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch (e) {
      return { kind: 'error', error: (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    if (res.status === 404) return { kind: 'deleted' };
    if (res.status === 401 && !retried) {
      this.token = null;
      return this.ask(sub, true);
    }
    if (res.status === 401) return { kind: 'error', error: 'unauthorized' };
    if (res.status === 403) return { kind: 'error', error: 'forbidden' };
    if (!res.ok) return { kind: 'error', error: 'server_error' };
    const body = (await res.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== 'boolean') return { kind: 'error', error: 'bad_response' };
    return { kind: body.enabled ? 'enabled' : 'disabled' };
  }

  private async serviceToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) return this.token.accessToken;
    this.token = await this.opts.oidc.serviceToken();
    return this.token.accessToken;
  }
}
