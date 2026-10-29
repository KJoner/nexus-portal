import { PAIR_CODE_ALPHABET, type DeviceInfo, type PairingRequest, type PairPollResponse, type PairStartResponse } from '@nexus/shared';
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
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const info = (r: Row): DeviceInfo => ({ id: r.id, name: r.name, createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at) });

/**
 * Read-only device tokens (the Chrome extension). Like sessions, only the SHA-256 is stored, so
 * the database cannot be replayed; deleting the row revokes the device.
 */
export class Devices {
  constructor(
    private db: DB,
    private now: () => number = Date.now,
  ) {}

  list(): DeviceInfo[] {
    return (this.db.prepare('select id, name, created_at, last_used_at from devices order by created_at').all() as Row[]).map(info);
  }

  create(name: string, userAgent: string): { device: DeviceInfo; token: string } {
    const token = `nxd_${randomBytes(32).toString('base64url')}`;
    const row: Row = { id: randomBytes(9).toString('base64url'), name, created_at: this.now(), last_used_at: null };
    this.db.prepare('insert into devices (id, name, token_hash, created_at, last_used_at, user_agent) values (?, ?, ?, ?, ?, ?)').run(row.id, row.name, sha256(token), row.created_at, null, userAgent.slice(0, 200));
    return { device: info(row), token };
  }

  /** The device behind a token, or null. Use is recorded at most once an hour (no write per request). */
  validate(token: string): DeviceInfo | null {
    const hash = sha256(token);
    const row = this.db.prepare('select id, name, created_at, last_used_at from devices where token_hash = ?').get(hash) as Row | undefined;
    if (!row) return null;
    const t = this.now();
    if ((row.last_used_at ?? row.created_at) < t - IDLE_DAYS * DAY) {
      this.revoke(row.id);
      return null;
    }
    if (!row.last_used_at || t - row.last_used_at >= HOUR) {
      this.db.prepare('update devices set last_used_at = ? where id = ?').run(t, row.id);
      row.last_used_at = t;
    }
    return info(row);
  }

  revoke(id: string): boolean {
    return this.db.prepare('delete from devices where id = ?').run(id).changes > 0;
  }
}

interface Pending {
  id: string;
  secretHash: Buffer;
  code: string;
  name: string;
  ip: string;
  userAgent: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied';
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
 * starts a request and polls with a secret only it knows; the signed-in user approves the code in
 * the portal; the token is created at the moment the extension picks it up, and only then.
 * Requests live in memory for ten minutes: a restart simply means pairing again.
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

  start(name: string, ip: string, userAgent: string): PairStartResponse {
    this.sweep();
    const t = this.now();
    const s = this.starts.get(ip) ?? { n: 0, resetAt: t + PAIR_TTL };
    if (s.n >= STARTS_PER_CLIENT) throw new PairingError('rate_limited', '连接请求过多，请稍后再试');
    if (this.pending.size >= MAX_PENDING) throw new PairingError('busy', '待确认的连接请求过多，请稍后再试');
    s.n++;
    this.starts.set(ip, s);
    const secret = randomBytes(32).toString('base64url');
    const p: Pending = { id: randomBytes(12).toString('base64url'), secretHash: createHash('sha256').update(secret).digest(), code: this.newCode(), name, ip, userAgent: userAgent.slice(0, 200), createdAt: t, expiresAt: t + PAIR_TTL, status: 'pending' };
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
    return p ? { code: p.code, name: p.name, createdAt: iso(p.createdAt)!, expiresAt: iso(p.expiresAt)!, ip: p.ip, userAgent: p.userAgent } : null;
  }

  /** Signed-in user's answer. False when the code is unknown, expired or already answered. */
  decide(code: string, approve: boolean): boolean {
    const p = this.byCode(code);
    if (!p) return false;
    p.status = approve ? 'approved' : 'denied';
    return true;
  }

  poll(pairId: string, secret: string): PairPollResponse {
    this.sweep();
    const p = this.pending.get(pairId);
    const given = createHash('sha256').update(secret).digest();
    if (!p || !timingSafeEqual(p.secretHash, given)) return { status: 'expired' };
    if (p.status === 'pending') return { status: 'pending' };
    this.pending.delete(pairId);
    if (p.status === 'denied') return { status: 'denied' };
    const { device, token } = this.devices.create(p.name, p.userAgent);
    return { status: 'approved', token, device };
  }
}
