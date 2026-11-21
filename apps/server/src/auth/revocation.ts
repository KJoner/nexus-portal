import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUniqueViolation, type DB } from '../db';
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
 *                           事务前后撤回已批准未领取的配对。之前签发的一切在下一次校验时失效（R-4）。
 *   C 退出所有产品与设备     revokeEverywhere：B（同一事务写下发给另一个产品的撤销事件）+ 用用户本人令牌
 *                           结束身份中心所有浏览器的会话 + 同步投递一次事件；每一步的真实结果都返回（R-5）。
 *   D 中心停用 / 删除        IdentityStatus 发现后对本产品执行 B。
 *
 * 产品内管理员停用 = B，并拒绝之后的登录与领取；重新启用不复活任何旧凭据（R-2：代次只增不减）。
 *
 * 产品之间的撤销事件（§2.4）：
 *   POST {对方}/api/internal/v1/account-revocations
 *   X-Revocation-Timestamp: <Unix 秒>
 *   X-Revocation-Signature: v1=<hex(HMAC-SHA256(共享密钥的 UTF-8 字节, 时间戳 + "." + 原始请求体))>
 *   {"v":1,"eventId":"<32 位 hex>","issuer":…,"subject":…,"scope":"all-products-all-devices","reason":…,"origin":"nexus","occurredAt":"<RFC 3339>"}
 * 以 (issuer, subject) 找账号，绝不使用对方的本地 user_id；事件只能撤销，不能授予任何权限。
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

/** Error categories of a delivery (stored and shown; never an address, token or body). */
export type DeliveryError = 'network' | 'timeout' | 'server_error' | 'rate_limited' | 'signature_rejected' | 'rejected' | 'expired';

export type PeerOutcome = { product: string; state: 'not_configured' } | { product: string; state: 'pending' | 'delivered' | 'failed'; eventId: string; attempts: number; nextAttemptAt: string | null; error: DeliveryError | null; result: string | null };

export interface EverywhereResult {
  /** True only when every part is done / delivered (R-5). */
  ok: boolean;
  local: { state: 'done'; revokedSessions: number; revokedDevices: number; revokedGrants: number };
  identityCenter: IdentityCenterOutcome;
  peers: PeerOutcome[];
}

/** The other product (ADR-019: two products, each configured with the other only — no forwarding). */
export interface PeerConfig {
  product: string;
  /** Its internal base address (e.g. http://litesync:8080) or the full endpoint. */
  url: string;
  /** Shared with it; its UTF-8 bytes are the HMAC key. */
  secret: string;
}

export const ENDPOINT = '/api/internal/v1/account-revocations';
export const SCOPE_ALL = 'all-products-all-devices';
/** Signed requests older or newer than this are refused (replay window). */
export const WINDOW_SEC = 5 * 60;
/** Retry delays after the first attempt: 5 s, 15 s, 30 s, then every 30 s … */
const BACKOFF_MS = [5_000, 15_000, 30_000];
/** …until the other product confirms, or this long has passed: then `failed` (resend by hand). */
const GIVE_UP_MS = 7 * 86_400_000;
const DELIVERY_TIMEOUT_MS = 5_000;
/** A claimed delivery that never reported back (process stopped) is tried again after this. */
const LEASE_MS = 60_000;

export const signature = (secret: string, timestamp: string, body: Uint8Array | string) => `v1=${createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${timestamp}.`).update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest('hex')}`;

const iso = (t: number | null | undefined) => (t === null || t === undefined ? null : new Date(Number(t)).toISOString());
const rfc3339 = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

interface OutRow {
  id: string;
  user_id: string;
  peer: string;
  body: string;
  reason: string;
  state: 'pending' | 'delivered' | 'failed';
  result: string | null;
  attempts: number;
  next_attempt_at: number | null;
  last_error: DeliveryError | null;
  created_at: number;
  expires_at: number;
  delivered_at: number | null;
}

/** GET /api/v2/account/revocations: what this account sent and received (times, products, states). */
export interface RevocationEventInfo {
  eventId: string;
  direction: 'outgoing' | 'incoming';
  product: string;
  reason: string;
  state: 'pending' | 'delivered' | 'failed' | 'applied' | 'unknown-identity';
  attempts: number | null;
  nextAttemptAt: string | null;
  error: DeliveryError | null;
  result: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ReceiveResult {
  status: 200 | 400 | 401;
  body: Record<string, unknown>;
}

export interface RevocationsDeps {
  db: DB;
  users: Users;
  devices: Devices;
  pairings: Pairings;
  oidc?: Oidc | null;
  secrets: SecretBox;
  peer?: PeerConfig | null;
  /** How events are sent to the other product (tests route them to another app instance). */
  peerFetch?: typeof fetch;
  now?: () => number;
}

export class Revocations {
  private db: DB;
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;

  constructor(private deps: RevocationsDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  get peer(): PeerConfig | null {
    return this.deps.peer ?? null;
  }

  /** The identity service's account console (where people can end sessions by hand). */
  get accountUrl(): string | null {
    return this.deps.oidc ? `${this.deps.oidc.settings.issuer.replace(/\/+$/, '')}/account` : null;
  }

  /**
   * 动作 B. One transaction: the epoch goes up, every browser session of the account goes, every
   * device is marked revoked; `alsoInTx` joins it (disabling the account, recording an event).
   * Approved-but-unclaimed pairings are withdrawn before (a claim starting now finds nothing) and
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
   * 动作 C, in the order of ADR-019 §2.3: this product first (done, whatever happens next — the event
   * for the other product is written in the same transaction), then the identity service with the
   * user's own refreshed access token, then one delivery attempt to the other product (retried in
   * the background after that). Every part reports what really happened.
   */
  async revokeEverywhere(userId: string, session: Session): Promise<EverywhereResult | null> {
    const user = await this.deps.users.get(userId);
    if (!user) return null;
    // Read before the session row goes with the rest.
    const refresh = session.kind === 'oidc' && session.refreshEnc ? this.open(session.refreshEnc) : null;
    const peer = this.peer;
    const eventId = randomBytes(16).toString('hex');
    const local = await this.revokeProduct(userId, 'all-products', async () => {
      if (peer && user.issuer && user.subject) await this.enqueue(eventId, userId, peer, { issuer: user.issuer, subject: user.subject, reason: 'user-request' });
    });
    if (!local) return null;
    const identityCenter = await this.endIdentitySessions(session, refresh);
    const peers: PeerOutcome[] = [peer && user.issuer ? await this.deliverNow(eventId) : { product: peer?.product ?? 'litesync', state: 'not_configured' }];
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

  // ── outgoing events ─────────────────────────────────────────────────────

  private async enqueue(eventId: string, userId: string, peer: PeerConfig, e: { issuer: string; subject: string; reason: string }) {
    const t = this.now();
    // Key order as in ADR-019 §2.4. Stored as sent: every retry signs these same bytes.
    const body = JSON.stringify({ v: 1, eventId, issuer: e.issuer, subject: e.subject, scope: SCOPE_ALL, reason: e.reason, origin: 'nexus', occurredAt: rfc3339(t) });
    await this.db.run('insert into revocation_outbox (id, user_id, peer, body, reason, state, attempts, next_attempt_at, created_at, expires_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)', [eventId, userId, peer.product, body, e.reason, 'pending', t, t, t + GIVE_UP_MS, t]);
  }

  private endpoint(peer: PeerConfig) {
    return peer.url.endsWith(ENDPOINT) ? peer.url : `${peer.url.replace(/\/+$/, '')}${ENDPOINT}`;
  }

  private async row(id: string): Promise<OutRow | undefined> {
    return this.db.get<OutRow>('select id, user_id, peer, body, reason, state, result, attempts, next_attempt_at, last_error, created_at, expires_at, delivered_at from revocation_outbox where id = ?', [id]);
  }

  private outcome(r: OutRow): PeerOutcome {
    return { product: r.peer, state: r.state, eventId: r.id, attempts: Number(r.attempts), nextAttemptAt: r.state === 'pending' ? iso(r.next_attempt_at) : null, error: r.last_error, result: r.result };
  }

  private async deliverNow(id: string): Promise<PeerOutcome> {
    await this.deliver(id);
    const r = await this.row(id);
    return r ? this.outcome(r) : { product: this.peer?.product ?? 'litesync', state: 'not_configured' };
  }

  /**
   * One attempt for one event. The claim is a lease (attempts + 1, next attempt pushed out): two
   * workers never send the same event at once, and one that stopped mid-way is retried later.
   */
  async deliver(id: string): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    const t = this.now();
    const claim = await this.db.run("update revocation_outbox set attempts = attempts + 1, next_attempt_at = ?, updated_at = ? where id = ? and state = 'pending' and next_attempt_at <= ?", [t + LEASE_MS, t, id, t]);
    if (!claim.changes) return;
    const r = (await this.row(id))!;
    const attempts = Number(r.attempts);
    let error: DeliveryError | null = null;
    let final: 'delivered' | 'failed' | null = null;
    let result: string | null = null;
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await (this.deps.peerFetch ?? fetch)(this.endpoint(peer), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-revocation-timestamp': ts, 'x-revocation-signature': signature(peer.secret, ts, r.body) },
        body: r.body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.ok) {
        final = 'delivered';
        const answer = (await res.json().catch(() => null)) as { applied?: unknown; reason?: unknown } | null;
        result = answer?.applied === true ? 'applied' : typeof answer?.reason === 'string' ? answer.reason.slice(0, 40) : 'delivered';
      } else if (res.status === 401) ((final = 'failed'), (error = 'signature_rejected'));
      else if (res.status === 408 || res.status === 429) error = 'rate_limited';
      else if (res.status >= 500) error = 'server_error';
      else ((final = 'failed'), (error = 'rejected'));
    } catch (e) {
      error = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network';
    }
    const now = this.now();
    if (!final && now >= Number(r.expires_at)) ((final = 'failed'), (error = 'expired'));
    if (final === 'delivered') {
      await this.db.run("update revocation_outbox set state = 'delivered', result = ?, last_error = null, delivered_at = ?, next_attempt_at = null, updated_at = ? where id = ?", [result, now, now, id]);
      return;
    }
    if (final === 'failed') {
      await this.db.run("update revocation_outbox set state = 'failed', last_error = ?, next_attempt_at = null, updated_at = ? where id = ?", [error, now, id]);
      console.error(`[nexus] 跨产品撤销事件没有送达（${error}${error === 'signature_rejected' ? '：两边的撤销密钥不一致' : ''}），不再自动重试：账号 ${r.user_id} → ${r.peer}`);
      return;
    }
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
    await this.db.run('update revocation_outbox set last_error = ?, next_attempt_at = ?, updated_at = ? where id = ?', [error, now + delay, now, id]);
  }

  /** Sends what is due; concurrent calls share one run. Returns how many were attempted. */
  deliverDue(limit = 20): Promise<number> {
    this.running ??= (async () => {
      if (!this.peer) return 0;
      const due = await this.db.all<{ id: string }>("select id from revocation_outbox where state = 'pending' and next_attempt_at <= ? order by next_attempt_at limit ?", [this.now(), limit]);
      for (const d of due) await this.deliver(d.id);
      return due.length;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(intervalMs = 5_000) {
    if (!this.peer) return;
    this.timer ??= setInterval(() => void this.deliverDue().catch((e) => console.error('[nexus] 跨产品撤销事件投递出错', e)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resend by hand (pending or failed, the account's own): a fresh 7-day window, one attempt now. */
  async retry(userId: string, id: string): Promise<RevocationEventInfo | null> {
    const t = this.now();
    const r = await this.db.run("update revocation_outbox set state = 'pending', next_attempt_at = ?, expires_at = ?, last_error = null, updated_at = ? where id = ? and user_id = ? and state in ('pending', 'failed')", [t, t + GIVE_UP_MS, t, id, userId]);
    if (!r.changes) return null;
    await this.deliver(id);
    return (await this.list(userId)).find((e) => e.eventId === id && e.direction === 'outgoing') ?? null;
  }

  /** The account's recent events, both directions, newest first. */
  async list(userId: string, limit = 20): Promise<RevocationEventInfo[]> {
    const out = await this.db.all<OutRow>('select id, user_id, peer, body, reason, state, result, attempts, next_attempt_at, last_error, created_at, expires_at, delivered_at from revocation_outbox where user_id = ? order by created_at desc limit ?', [userId, limit]);
    const inn = await this.db.all<{ event_id: string; origin: string; reason: string; result: 'applied' | 'unknown-identity'; received_at: number }>('select event_id, origin, reason, result, received_at from revocation_inbox where user_id = ? order by received_at desc limit ?', [userId, limit]);
    const events: RevocationEventInfo[] = [
      ...out.map((r) => ({ eventId: r.id, direction: 'outgoing' as const, product: r.peer, reason: r.reason, state: r.state, attempts: Number(r.attempts), nextAttemptAt: r.state === 'pending' ? iso(r.next_attempt_at) : null, error: r.last_error, result: r.result, createdAt: iso(r.created_at)!, deliveredAt: iso(r.delivered_at) })),
      ...inn.map((r) => ({ eventId: r.event_id, direction: 'incoming' as const, product: r.origin, reason: r.reason, state: r.result, attempts: null, nextAttemptAt: null, error: null, result: r.result, createdAt: iso(r.received_at)!, deliveredAt: null })),
    ];
    return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
  }

  /** For the administrator: is it configured, and did deliveries fail lately (and why). */
  async health(): Promise<{ configured: boolean; product: string | null; pending: number; failed: number; lastError: DeliveryError | null; lastDeliveredAt: string | null }> {
    const since = this.now() - GIVE_UP_MS;
    const c = await this.db.get<{ pending: number; failed: number; delivered: number | null }>("select sum(case when state = 'pending' then 1 else 0 end) as pending, sum(case when state = 'failed' then 1 else 0 end) as failed, max(delivered_at) as delivered from revocation_outbox where created_at > ?", [since]);
    const last = await this.db.get<{ last_error: DeliveryError | null }>('select last_error from revocation_outbox where last_error is not null and updated_at > ? order by updated_at desc limit 1', [since]);
    return { configured: !!this.peer, product: this.peer?.product ?? null, pending: Number(c?.pending ?? 0), failed: Number(c?.failed ?? 0), lastError: last?.last_error ?? null, lastDeliveredAt: iso(c?.delivered ?? null) };
  }

  // ── incoming events ─────────────────────────────────────────────────────

  /**
   * The other product's event (ADR-019 §2.4). Constant-time signature check over the raw bytes,
   * a 5-minute timestamp window, deduplication by event id (a repeated delivery gets the same
   * answer), then 动作 B for the account found by (issuer, subject). Never forwarded.
   */
  async receive(raw: Uint8Array, headers: { timestamp?: string | null; signature?: string | null }): Promise<ReceiveResult> {
    const peer = this.peer;
    const denied = (code: string, message: string): ReceiveResult => ({ status: 401, body: { code, message, retryable: false } });
    if (!peer) return denied('PEER_REVOCATION_NOT_CONFIGURED', '本产品没有配置跨产品撤销');
    const ts = headers.timestamp?.trim() ?? '';
    const given = /^v1=([0-9a-f]{64})$/i.exec(headers.signature?.trim() ?? '')?.[1];
    if (!/^\d{1,12}$/.test(ts) || !given) return denied('SIGNATURE_INVALID', '签名或时间戳不符');
    const expected = Buffer.from(signature(peer.secret, ts, raw).slice(3), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(given.toLowerCase(), 'hex'))) return denied('SIGNATURE_INVALID', '签名或时间戳不符');
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > WINDOW_SEC) return denied('TIMESTAMP_OUT_OF_WINDOW', '签名或时间戳不符');

    const bad = (message: string): ReceiveResult => ({ status: 400, body: { code: 'INVALID_EVENT', message, retryable: false } });
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
    } catch {
      return bad('不是 JSON');
    }
    const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
    if (!e || typeof e !== 'object' || e.v !== 1) return bad('不支持的事件版本');
    if (typeof e.eventId !== 'string' || !/^[0-9a-f]{32}$/i.test(e.eventId)) return bad('eventId 必须是 32 位十六进制');
    if (!str(e.issuer, 512) || !str(e.subject, 255) || !str(e.reason, 64) || !str(e.origin, 32) || !str(e.occurredAt, 40)) return bad('缺少字段或字段过长');
    if (e.scope !== SCOPE_ALL) return bad('不支持的撤销范围');
    if (Number.isNaN(Date.parse(e.occurredAt as string))) return bad('occurredAt 不是 RFC 3339 时间');
    const eventId = e.eventId.toLowerCase();
    const issuer = e.issuer as string;
    const subject = e.subject as string;

    const answer = (result: string) => (result === 'applied' ? { applied: true } : { applied: false, reason: 'unknown-identity' });
    const user = (await this.deps.users.byIdentity(issuer, subject)) ?? (await this.deps.users.byIdentity(issuer.replace(/\/+$/, ''), subject)) ?? (await this.deps.users.byIdentity(`${issuer.replace(/\/+$/, '')}/`, subject));
    const result = user ? 'applied' : 'unknown-identity';
    try {
      const fresh = await this.db.tx(async () => {
        const ins = await this.db.run('insert into revocation_inbox (event_id, origin, issuer, subject, scope, reason, occurred_at, user_id, result, received_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (event_id) do nothing', [eventId, e.origin as string, issuer, subject, SCOPE_ALL, e.reason as string, e.occurredAt as string, user?.id ?? null, result, this.now()]);
        if (!ins.changes) return false;
        // Same transaction: the event is recorded exactly when the revocation happened.
        if (user) await this.revokeProduct(user.id, 'peer-request');
        return true;
      });
      if (!fresh) {
        const seen = await this.db.get<{ result: string }>('select result from revocation_inbox where event_id = ?', [eventId]);
        return { status: 200, body: answer(seen?.result ?? result) };
      }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const seen = await this.db.get<{ result: string }>('select result from revocation_inbox where event_id = ?', [eventId]);
      return { status: 200, body: answer(seen?.result ?? result) };
    }
    console.log(`[nexus] 收到 ${String(e.origin)} 的跨产品撤销事件（${String(e.reason)}）：${user ? `已撤销账号 ${user.id} 在本产品的全部登录与设备` : '本产品没有这个身份'}`);
    return { status: 200, body: answer(result) };
  }

  private open(sealed: string): string | null {
    try {
      return this.deps.secrets.open(sealed);
    } catch {
      return null;
    }
  }
}
