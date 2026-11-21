import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the identity templates in infra/identity (ADR-011): the settings that make sign-in safe
 * are fixed in the repository, so an edit that weakens one fails here instead of in production.
 * This does not run Keycloak; the real-instance checks are listed in infra/identity/README.md.
 */
const dir = join(import.meta.dirname, '..', '..', '..', 'infra', 'identity');
const realm = JSON.parse(readFileSync(join(dir, 'realm', 'accounts-realm.json'), 'utf8')) as Record<string, unknown> & {
  clients: Record<string, unknown>[];
  attributes: Record<string, string>;
  smtpServer: Record<string, string>;
  clientScopeMappings: Record<string, { client: string; roles: string[] }[]>;
  users: { username: string; serviceAccountClientId?: string; clientRoles?: Record<string, string[]>; realmRoles?: string[]; credentials?: unknown }[];
};
const configure = readFileSync(join(dir, 'configure.sh'), 'utf8');
const compose = readFileSync(join(dir, 'compose.yaml'), 'utf8');
const init = readFileSync(join(dir, 'postgres-init', '01-databases.sh'), 'utf8');

describe('identity realm template', () => {
  it('requires verified e-mail, limits link lifetimes and resists password guessing', () => {
    expect(realm).toMatchObject({ realm: 'accounts', verifyEmail: true, registrationEmailAsUsername: true, duplicateEmailsAllowed: false, resetPasswordAllowed: true, rememberMe: false, bruteForceProtected: true, sslRequired: 'external' });
    expect(realm.attributes['actionTokenGeneratedByUserLifespan.verify-email']).toBe('1800');
    expect(realm.attributes['actionTokenGeneratedByUserLifespan.reset-credentials']).toBe('900');
    expect(String(realm.passwordPolicy)).toMatch(/length\((1\d|[89])\)/);
    expect(realm.defaultLocale).toBe('zh-CN');
    // Admin event details can carry personal data: off.
    expect(realm.adminEventsDetailsEnabled).toBe(false);
  });

  it('has exactly the two product clients, each confidential, code flow with PKCE S256 only', () => {
    expect(realm.clients.map((c) => c.clientId).sort()).toEqual(['litesync-web', 'nexus-web']);
    for (const c of realm.clients) {
      const a = c.attributes as Record<string, string>;
      const base = c.clientId === 'nexus-web' ? '${NEXUS_PUBLIC_URL}' : '${LITESYNC_PUBLIC_URL}';
      // ADR-019: the service account is on (read-only, see below); still no password grant, no public client.
      expect(c, String(c.clientId)).toMatchObject({ publicClient: false, standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: true, frontchannelLogout: false, fullScopeAllowed: false });
      expect(a['pkce.code.challenge.method']).toBe('S256');
      expect(a['oauth2.device.authorization.grant.enabled']).toBe('false');
      // Exact callback, no wildcards anywhere.
      expect(c.redirectUris).toEqual([`${base}/auth/callback`]);
      expect(c.webOrigins).toEqual([base]);
      expect(JSON.stringify(c)).not.toMatch(/\*|"\+"/);
      expect(a['backchannel.logout.url']).toBe(`${base}/auth/backchannel-logout`);
      expect(a['backchannel.logout.session.required']).toBe('true');
      // Secrets are never in the repository.
      expect(String(c.secret)).toMatch(/^\$\{[A-Z_]+\}$/);
    }
  });

  it('ADR-019: tokens carry exactly manage-account (users, their own account) and view-users (the service account), nothing more', () => {
    // fullScopeAllowed=false: only scope-mapped roles reach a token, and `roles` writes resource_access / aud.
    for (const c of realm.clients) expect(c.defaultClientScopes, String(c.clientId)).toContain('roles');
    expect(Object.keys(realm.clientScopeMappings).sort()).toEqual(['account', 'realm-management']);
    for (const [owner, role] of [['account', 'manage-account'], ['realm-management', 'view-users']] as const) {
      const m = realm.clientScopeMappings[owner]!;
      expect(m.map((x) => x.client).sort(), owner).toEqual(['litesync-web', 'nexus-web']);
      for (const x of m) expect(x.roles, `${owner} → ${x.client}`).toEqual([role]);
    }
    // The only users in the template are the two service accounts, each with view-users and nothing else.
    expect(realm.users.map((u) => [u.username, u.serviceAccountClientId]).sort()).toEqual([
      ['service-account-litesync-web', 'litesync-web'],
      ['service-account-nexus-web', 'nexus-web'],
    ]);
    for (const u of realm.users) {
      expect(u.clientRoles, u.username).toEqual({ 'realm-management': ['view-users'] });
      expect(u.realmRoles ?? [], u.username).toEqual([]);
      expect(u.credentials, u.username).toBeUndefined();
    }
    expect(JSON.stringify(realm)).not.toMatch(/manage-users|realm-admin|manage-realm|impersonation/);
    // Deployed realms get the same through ./configure.sh revocation.
    expect(configure).toMatch(/revocation\)/);
    for (const piece of ['serviceAccountsEnabled=true', 'default-client-scopes', 'scope-mappings/clients/$account', 'scope-mappings/clients/$realm_mgmt', '--rolename view-users']) expect(configure).toContain(piece);
    // (Comments may name what is not granted; no command does.)
    expect(configure.split('\n').filter((l) => !l.trim().startsWith('#') && /manage-users|realm-admin/.test(l))).toEqual([]);
  });

  it('keeps every credential out of the files', () => {
    expect(realm.smtpServer.password).toBe('${SMTP_PASSWORD}');
    for (const line of compose.split('\n').filter((l) => /PASSWORD|SECRET/.test(l) && l.includes(':') && !l.trim().startsWith('#'))) expect(line, line).toMatch(/\$\{[A-Z_]+/);
  });

  it('exposes no port beyond this machine and isolates the database roles', () => {
    for (const m of compose.matchAll(/^\s*- "([^"]+):\d+"$/gm)) expect(m[1]).toMatch(/^127\.0\.0\.1:/);
    for (const db of ['keycloak', 'nexus', 'litesync']) expect(init).toMatch(new RegExp(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db}\\s+FROM PUBLIC`));
    expect(init).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  });

  it('the litesync database sorts bytewise (C): LiteSync refuses any other collation at start', () => {
    // Paths and paging cursors must order exactly like its SQLite (BINARY); a locale collation drifts.
    const litesync = /CREATE DATABASE litesync\b[^;]*;/.exec(init)?.[0] ?? '';
    expect(litesync).toMatch(/TEMPLATE template0/);
    expect(litesync).toMatch(/ENCODING 'UTF8'/);
    expect(litesync).toMatch(/LC_COLLATE 'C'/);
    expect(litesync).toMatch(/LC_CTYPE 'C'/);
    // The other two keep the instance default (nothing of theirs depends on byte order).
    expect(/CREATE DATABASE nexus\b[^;]*;/.exec(init)?.[0]).not.toMatch(/LC_COLLATE/);
    expect(/CREATE DATABASE keycloak\b[^;]*;/.exec(init)?.[0]).not.toMatch(/LC_COLLATE/);
  });
});
