import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey, type JWTPayload } from 'jose';

/**
 * A minimal OpenID provider for tests (no network: it answers through a custom fetch). It signs
 * real RS256 ID tokens, checks PKCE, client authentication and the redirect URI at its token
 * endpoint, and can be told to misbehave so the relying party's checks can be exercised.
 */
export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
  /** The user signs in at the provider: returns the authorization code for the callback. */
  authorize(authUrl: URL, user: { sub: string; email?: string; emailVerified?: boolean; name?: string; sid?: string }): string;
  /** Next ID token: change its claims or header before it is signed (attack simulations). */
  tamper: ((payload: JWTPayload, header: { alg: string; kid?: string }) => void) | null;
  /** Sign with a key the provider never published. */
  signWithForeignKey: boolean;
  /** Refresh tokens of this subject are refused from now on (account disabled, signed out everywhere). */
  revokeRefresh(sub: string): void;
  /**
   * Keycloak Account REST API `DELETE {issuer}/account/sessions?current=true` (ADR-019 动作 C): how it
   * answers. `ok` ends every session of the token's user (its refresh tokens stop working, as in
   * Keycloak) and calls `onSessionsEnded`; `forbidden` is a token without `manage-account` (403);
   * `down` an unreachable provider.
   */
  accountApi: 'ok' | 'forbidden' | 'down';
  /** Subjects whose sessions the Account REST API ended, in order. */
  accountLogouts: string[];
  /** Called with the session ids the Account REST API ended (tests send the back-channel logouts). */
  onSessionsEnded: ((sub: string, sids: string[]) => Promise<void>) | null;
  /** Session ids of the subject's live sessions (one per sign-in). */
  sessionsOf(sub: string): string[];
  logoutToken(claims: { sub?: string; sid?: string; events?: unknown; nonce?: string }): Promise<string>;
  tokenRequests: URLSearchParams[];
}

export async function fakeIdp(opts: { issuer?: string; clientId?: string; clientSecret?: string } = {}): Promise<FakeIdp> {
  const issuer = opts.issuer ?? 'https://id.example.test/realms/accounts';
  const clientId = opts.clientId ?? 'nexus-web';
  const clientSecret = opts.clientSecret ?? 'test-client-secret';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; user: Parameters<FakeIdp['authorize']>[1] }>();
  const refresh = new Map<string, string>();
  const revoked = new Set<string>();
  /** refresh token → its session; access token → whose (user tokens carry manage-account). */
  const sessionOf = new Map<string, { sub: string; sid: string }>();
  const accessTokens = new Map<string, { sub: string }>();
  const userAccess = (sub: string) => {
    const at = randomBytes(12).toString('hex');
    accessTokens.set(at, { sub });
    return at;
  };

  const sign = async (payload: JWTPayload, idp: FakeIdp): Promise<string> => {
    const header = { alg: 'RS256', kid: 'k1' };
    idp.tamper?.(payload, header);
    idp.tamper = null;
    if (header.alg === 'none') {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${enc({ alg: 'none' })}.${enc(payload)}.`;
    }
    const key: JoseKey = idp.signWithForeignKey ? foreign.privateKey : privateKey;
    return new SignJWT(payload).setProtectedHeader(header).sign(key);
  };

  const idp: FakeIdp = {
    issuer,
    clientId,
    clientSecret,
    tamper: null,
    signWithForeignKey: false,
    tokenRequests: [],
    authorize(authUrl, user) {
      const p = authUrl.searchParams;
      if (`${authUrl.origin}${authUrl.pathname}` !== `${issuer}/protocol/openid-connect/auth`) throw new Error('not this provider');
      if (p.get('client_id') !== clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256') throw new Error('bad authorization request');
      const code = randomBytes(16).toString('hex');
      codes.set(code, { nonce: p.get('nonce') ?? '', challenge: p.get('code_challenge') ?? '', redirectUri: p.get('redirect_uri') ?? '', user });
      return code;
    },
    revokeRefresh(sub) {
      revoked.add(sub);
    },
    accountApi: 'ok',
    accountLogouts: [],
    onSessionsEnded: null,
    sessionsOf(sub) {
      return [...new Set([...sessionOf.entries()].filter(([rt, v]) => v.sub === sub && refresh.has(rt)).map(([, v]) => v.sid))];
    },
    async logoutToken(claims) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ iss: issuer, aud: clientId, iat: now, jti: randomBytes(8).toString('hex'), events: claims.events ?? { 'http://schemas.openid.net/event/backchannel-logout': {} }, ...(claims.sub ? { sub: claims.sub } : {}), ...(claims.sid ? { sid: claims.sid } : {}), ...(claims.nonce ? { nonce: claims.nonce } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'logout+jwt' })
        .sign(privateKey);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname;
      const base = new URL(issuer).pathname;
      if (path === `${base}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
          end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          backchannel_logout_supported: true,
          backchannel_logout_session_supported: true,
        });
      }
      if (path === `${base}/protocol/openid-connect/certs`) return Response.json({ keys: [jwk] });
      if (path === `${base}/account/sessions`) {
        const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        if (idp.accountApi === 'down') return new Response('unavailable', { status: 503 });
        const who = accessTokens.get(/^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? '');
        if (!who) return Response.json({ error: 'invalid_token' }, { status: 401 });
        if (idp.accountApi === 'forbidden') return Response.json({ error: 'HTTP 403 Forbidden' }, { status: 403 });
        if (method !== 'DELETE' || url.searchParams.get('current') !== 'true' || headers.get('accept') !== 'application/json') return Response.json({ error: 'bad request' }, { status: 400 });
        const sids = idp.sessionsOf(who.sub);
        for (const [rt, v] of sessionOf) if (v.sub === who.sub) refresh.delete(rt);
        idp.accountLogouts.push(who.sub);
        await idp.onSessionsEnded?.(who.sub, sids);
        return new Response(null, { status: 204 });
      }
      if (path === `${base}/protocol/openid-connect/token`) {
        const raw = input instanceof Request ? await input.text() : init?.body;
        const form = raw instanceof URLSearchParams ? raw : new URLSearchParams(String(raw ?? ''));
        idp.tokenRequests.push(form);
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        // RFC 6749 §2.3.1: both parts are form-urlencoded before base64 (a client may escape more than needed).
        const basic = /^Basic (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
        const [id, secret] = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':').map((v) => decodeURIComponent(v.replace(/\+/g, ' '))) : [];
        if (id !== clientId || secret !== clientSecret) return Response.json({ error: 'invalid_client' }, { status: 401 });
        const now = Math.floor(Date.now() / 1000);
        if (form.get('grant_type') === 'refresh_token') {
          const sub = refresh.get(form.get('refresh_token') ?? '');
          if (!sub || revoked.has(sub)) return Response.json({ error: 'invalid_grant', error_description: 'Session not active' }, { status: 400 });
          return Response.json({ access_token: userAccess(sub), token_type: 'Bearer', expires_in: 300 });
        }
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!grant) return Response.json({ error: 'invalid_grant', error_description: 'Code not valid' }, { status: 400 });
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return Response.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 });
        if (form.get('redirect_uri') !== grant.redirectUri) return Response.json({ error: 'invalid_grant', error_description: 'Incorrect redirect_uri' }, { status: 400 });
        const sid = grant.user.sid ?? randomBytes(8).toString('hex');
        const rt = randomBytes(16).toString('hex');
        refresh.set(rt, grant.user.sub);
        sessionOf.set(rt, { sub: grant.user.sub, sid });
        const id_token = await sign(
          { iss: issuer, aud: clientId, azp: clientId, sub: grant.user.sub, iat: now, exp: now + 300, nonce: grant.nonce, sid, email: grant.user.email, email_verified: grant.user.emailVerified ?? true, name: grant.user.name },
          idp,
        );
        return Response.json({ access_token: userAccess(grant.user.sub), token_type: 'Bearer', expires_in: 300, refresh_token: rt, id_token, scope: 'openid email profile' });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
  return idp;
}
