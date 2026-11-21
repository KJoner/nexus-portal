import { createHash, randomBytes } from 'node:crypto';
import { LEGACY_ADMIN_ID, type DB } from '../db';
import { hashPassword, needsRehash, verifyPassword } from './password';

/** Where the access password comes from: an Argon2id hash (v0.2.1) or, for older deployments, plain text. */
export interface PasswordSource {
  hash: string | null;
  plain: string | null;
}

export type PasswordResult = 'unchanged' | 'set' | 'upgraded' | 'missing';

const DAY = 86_400_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Session {
  /** SHA-256 of the cookie value: the row key, never the token itself. */
  idHash: string;
  userId: string;
  kind: 'password' | 'oidc';
  createdAt: number;
  oidcSid: string | null;
  refreshEnc: string | null;
  idTokenEnc: string | null;
  /** OIDC sessions: when the account is next re-checked with the identity provider. */
  revalidateAt: number | null;
}

export type Validation = { valid: false } | { valid: true; renewed: boolean; session: Session };

interface Row {
  id_hash: string;
  user_id: string;
  kind: 'password' | 'oidc';
  created_at: number;
  expires_at: number;
  last_seen: number;
  oidc_sid: string | null;
  refresh_enc: string | null;
  id_token_enc: string | null;
  revalidate_at: number | null;
}

export interface SessionExtras {
  kind?: 'password' | 'oidc';
  oidcSid?: string | null;
  refreshEnc?: string | null;
  idTokenEnc?: string | null;
  revalidateAt?: number | null;
}

/**
 * Browser sessions (v0.4: each names its account). The browser holds a random token; the database
 * stores only its SHA-256, so a leaked database cannot be replayed as a session. The access
 * password is the legacy administrator's own way in (and the way to claim the account).
 */
export class Auth {
  constructor(
    private db: DB,
    private sessionDays: number,
    private now: () => number = Date.now,
  ) {}

  private async stored(): Promise<string | null> {
    return (await this.db.get<{ password_hash: string }>('select password_hash from auth where id = 1'))?.password_hash ?? null;
  }

  private async store(hash: string, revokeSessions: boolean) {
    await this.db.tx(async () => {
      await this.db.run('insert into auth (id, password_hash, updated_at) values (1, ?, ?) on conflict (id) do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at', [hash, new Date().toISOString()]);
      // A new password signs out every browser and paired device of the account it protects —
      // the legacy administrator's; other accounts never used this password.
      if (revokeSessions) {
        await this.db.run('delete from sessions where user_id = ?', [LEGACY_ADMIN_ID]);
        await this.db.run('delete from devices where owner_id = ?', [LEGACY_ADMIN_ID]);
      }
    });
  }

  /**
   * The configured password is the source of truth: when it changes, the stored hash is replaced
   * and the administrator's sessions and paired devices are revoked.
   * - `hash` (NEXUS_PASSWORD_HASH) is stored as is; the server never sees the password.
   * - `plain` (NEXUS_PASSWORD, v0.1–v0.2.0 deployments) still works; an older scrypt hash of the
   *   same password is upgraded to Argon2id in place, without signing anyone out.
   */
  async ensurePassword(source: PasswordSource): Promise<PasswordResult> {
    const current = await this.stored();
    if (source.hash) {
      if (current === source.hash) return 'unchanged';
      await this.store(source.hash, true);
      return 'set';
    }
    if (!source.plain) return current ? 'unchanged' : 'missing';
    if (current && (await verifyPassword(source.plain, current))) {
      if (!needsRehash(current)) return 'unchanged';
      await this.store(await hashPassword(source.plain), false);
      return 'upgraded';
    }
    await this.store(await hashPassword(source.plain), true);
    return 'set';
  }

  async hasPassword(): Promise<boolean> {
    return (await this.stored()) !== null;
  }

  async checkPassword(password: string): Promise<boolean> {
    const current = await this.stored();
    if (!current || !(await verifyPassword(password, current))) return false;
    // A database restored from an old backup may still hold a scrypt hash.
    if (needsRehash(current)) await this.store(await hashPassword(password), false);
    return true;
  }

  async createSession(userId: string, userAgent: string, extras: SessionExtras = {}): Promise<{ token: string; maxAgeSec: number }> {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    await this.db.run(
      'insert into sessions (id_hash, user_id, created_at, expires_at, last_seen, user_agent, kind, oidc_sid, refresh_enc, id_token_enc, revalidate_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [sha256(token), userId, t, t + this.sessionDays * DAY, t, userAgent.slice(0, 200), extras.kind ?? 'password', extras.oidcSid ?? null, extras.refreshEnc ?? null, extras.idTokenEnc ?? null, extras.revalidateAt ?? null],
    );
    await this.db.run('delete from sessions where expires_at < ?', [t]);
    return { token, maxAgeSec: this.sessionDays * 86_400 };
  }

  /** Valid sessions slide forward at most once a day to avoid a write per request. */
  async validate(token: string | undefined): Promise<Validation> {
    if (!token || token.length > 128) return { valid: false };
    const id = sha256(token);
    const row = await this.db.get<Row>('select id_hash, user_id, kind, created_at, expires_at, last_seen, oidc_sid, refresh_enc, id_token_enc, revalidate_at from sessions where id_hash = ?', [id]);
    const t = this.now();
    if (!row || Number(row.expires_at) < t) return { valid: false };
    const session: Session = { idHash: row.id_hash, userId: row.user_id, kind: row.kind, createdAt: Number(row.created_at), oidcSid: row.oidc_sid, refreshEnc: row.refresh_enc, idTokenEnc: row.id_token_enc, revalidateAt: row.revalidate_at === null ? null : Number(row.revalidate_at) };
    if (t - Number(row.last_seen) < DAY) return { valid: true, renewed: false, session };
    await this.db.run('update sessions set last_seen = ?, expires_at = ? where id_hash = ?', [t, t + this.sessionDays * DAY, id]);
    return { valid: true, renewed: true, session };
  }

  /** After a successful re-check with the identity provider (refresh tokens may rotate). */
  async markRevalidated(idHash: string, revalidateAt: number, refreshEnc?: string | null) {
    if (refreshEnc === undefined) await this.db.run('update sessions set revalidate_at = ? where id_hash = ?', [revalidateAt, idHash]);
    else await this.db.run('update sessions set revalidate_at = ?, refresh_enc = ? where id_hash = ?', [revalidateAt, refreshEnc, idHash]);
  }

  async revoke(token: string | undefined) {
    if (token) await this.db.run('delete from sessions where id_hash = ?', [sha256(token)]);
  }

  async revokeById(idHash: string) {
    await this.db.run('delete from sessions where id_hash = ?', [idHash]);
  }

  /** 退出所有设备 / account frozen: every browser session of the account. */
  async revokeAllForUser(userId: string): Promise<number> {
    return (await this.db.run('delete from sessions where user_id = ?', [userId])).changes;
  }

  /** Back-channel logout for one identity-provider session. */
  async revokeBySid(sid: string): Promise<number> {
    return (await this.db.run('delete from sessions where oidc_sid = ?', [sid])).changes;
  }
}
