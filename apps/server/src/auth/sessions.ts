import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { hashPassword, needsRehash, verifyPassword } from './password';

/** Where the access password comes from: an Argon2id hash (v0.2.1) or, for older deployments, plain text. */
export interface PasswordSource {
  hash: string | null;
  plain: string | null;
}

export type PasswordResult = 'unchanged' | 'set' | 'upgraded' | 'missing';

const DAY = 86_400_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Single-user authentication. The browser holds a random token; the database stores only its
 * SHA-256, so a leaked database file cannot be replayed as a session.
 */
export class Auth {
  constructor(
    private db: DB,
    private sessionDays: number,
  ) {}

  private stored(): string | null {
    return (this.db.prepare('select password_hash from auth where id = 1').get() as { password_hash: string } | undefined)?.password_hash ?? null;
  }

  private store(hash: string, revokeSessions: boolean) {
    this.db.transaction(() => {
      this.db.prepare('insert into auth (id, password_hash, updated_at) values (1, ?, ?) on conflict(id) do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at').run(hash, new Date().toISOString());
      // A new password signs out every browser and every paired device.
      if (revokeSessions) this.db.exec('delete from sessions; delete from devices;');
    })();
  }

  /**
   * The configured password is the source of truth: when it changes, the stored hash is replaced
   * and every existing session and paired device is revoked.
   * - `hash` (NEXUS_PASSWORD_HASH) is stored as is; the server never sees the password.
   * - `plain` (NEXUS_PASSWORD, v0.1–v0.2.0 deployments) still works; an older scrypt hash of the
   *   same password is upgraded to Argon2id in place, without signing anyone out.
   */
  async ensurePassword(source: PasswordSource): Promise<PasswordResult> {
    const current = this.stored();
    if (source.hash) {
      if (current === source.hash) return 'unchanged';
      this.store(source.hash, true);
      return 'set';
    }
    if (!source.plain) return current ? 'unchanged' : 'missing';
    if (current && (await verifyPassword(source.plain, current))) {
      if (!needsRehash(current)) return 'unchanged';
      this.store(await hashPassword(source.plain), false);
      return 'upgraded';
    }
    this.store(await hashPassword(source.plain), true);
    return 'set';
  }

  async checkPassword(password: string): Promise<boolean> {
    const current = this.stored();
    if (!current || !(await verifyPassword(password, current))) return false;
    // A database restored from an old backup may still hold a scrypt hash.
    if (needsRehash(current)) this.store(await hashPassword(password), false);
    return true;
  }

  createSession(userAgent: string): { token: string; maxAgeSec: number } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('insert into sessions (id_hash, created_at, expires_at, last_seen, user_agent) values (?, ?, ?, ?, ?)').run(sha256(token), now, now + this.sessionDays * DAY, now, userAgent.slice(0, 200));
    this.db.prepare('delete from sessions where expires_at < ?').run(now);
    return { token, maxAgeSec: this.sessionDays * 86_400 };
  }

  /** Valid sessions slide forward at most once a day to avoid a write per request. */
  validate(token: string | undefined): { valid: boolean; renewed: boolean } {
    if (!token || token.length > 128) return { valid: false, renewed: false };
    const id = sha256(token);
    const row = this.db.prepare('select expires_at, last_seen from sessions where id_hash = ?').get(id) as { expires_at: number; last_seen: number } | undefined;
    const now = Date.now();
    if (!row || row.expires_at < now) return { valid: false, renewed: false };
    if (now - row.last_seen < DAY) return { valid: true, renewed: false };
    this.db.prepare('update sessions set last_seen = ?, expires_at = ? where id_hash = ?').run(now, now + this.sessionDays * DAY, id);
    return { valid: true, renewed: true };
  }

  revoke(token: string | undefined) {
    if (token) this.db.prepare('delete from sessions where id_hash = ?').run(sha256(token));
  }
}
