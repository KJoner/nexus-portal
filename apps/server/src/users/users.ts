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
  /**
   * The login name at the identity service (`preferred_username`, UI v2 I1) as of the last sign-in:
   * a short name for new accounts, the e-mail address for older ones, '' when never sent. Shown to
   * the person on the account page only — never used to find, own, authorise or merge anything.
   */
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  createdVia: 'legacy' | 'oidc';
  createdAt: number;
  lastLoginAt: number | null;
  /**
   * ADR-019 授权代次: only grows. Every session, device and approved pairing was issued under one;
   * a credential whose epoch differs from this is revoked, however it raced with the revocation.
   */
  authEpoch: number;
  /** Last time the identity service confirmed the account is enabled (sign-in, refresh, status check). */
  identityCheckedAt: number | null;
}

/** Profile facts taken from a verified ID token. Never a source of authorisation (no roles). */
export interface IdentityClaims {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** `preferred_username`, trimmed; absent when the token has none (see `Users.signIn`). */
  username?: string;
}

interface Row {
  id: string;
  issuer: string | null;
  subject: string | null;
  email: string;
  email_verified: number;
  display_name: string;
  username: string | null;
  is_admin: number;
  disabled: number;
  created_via: 'legacy' | 'oidc';
  created_at: number;
  last_login_at: number | null;
  auth_epoch: number;
  identity_checked_at: number | null;
}

const toUser = (r: Row): User => ({
  id: r.id,
  issuer: r.issuer,
  subject: r.subject,
  email: r.email,
  emailVerified: truthy(r.email_verified),
  displayName: r.display_name,
  username: r.username ?? '',
  isAdmin: truthy(r.is_admin),
  disabled: truthy(r.disabled),
  createdVia: r.created_via,
  createdAt: Number(r.created_at),
  lastLoginAt: r.last_login_at === null ? null : Number(r.last_login_at),
  authEpoch: Number(r.auth_epoch ?? 0),
  identityCheckedAt: r.identity_checked_at === null || r.identity_checked_at === undefined ? null : Number(r.identity_checked_at),
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;

export type SignInResult = { ok: true; user: User; created: boolean } | { ok: false; reason: 'registration_closed' | 'invite_required' | 'invite_invalid' | 'disabled' };

export type LinkResult = 'linked' | 'already_linked' | 'identity_taken' | 'account_linked_elsewhere';

/** The display name snapshot is clipped to what the pages show. */
const clip = (s: string | undefined) => s?.slice(0, 80);
/**
 * The login name is kept whole up to Keycloak's own limit (255, as LiteSync does): a clipped one would
 * show a login name that does not work (an old account's long e-mail address is its login name).
 */
const clipLogin = (s: string | undefined) => s?.slice(0, 255);

/**
 * Local accounts. The stable key of a person is the identity provider's `(issuer, subject)`; e-mail,
 * display name and login name are profile data that may change and never join two accounts (no
 * "same e-mail" or "same nickname" merging, and the first person to register gets nothing special).
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
        // A verified sign-in also proves the identity service still has the account enabled. A claim
        // the token does not carry keeps the snapshot it had (display name and login name alike).
        await this.db.run('update users set email = ?, email_verified = ?, display_name = ?, username = ?, last_login_at = ?, identity_checked_at = ? where id = ?', [claims.email ?? known.email, claims.emailVerified ?? known.emailVerified, clip(claims.name) ?? known.displayName, clipLogin(claims.username) ?? known.username, t, t, known.id]);
        return { ok: true, user: (await this.get(known.id))!, created: false } as const;
      }
      if (mode === 'closed') return { ok: false, reason: 'registration_closed' } as const;
      if (mode === 'invite') {
        if (!invite) return { ok: false, reason: 'invite_required' } as const;
        const used = await this.db.run('update invites set used_at = ?, used_by = ? where code_hash = ? and used_at is null and expires_at > ?', [t, `${claims.issuer}|${claims.subject}`, sha256(invite), t]);
        if (!used.changes) return { ok: false, reason: 'invite_invalid' } as const;
      }
      const id = `u-${randomBytes(12).toString('hex')}`;
      await this.db.run('insert into users (id, issuer, subject, email, email_verified, display_name, username, is_admin, disabled, created_via, created_at, last_login_at, identity_checked_at) values (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)', [id, claims.issuer, claims.subject, claims.email ?? '', claims.emailVerified ?? false, clip(claims.name) ?? '', clipLogin(claims.username) ?? '', 'oidc', t, t, t]);
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
      // Conditional: of two claims racing for the same account, exactly one binds it. Display and
      // login name only fill in what the token carries (the old values stay otherwise).
      const { changes } = await this.db.run('update users set issuer = ?, subject = ?, email = ?, email_verified = ?, display_name = coalesce(nullif(?, \'\'), display_name), username = coalesce(nullif(?, \'\'), username), last_login_at = ?, identity_checked_at = ? where id = ? and issuer is null and subject is null', [claims.issuer, claims.subject, claims.email ?? '', claims.emailVerified ?? false, clip(claims.name) ?? '', clipLogin(claims.username) ?? '', this.now(), this.now(), userId]);
      return changes ? 'linked' : 'account_linked_elsewhere';
    });
  }

  /**
   * Only the flag. Disabling must also revoke (ADR-019 动作 B: Revocations.revokeProduct calls this
   * inside its transaction); enabling again restores the right to sign in, never an old credential —
   * the epoch stays where the revocation left it.
   */
  async setDisabled(id: string, disabled: boolean): Promise<boolean> {
    return (await this.db.run('update users set disabled = ? where id = ?', [disabled, id])).changes > 0;
  }

  /** The identity service confirmed the account is enabled (a refresh, a status check). */
  async markIdentityChecked(id: string, at = this.now()): Promise<void> {
    await this.db.run('update users set identity_checked_at = ? where id = ? and (identity_checked_at is null or identity_checked_at < ?)', [at, id, at]);
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
