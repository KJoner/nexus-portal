import { createRemoteJWKSet, customFetch as joseFetch, jwtVerify, type JWTPayload } from 'jose';
import * as client from 'openid-client';
import type { IdentityClaims } from '../users/users';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Exact callback address registered with the identity provider. */
  redirectUri: string;
  postLogoutRedirectUri: string;
  /** Development and tests only: allow an http:// issuer. */
  allowHttp?: boolean;
  fetch?: typeof fetch;
}

/**
 * The display-name snapshot taken at sign-in (v12.0.3 I1): the nickname the user chose, else the
 * old full name, else the login name. Trimmed; blank values are skipped. Only for display — accounts
 * are matched by (issuer, subject), never by any of these (two people may share a nickname).
 */
export function displayNameFromClaims(c: Readonly<Record<string, unknown>>): string | undefined {
  for (const v of [c.nickname, c.name, c.preferred_username]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * The login-name snapshot (UI v2 I1): `preferred_username` as the identity service sent it, trimmed;
 * undefined when absent or blank. Only for the account page's 登录用户名 — never derived from the
 * nickname or e-mail, and never a way to find or match an account.
 */
export function usernameFromClaims(c: Readonly<Record<string, unknown>>): string | undefined {
  const v = c.preferred_username;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export class OidcError extends Error {
  constructor(
    readonly code: 'unavailable' | 'rejected',
    message: string,
  ) {
    super(message);
  }
}

export interface SignedIn {
  claims: IdentityClaims;
  /** Identity-provider session id (`sid`), for back-channel logout. */
  sid: string | null;
  refreshToken: string | null;
  idToken: string;
}

const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/**
 * Relying party for the shared identity service (ADR-011). This product never issues tokens or
 * handles passwords: sign-in is the authorization code flow with PKCE against the provider, done
 * on the server (the browser never sees a token). openid-client checks state, nonce, PKCE and the
 * ID token (signature from the provider's JWKS, issuer, audience/azp, expiry); roles are never
 * read from tokens.
 */
export class Oidc {
  private config: Promise<client.Configuration> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(readonly settings: OidcSettings) {}

  private cfg(): Promise<client.Configuration> {
    this.config ??= (async () => {
      // Verify the ID token's signature against the provider's published keys too. The spec allows
      // trusting TLS for tokens fetched from the token endpoint (and the library defaults to that);
      // checking the signature as well is required here (requirements §3.2) and catches a token
      // endpoint that is not really the provider.
      const options: client.DiscoveryRequestOptions = { execute: [client.enableNonRepudiationChecks] };
      if (this.settings.fetch) options[client.customFetch] = this.settings.fetch as client.CustomFetch;
      if (this.settings.allowHttp) options.execute!.push(client.allowInsecureRequests);
      try {
        return await client.discovery(new URL(this.settings.issuer), this.settings.clientId, { id_token_signed_response_alg: 'RS256' }, client.ClientSecretBasic(this.settings.clientSecret), options);
      } catch (e) {
        throw new OidcError('unavailable', `无法连接身份服务：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    // A failed discovery is retried at the next sign-in instead of being remembered.
    this.config.catch(() => {
      this.config = null;
    });
    return this.config;
  }

  async authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; prompt?: 'login' }): Promise<URL> {
    const config = await this.cfg();
    return client.buildAuthorizationUrl(config, {
      redirect_uri: this.settings.redirectUri,
      scope: 'openid email profile',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      ...(p.prompt ? { prompt: p.prompt } : {}),
    });
  }

  /** Validates the callback and exchanges the code. Any failed check throws `OidcError('rejected')`. */
  async exchange(callbackUrl: URL, checks: { state: string; nonce: string; verifier: string }): Promise<SignedIn> {
    const config = await this.cfg();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, callbackUrl, { expectedState: checks.state, expectedNonce: checks.nonce, pkceCodeVerifier: checks.verifier, idTokenExpected: true });
    } catch (e) {
      throw new OidcError('rejected', e instanceof Error ? e.message : String(e));
    }
    const c = tokens.claims();
    if (!c || !tokens.id_token) throw new OidcError('rejected', 'ID Token 缺失');
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      claims: { issuer: c.iss, subject: c.sub, email: str(c.email), emailVerified: c.email_verified === true, name: displayNameFromClaims(c), username: usernameFromClaims(c) },
      sid: str(c.sid) ?? null,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token,
    };
  }

  /**
   * Periodic re-check of a session with the provider. `invalid` means the provider no longer
   * honours it (signed out everywhere, account disabled or deleted); `unavailable` is a network or
   * provider failure, which callers tolerate for a limited time.
   */
  async refresh(refreshToken: string): Promise<{ ok: true; refreshToken: string | null; accessToken: string } | { ok: false; reason: 'invalid' | 'unavailable' }> {
    let config: client.Configuration;
    try {
      config = await this.cfg();
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    try {
      const t = await client.refreshTokenGrant(config, refreshToken);
      return { ok: true, refreshToken: t.refresh_token ?? null, accessToken: t.access_token };
    } catch (e) {
      if (e instanceof client.ResponseBodyError) return { ok: false, reason: 'invalid' };
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * ADR-019 动作 C 第 2 步: ends every session of the user at the identity service — all browsers,
   * both products — with the user's own access token and their own `manage-account` right (Keycloak
   * Account REST API; the realm template maps that role into this client's tokens). Never an
   * administrator credential, and the browser never sees the token.
   */
  async endAllSessions(accessToken: string): Promise<{ ok: true } | { ok: false; reason: 'forbidden' | 'not_supported' | 'unavailable' }> {
    const url = `${this.settings.issuer.replace(/\/+$/, '')}/account/sessions?current=true`;
    let res: Response;
    try {
      res = await (this.settings.fetch ?? fetch)(url, { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (res.ok) return { ok: true };
    // 401/403: the token lacks `manage-account` (the realm has not been updated) or was refused.
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'forbidden' };
    if (res.status === 404 || res.status === 405) return { ok: false, reason: 'not_supported' };
    return { ok: false, reason: 'unavailable' };
  }

  /**
   * ADR-019 §2.5: an access token of this client's own service account (client credentials). The
   * realm grants it realm-management `view-users` only: it can read whether an account is enabled,
   * and change nothing. Throws OidcError('unavailable') when the provider refuses or is down.
   */
  async serviceToken(): Promise<{ accessToken: string; expiresAt: number }> {
    const config = await this.cfg();
    try {
      const t = await client.clientCredentialsGrant(config);
      return { accessToken: t.access_token, expiresAt: Date.now() + Math.max(10, t.expires_in ?? 60) * 1000 };
    } catch (e) {
      throw new OidcError('unavailable', e instanceof client.ResponseBodyError ? `服务账号被拒绝：${e.error}` : '无法取得服务账号令牌');
    }
  }

  /** The fetch this client uses (tests inject the fake provider's). */
  get fetchImpl(): typeof fetch {
    return this.settings.fetch ?? fetch;
  }

  async endSessionUrl(idTokenHint: string | null): Promise<URL | null> {
    try {
      const config = await this.cfg();
      if (!config.serverMetadata().end_session_endpoint) return null;
      return client.buildEndSessionUrl(config, { post_logout_redirect_uri: this.settings.postLogoutRedirectUri, client_id: this.settings.clientId, ...(idTokenHint ? { id_token_hint: idTokenHint } : {}) });
    } catch {
      return null;
    }
  }

  /** Back-channel logout token (OIDC Back-Channel Logout 1.0 §2.6). */
  async verifyLogoutToken(token: string): Promise<{ sub: string | null; sid: string | null }> {
    const config = await this.cfg();
    const meta = config.serverMetadata();
    if (!meta.jwks_uri) throw new OidcError('rejected', '身份服务没有公开 JWKS');
    this.jwks ??= createRemoteJWKSet(new URL(meta.jwks_uri), this.settings.fetch ? { [joseFetch]: this.settings.fetch } : undefined);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { issuer: meta.issuer, audience: this.settings.clientId, algorithms: ['RS256', 'ES256', 'PS256'], maxTokenAge: '5m' }));
    } catch (e) {
      throw new OidcError('rejected', e instanceof Error ? e.message : String(e));
    }
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object' || !(BACKCHANNEL_EVENT in events)) throw new OidcError('rejected', '不是登出令牌');
    if ('nonce' in payload) throw new OidcError('rejected', '登出令牌不能包含 nonce');
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    const sid = typeof payload.sid === 'string' ? payload.sid : null;
    if (!sub && !sid) throw new OidcError('rejected', '登出令牌缺少 sub 与 sid');
    return { sub, sid };
  }
}
