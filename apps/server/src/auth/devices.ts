import { isDeviceScope, PAIR_CODE_ALPHABET, type DeviceInfo, type DeviceScope, type PairingRequest, type PairPollResponse, type PairStartResponse } from '@nexus/shared';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A device that has not synced for this long loses its access. */
const IDLE_DAYS = 180;
const PAIR_TTL = 10 * 60_000;
const POLL_INTERVAL = 2;
const MAX_PENDING = 10;
const STARTS_PER_CLIENT = 10;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

interface Row {
  id: string;
  owner_id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
}

/** Comma list from the database → known scopes only (an unknown word grants nothing). */
export const parseScopes = (text: string): DeviceScope[] => [...new Set(text.split(',').map((s) => s.trim()))].filter(isDeviceScope);

const info = (r: Row): DeviceInfo => ({ id: r.id, name: r.name, createdAt: iso(Number(r.created_at))!, lastUsedAt: iso(r.last_used_at === null ? null : Number(r.last_used_at)), scopes: parseScopes(r.scopes) });

/** The device behind a request: whose data it reads, and what it may do. */
export interface DeviceAuth extends DeviceInfo {
  ownerId: string;
  scopes: DeviceScope[];
}

/**
 * Device tokens (the browser extension). Only the SHA-256 is stored, so the database cannot be
 * replayed; deleting the row revokes the device. Every device belongs to one account and holds
 * only the scopes that account approved.
 */
export class Devices {
  constructor(
    private db: DB,
    private now: () => number = Date.now,
  ) {}

  async list(ownerId: string): Promise<DeviceInfo[]> {
    return (await this.db.all<Row>('select id, owner_id, name, scopes, created_at, last_used_at from devices where owner_id = ? order by created_at', [ownerId])).map(info);
  }

  async create(ownerId: string, name: string, userAgent: string, scopes: readonly DeviceScope[] = ['config:read']): Promise<{ device: DeviceInfo; token: string }> {
    const token = `nxd_${randomBytes(32).toString('base64url')}`;
    const granted = [...new Set(scopes)].filter(isDeviceScope);
    const row: Row = { id: randomBytes(9).toString('base64url'), owner_id: ownerId, name, scopes: (granted.length ? granted : ['config:read']).join(','), created_at: this.now(), last_used_at: null };
    await this.db.run('insert into devices (id, owner_id, name, token_hash, scopes, created_at, last_used_at, user_agent) values (?, ?, ?, ?, ?, ?, ?, ?)', [row.id, ownerId, row.name, sha256(token), row.scopes, row.created_at, null, userAgent.slice(0, 200)]);
    return { device: info(row), token };
  }

  /** The device behind a token, or null. Use is recorded at most once an hour (no write per request). */
  async validate(token: string): Promise<DeviceAuth | null> {
    const row = await this.db.get<Row>('select id, owner_id, name, scopes, created_at, last_used_at from devices where token_hash = ?', [sha256(token)]);
    if (!row) return null;
    const t = this.now();
    const lastUsed = row.last_used_at === null ? null : Number(row.last_used_at);
    if ((lastUsed ?? Number(row.created_at)) < t - IDLE_DAYS * DAY) {
      await this.db.run('delete from devices where id = ?', [row.id]);
      return null;
    }
    if (lastUsed === null || t - lastUsed >= HOUR) {
      await this.db.run('update devices set last_used_at = ? where id = ?', [t, row.id]);
      row.last_used_at = t;
    }
    const owner = await this.db.get<{ disabled: number }>('select disabled from users where id = ?', [row.owner_id]);
    if (!owner || Number(owner.disabled)) return null;
    return { ...info(row), ownerId: row.owner_id, scopes: parseScopes(row.scopes) };
  }

  /** Only the account's own devices: another account's id reads as not found. */
  async revoke(ownerId: string, id: string): Promise<boolean> {
    return (await this.db.run('delete from devices where id = ? and owner_id = ?', [id, ownerId])).changes > 0;
  }

  async revokeAllForOwner(ownerId: string): Promise<number> {
    return (await this.db.run('delete from devices where owner_id = ?', [ownerId])).changes;
  }
}

interface Pending {
  id: string;
  secretHash: Buffer;
  code: string;
  name: string;
  ip: string;
  userAgent: string;
  scopes: DeviceScope[];
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied';
  /** Set by the approving account: the device will belong to it, with these scopes. */
  ownerId?: string;
  granted?: DeviceScope[];
}

export class PairingError extends Error {
  constructor(
    readonly code: 'rate_limited' | 'busy',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Device pairing in the style of OAuth's device authorization grant (RFC 8628). The extension
 * starts a request (naming the scopes it wants) and polls with a secret only it knows; a signed-in
 * user approves the code in the portal, which binds the device to *their* account; the token is
 * created at the moment the extension picks it up, and only then. Requests live in memory for ten
 * minutes: a restart simply means pairing again.
 */
export class Pairings {
  private pending = new Map<string, Pending>();
  private starts = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private devices: Devices,
    private now: () => number = Date.now,
  ) {}

  private sweep() {
    const t = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(id);
    for (const [k, s] of this.starts) if (s.resetAt <= t) this.starts.delete(k);
  }

  private newCode(): string {
    for (;;) {
      const raw = Array.from({ length: 8 }, () => PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)]).join('');
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      if (![...this.pending.values()].some((p) => p.code === code)) return code;
    }
  }

  start(name: string, ip: string, userAgent: string, scopes: readonly DeviceScope[] = ['config:read']): PairStartResponse {
    this.sweep();
    const t = this.now();
    const s = this.starts.get(ip) ?? { n: 0, resetAt: t + PAIR_TTL };
    if (s.n >= STARTS_PER_CLIENT) throw new PairingError('rate_limited', '连接请求过多，请稍后再试');
    if (this.pending.size >= MAX_PENDING) throw new PairingError('busy', '待确认的连接请求过多，请稍后再试');
    s.n++;
    this.starts.set(ip, s);
    const secret = randomBytes(32).toString('base64url');
    const wanted = [...new Set(scopes)].filter(isDeviceScope);
    const p: Pending = { id: randomBytes(12).toString('base64url'), secretHash: createHash('sha256').update(secret).digest(), code: this.newCode(), name, ip, userAgent: userAgent.slice(0, 200), scopes: wanted.length ? wanted : ['config:read'], createdAt: t, expiresAt: t + PAIR_TTL, status: 'pending' };
    this.pending.set(p.id, p);
    return { pairId: p.id, secret, code: p.code, expiresIn: PAIR_TTL / 1000, interval: POLL_INTERVAL };
  }

  private byCode(code: string): Pending | undefined {
    this.sweep();
    return [...this.pending.values()].find((p) => p.code === code && p.status === 'pending');
  }

  /** For the approval screen (signed-in user only). */
  peek(code: string): PairingRequest | null {
    const p = this.byCode(code);
    return p ? { code: p.code, name: p.name, createdAt: iso(p.createdAt)!, expiresAt: iso(p.expiresAt)!, ip: p.ip, userAgent: p.userAgent, scopes: p.scopes } : null;
  }

  /**
   * The signed-in user's answer. Approving binds the device to `ownerId`; the user may grant less
   * than was asked for, never more. False when the code is unknown, expired or already answered.
   */
  decide(code: string, approve: boolean, ownerId?: string, grant?: readonly DeviceScope[]): boolean {
    const p = this.byCode(code);
    if (!p || (approve && !ownerId)) return false;
    p.status = approve ? 'approved' : 'denied';
    if (approve) {
      p.ownerId = ownerId;
      p.granted = grant ? p.scopes.filter((s) => grant.includes(s)) : p.scopes;
      if (!p.granted.length) p.granted = ['config:read'];
    }
    return true;
  }

  async poll(pairId: string, secret: string): Promise<PairPollResponse> {
    this.sweep();
    const p = this.pending.get(pairId);
    const given = createHash('sha256').update(secret).digest();
    if (!p || !timingSafeEqual(p.secretHash, given)) return { status: 'expired' };
    if (p.status === 'pending') return { status: 'pending' };
    this.pending.delete(pairId);
    if (p.status === 'denied' || !p.ownerId) return { status: 'denied' };
    const { device, token } = await this.devices.create(p.ownerId, p.name, p.userAgent, p.granted);
    return { status: 'approved', token, device };
  }
}
