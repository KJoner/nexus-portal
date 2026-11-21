import type { DB } from '../db';
import type { SecretBox } from '../integrations/secret';
import type { Users } from '../users/users';
import type { Devices, Pairings } from './devices';
import type { Oidc } from './oidc';
import type { Session } from './sessions';

/**
 * 账号撤销（ADR-019）。四种动作，范围互不混用：
 *
 *   A 退出此会话            本产品的这个网页会话（back-channel 只有 sub 时：该用户的全部网页会话）。
 *                           只在 Auth 里，永远不碰设备与待领取授权（R-3）。
 *   B 退出本产品的全部设备   revokeProduct：一个事务里 auth_epoch + 1、删除全部网页会话、把设备标记为已撤销；
 *                           事务前后丢弃已批准未领取的配对。之前签发的一切在下一次校验时失效（R-4）。
 *   C 退出所有产品与设备     revokeEverywhere：B + 用用户本人令牌结束身份中心所有浏览器的会话
 *                           + 通知另一个产品执行它的 B；每一步的真实结果都返回（R-5）。
 *   D 中心停用 / 删除        IdentityStatus 发现后对本产品执行 B。
 *
 * 产品内管理员停用 = B，并拒绝之后的登录与领取；重新启用不复活任何旧凭据（R-2：代次只增不减）。
 */

export type RevocationReason = 'logout-all' | 'all-products' | 'admin-disabled' | 'central-disabled' | 'account-deleted' | 'peer-request';

export interface ProductRevocation {
  /** The account's epoch after the revocation. */
  epoch: number;
  sessions: number;
  devices: number;
  /** Approved pairings the extension had not picked up yet. */
  grants: number;
}

/** Why the identity-service step of 动作 C did not happen (shown to the person, never a token). */
export type IdentityCenterError = 'not_configured' | 'no_identity' | 'no_identity_session' | 'session_expired' | 'forbidden' | 'not_supported' | 'unavailable';

export type IdentityCenterOutcome = { state: 'done' } | { state: 'failed'; error: IdentityCenterError; accountUrl: string | null };

export type PeerOutcome = { product: string; state: 'not_configured' } | { product: string; state: 'pending' | 'delivered' | 'failed'; eventId: string; attempts: number; nextAttemptAt: string | null; error: string | null; result: string | null };

export interface EverywhereResult {
  /** True only when every part is done / delivered (R-5). */
  ok: boolean;
  local: { state: 'done'; revokedSessions: number; revokedDevices: number; revokedGrants: number };
  identityCenter: IdentityCenterOutcome;
  peers: PeerOutcome[];
}

export interface RevocationsDeps {
  db: DB;
  users: Users;
  devices: Devices;
  pairings: Pairings;
  oidc?: Oidc | null;
  secrets: SecretBox;
  now?: () => number;
}

export class Revocations {
  private db: DB;
  private now: () => number;

  constructor(private deps: RevocationsDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  /** The identity service's account console (where people can end sessions by hand). */
  get accountUrl(): string | null {
    return this.deps.oidc ? `${this.deps.oidc.settings.issuer.replace(/\/+$/, '')}/account` : null;
  }

  /**
   * 动作 B. One transaction: the epoch goes up, every browser session of the account goes, every
   * device is marked revoked; `alsoInTx` joins it (disabling the account, recording an event).
   * Approved-but-unclaimed pairings are dropped before (a claim starting now finds nothing) and
   * after (one approved meanwhile carries the old epoch and would fail its claim anyway).
   */
  async revokeProduct(userId: string, reason: RevocationReason, alsoInTx?: () => Promise<void>): Promise<ProductRevocation | null> {
    let grants = this.deps.pairings.revokeOwner(userId);
    const r = await this.db.tx(async () => {
      const row = await this.db.get<{ auth_epoch: number }>('update users set auth_epoch = auth_epoch + 1 where id = ? returning auth_epoch', [userId]);
      if (!row) return null;
      const sessions = (await this.db.run('delete from sessions where user_id = ?', [userId])).changes;
      const devices = await this.deps.devices.markRevokedForOwner(userId, reason);
      await alsoInTx?.();
      return { epoch: Number(row.auth_epoch), sessions, devices };
    });
    if (!r) return null;
    grants += this.deps.pairings.revokeOwner(userId);
    console.log(`[nexus] 已撤销账号 ${userId} 在本产品的全部登录与设备（${reason}）：网页会话 ${r.sessions}，设备 ${r.devices}，待领取授权 ${grants}；授权代次 ${r.epoch}`);
    return { ...r, grants };
  }

  /** 产品内管理员停用 = 动作 B（同一事务里停用）。重新启用只恢复登录资格。 */
  async disable(userId: string): Promise<ProductRevocation | null> {
    return this.revokeProduct(userId, 'admin-disabled', async () => {
      await this.deps.users.setDisabled(userId, true);
    });
  }

  /**
   * 动作 C, in the order of ADR-019 §2.3: this product first (done, whatever happens next), then the
   * identity service with the user's own refreshed access token, then the other product. Every part
   * reports what really happened; nothing is called complete that is not.
   */
  async revokeEverywhere(userId: string, session: Session): Promise<EverywhereResult | null> {
    // Read before the session row goes with the rest.
    const refresh = session.kind === 'oidc' && session.refreshEnc ? this.open(session.refreshEnc) : null;
    const local = await this.revokeProduct(userId, 'all-products');
    if (!local) return null;
    const identityCenter = await this.endIdentitySessions(session, refresh);
    const peers: PeerOutcome[] = [{ product: 'litesync', state: 'not_configured' }];
    return {
      ok: identityCenter.state === 'done' && peers.every((p) => p.state === 'delivered'),
      local: { state: 'done', revokedSessions: local.sessions, revokedDevices: local.devices, revokedGrants: local.grants },
      identityCenter,
      peers,
    };
  }

  private async endIdentitySessions(session: Session, refresh: string | null): Promise<IdentityCenterOutcome> {
    const oidc = this.deps.oidc;
    const failed = (error: IdentityCenterError): IdentityCenterOutcome => ({ state: 'failed', error, accountUrl: this.accountUrl });
    if (!oidc) return failed('not_configured');
    // Signed in with the old password: this browser holds no identity-service session to act with.
    if (session.kind !== 'oidc' || !refresh) return failed('no_identity_session');
    const r = await oidc.refresh(refresh);
    if (!r.ok) return failed(r.reason === 'invalid' ? 'session_expired' : 'unavailable');
    const ended = await oidc.endAllSessions(r.accessToken);
    return ended.ok ? { state: 'done' } : failed(ended.reason);
  }

  private open(sealed: string): string | null {
    try {
      return this.deps.secrets.open(sealed);
    } catch {
      return null;
    }
  }
}
