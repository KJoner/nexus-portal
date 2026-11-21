import { createHash, randomBytes } from 'node:crypto';
import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from 'openid-client';
import type { DB } from '../db';

const TTL_MS = 10 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type IntentKind = 'login' | 'link';

export interface Intent {
  kind: IntentKind;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /** link: the account (already signed in the old way) that the identity will be bound to. */
  linkUserId: string | null;
  invite: string | null;
}

/**
 * Only a path of this product: one leading slash, no scheme, no `//` or backslash (both read as
 * "another host" by browsers), no control characters. Anything else falls back to the home page.
 */
export function safeReturnTo(input: string | null | undefined): string {
  // No trimming: anything but a clean path (surrounding spaces included) falls back to home.
  const v = input ?? '';
  if (!v || v.length > 512) return '/';
  if (!/^\/(?![/\\])/.test(v) || /[\\\s\u0000-\u001f\u007f]/.test(v)) return '/';
  try {
    // Percent-encoded slashes or backslashes must not sneak in either.
    const decoded = decodeURIComponent(v);
    if (/^\/[/\\]/.test(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) return '/';
  } catch {
    return '/';
  }
  return v;
}

/**
 * OIDC sign-ins in progress. The browser gets a random intent token in a short-lived cookie; the
 * database keeps only its hash with the state, nonce and PKCE verifier. The callback must present
 * both the cookie and the matching state, and an intent is consumed by the first attempt whatever
 * its outcome — a stolen or replayed callback URL from another browser leads nowhere.
 */
export class LoginIntents {
  constructor(
    private db: DB,
    private now: () => number = Date.now,
  ) {}

  async create(kind: IntentKind, opts: { returnTo?: string | null; linkUserId?: string | null; invite?: string | null } = {}): Promise<{ token: string; state: string; nonce: string; codeChallenge: string; maxAgeSec: number }> {
    const token = randomBytes(32).toString('base64url');
    const state = randomState();
    const nonce = randomNonce();
    const verifier = randomPKCECodeVerifier();
    const t = this.now();
    await this.db.run('delete from login_intents where expires_at < ?', [t]);
    await this.db.run('insert into login_intents (id_hash, kind, state, nonce, verifier, return_to, link_user_id, invite_code, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      sha256(token),
      kind,
      state,
      nonce,
      verifier,
      safeReturnTo(opts.returnTo),
      opts.linkUserId ?? null,
      opts.invite?.slice(0, 128) ?? null,
      t,
      t + TTL_MS,
    ]);
    return { token, state, nonce, codeChallenge: await calculatePKCECodeChallenge(verifier), maxAgeSec: TTL_MS / 1000 };
  }

  /** Single use: the row is deleted by this call, matched or not. */
  async consume(token: string | undefined, state: string | null | undefined): Promise<Intent | null> {
    if (!token || token.length > 128) return null;
    const id = sha256(token);
    return this.db.tx(async () => {
      const row = await this.db.get<{ kind: IntentKind; state: string; nonce: string; verifier: string; return_to: string; link_user_id: string | null; invite_code: string | null; expires_at: number }>('select kind, state, nonce, verifier, return_to, link_user_id, invite_code, expires_at from login_intents where id_hash = ?', [id]);
      // Single use even under concurrency: only the request whose delete removed the row may continue.
      const { changes } = await this.db.run('delete from login_intents where id_hash = ?', [id]);
      if (!row || !changes || Number(row.expires_at) < this.now() || !state || row.state !== state) return null;
      return { kind: row.kind, state: row.state, nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to, linkUserId: row.link_user_id, invite: row.invite_code };
    });
  }
}
