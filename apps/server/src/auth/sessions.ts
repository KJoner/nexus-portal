import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { hashPassword, verifyPassword } from './password';

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

  /**
   * The configured password is the source of truth: when it changes, the stored hash is replaced
   * and every existing session is revoked.
   */
  async ensurePassword(password: string | null): Promise<'unchanged' | 'set' | 'missing'> {
    const row = this.db.prepare('select password_hash from auth where id = 1').get() as { password_hash: string } | undefined;
    if (!password) return row ? 'unchanged' : 'missing';
    if (row && (await verifyPassword(password, row.password_hash))) return 'unchanged';
    const hash = await hashPassword(password);
    this.db.transaction(() => {
      this.db.prepare('insert into auth (id, password_hash, updated_at) values (1, ?, ?) on conflict(id) do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at').run(hash, new Date().toISOString());
      this.db.prepare('delete from sessions').run();
    })();
    return 'set';
  }

  async checkPassword(password: string): Promise<boolean> {
    const row = this.db.prepare('select password_hash from auth where id = 1').get() as { password_hash: string } | undefined;
    return !!row && (await verifyPassword(password, row.password_hash));
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
