import { createHash, randomBytes } from 'node:crypto';
import { isUniqueViolation, LEGACY_ADMIN_ID, truthy, type DB } from '../db';

export { LEGACY_ADMIN_ID };

export type RegistrationMode = 'closed' | 'invite' | 'open';

export interface User {
  id: string;
  issuer: string | null;
  subject: string | null;
  email: string;
  emailVerified: boolean;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  createdVia: 'legacy' | 'oidc';
  createdAt: number;
  lastLoginAt: number | null;
}

/** Profile facts taken from a verified ID token. Never a source of authorisation (no roles). */
export interface IdentityClaims {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

interface Row {
  id: string;
  issuer: string | null;
  subject: string | null;
  email: string;
  email_verified: number;
  display_name: string;
  is_admin: number;
  disabled: number;
  created_via: 'legacy' | 'oidc';
  created_at: number;
  last_login_at: number | null;
}

const toUser = (r: Row): User => ({
  id: r.id,
  issuer: r.issuer,
  subject: r.subject,
  email: r.email,
  emailVerified: truthy(r.email_verified),
  displayName: r.display_name,
  isAdmin: truthy(r.is_admin),
  disabled: truthy(r.disabled),
  createdVia: r.created_via,
  createdAt: Number(r.created_at),
  lastLoginAt: r.last_login_at === null ? null : Number(r.last_login_at),
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;

export type SignInResult = { ok: true; user: User; created: boolean } | { ok: false; reason: 'registration_closed' | 'invite_required' | 'invite_invalid' | 'disabled' };

export type LinkResult = 'linked' | 'already_linked' | 'identity_taken' | 'account_linked_elsewhere';

/**
 * Local accounts. The stable key of a person is the identity provider's `(issuer, subject)`; e-mail
 * is profile data that may change and never joins two accounts (no "same e-mail" merging, and the
 * first person to register gets nothing special).
 */
export class Users {
  constructor(
    private db: DB,
    private now: () => number = Date.now,
  ) {}

  async get(id: string): Promise<User | null> {
    const r = await this.db.get<Row>('select * from users where id = ?', [id]);
    return r ? toUser(r) : null;
  }

  async byIdentity(issuer: string, subject: string): Promise<User | null> {
    const r = await this.db.get<Row>('select * from users where issuer = ? and subject = ?', [issuer, subject]);
    return r ? toUser(r) : null;
  }

  async list(): Promise<User[]> {
    return (await this.db.all<Row>('select * from users order by created_at')).map(toUser);
  }

  /**
   * A verified OIDC sign-in. Known identities sign in (unless disabled); a new identity becomes an
   * account only as far as the registration mode allows. Idempotent: the unique (issuer, subject)
   * index means a repeated callback can never create a second account.
   */
  async signIn(claims: IdentityClaims, mode: RegistrationMode, invite?: string | null): Promise<SignInResult> {
    try {
      return await this.signInOnce(claims, mode, invite);
    } catch (e) {
      // Two first sign-ins of the same new identity at once (double-clicked callback, two tabs): the
      // unique index lets one create the account; the other then simply finds it.
      if (!isUniqueViolation(e)) throw e;
      return this.signInOnce(claims, mode, invite);
    }
  }

  private async signInOnce(claims: IdentityClaims, mode: RegistrationMode, invite?: string | null): Promise<SignInResult> {
    return this.db.tx(async () => {
      const t = this.now();
      const known = await this.byIdentity(claims.issuer, claims.subject);
      if (known) {
        if (known.disabled) return { ok: false, reason: 'disabled' } as const;
        await this.db.run('update users set email = ?, email_verified = ?, display_name = ?, last_login_at = ? where id = ?', [claims.email ?? known.email, claims.emailVerified ?? known.emailVerified, claims.name?.slice(0, 80) ?? known.displayName, t, known.id]);
        return { ok: true, user: (await this.get(known.id))!, created: false } as const;
      }
      if (mode === 'closed') return { ok: false, reason: 'registration_closed' } as const;
      if (mode === 'invite') {
        if (!invite) return { ok: false, reason: 'invite_required' } as const;
        const used = await this.db.run('update invites set used_at = ?, used_by = ? where code_hash = ? and used_at is null and expires_at > ?', [t, `${claims.issuer}|${claims.subject}`, sha256(invite), t]);
        if (!used.changes) return { ok: false, reason: 'invite_invalid' } as const;
      }
      const id = `u-${randomBytes(12).toString('hex')}`;
      await this.db.run('insert into users (id, issuer, subject, email, email_verified, display_name, is_admin, disabled, created_via, created_at, last_login_at) values (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)', [id, claims.issuer, claims.subject, claims.email ?? '', claims.emailVerified ?? false, claims.name?.slice(0, 80) ?? '', 'oidc', t, t]);
      return { ok: true, user: (await this.get(id))!, created: true } as const;
    });
  }

  /**
   * 旧管理员认领: binds an identity to an existing account that proved itself the old way. Refuses
   * when the identity already belongs to someone else or the account is already bound to a
   * different identity — nothing is ever merged.
   */
  async link(userId: string, claims: IdentityClaims): Promise<LinkResult> {
    return this.db.tx(async () => {
      const user = await this.get(userId);
      if (!user) return 'account_linked_elsewhere';
      const owner = await this.byIdentity(claims.issuer, claims.subject);
      if (owner) return owner.id === userId ? 'already_linked' : 'identity_taken';
      if (user.issuer || user.subject) return 'account_linked_elsewhere';
      // Conditional: of two claims racing for the same account, exactly one binds it.
      const { changes } = await this.db.run('update users set issuer = ?, subject = ?, email = ?, email_verified = ?, display_name = coalesce(nullif(?, \'\'), display_name), last_login_at = ? where id = ? and issuer is null and subject is null', [claims.issuer, claims.subject, claims.email ?? '', claims.emailVerified ?? false, claims.name?.slice(0, 80) ?? '', this.now(), userId]);
      return changes ? 'linked' : 'account_linked_elsewhere';
    });
  }

  async setDisabled(id: string, disabled: boolean): Promise<boolean> {
    return (await this.db.run('update users set disabled = ? where id = ?', [disabled, id])).changes > 0;
  }

  async setAdmin(id: string, admin: boolean): Promise<boolean> {
    return (await this.db.run('update users set is_admin = ? where id = ?', [admin, id])).changes > 0;
  }

  /** One-time invitation; only its hash is stored. Returns the code to hand out. */
  async createInvite(createdBy: string, ttlDays = 7): Promise<{ code: string; expiresAt: number }> {
    const code = `nxi_${randomBytes(18).toString('base64url')}`;
    const t = this.now();
    const expiresAt = t + Math.max(1, Math.min(30, ttlDays)) * DAY;
    await this.db.run('insert into invites (code_hash, created_by, created_at, expires_at) values (?, ?, ?, ?)', [sha256(code), createdBy, t, expiresAt]);
    return { code, expiresAt };
  }
}
