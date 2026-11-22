import { readdirSync, readFileSync } from 'node:fs';
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

  it("ADR-019: the account center's device page says what it really covers (browser sign-ins, not Obsidian or extensions)", () => {
    // Keycloak's own wording ("sign out all devices") made a tester believe Obsidian was disconnected too
    // (stage, 2026-11-22). The overrides are in the template and in the files ./configure.sh texts applies.
    const texts = realm.localizationTexts as Record<string, Record<string, string>>;
    expect(Object.keys(texts).sort()).toEqual(['en', 'zh-CN']);
    for (const locale of ['zh-CN', 'en']) {
      const file = JSON.parse(readFileSync(join(dir, 'texts', `account-texts.${locale}.json`), 'utf8')) as Record<string, string>;
      expect(texts[locale], locale).toEqual(file);
      expect(Object.keys(file).sort(), locale).toEqual(['deviceActivity', 'signOutAllDevices', 'signOutAllDevicesWarning', 'signedInDevices', 'signedInDevicesExplanation']);
      // Both the list explanation and the confirmation name what is not covered and where to go instead.
      for (const key of ['signedInDevicesExplanation', 'signOutAllDevicesWarning']) {
        expect(file[key], `${locale} ${key}`).toMatch(/Obsidian/);
        expect(file[key], `${locale} ${key}`).toContain('退出所有产品与设备');
      }
    }
    expect(texts['zh-CN']!.signOutAllDevices).toBe('退出所有浏览器');
    expect(texts['zh-CN']!.signOutAllDevices).not.toMatch(/设备/);
    expect(configure).toMatch(/texts\)/);
    expect(configure).toContain('realms/accounts/localization/$locale');
    expect(configure).toContain('texts/account-texts.$locale.json');
  });

  it('the import directory holds realm files only: Keycloak parses every .json there as a realm and stops on anything else', () => {
    // Found 2026-11-22: account-texts.*.json in realm/ made `start --import-realm` fail (Unrecognized field "deviceActivity").
    const files = readdirSync(join(dir, 'realm'));
    expect(files.filter((f) => f.endsWith('.json'))).toEqual(['accounts-realm.json']);
  });

  it('U3: the account center look is versioned here — themes inherit Keycloak 26 (no copied templates), each product its own login page', () => {
    expect(realm.loginTheme).toBe('accounts');
    expect(realm.accountTheme).toBe('accounts');
    expect(realm.emailTheme).toBe('accounts');
    const themes = Object.fromEntries(realm.clients.map((c) => [String(c.clientId), (c.attributes as Record<string, string> | undefined)?.login_theme]));
    expect(themes).toEqual({ 'nexus-web': 'accounts-nexus', 'litesync-web': 'accounts-litesync' });
    const parent = (t: string) => /^parent=(.+)$/m.exec(readFileSync(join(dir, 'themes', t, 'theme.properties'), 'utf8'))?.[1];
    expect(parent('accounts/login')).toBe('keycloak.v2');
    expect(parent('accounts/account')).toBe('keycloak.v3');
    expect(parent('accounts/email')).toBe('keycloak');
    expect(parent('accounts-nexus/login')).toBe('accounts');
    expect(parent('accounts-litesync/login')).toBe('accounts');
    // Only styles, messages and the e-mail wrapper: no page template of Keycloak's is copied.
    const ftl = (d: string): string[] => readdirSync(join(dir, 'themes', d), { recursive: true }).map(String).filter((f) => f.endsWith('.ftl'));
    expect(ftl('accounts/login')).toEqual([]);
    expect(ftl('accounts/email')).toEqual([join('html', 'template.ftl')]);
    expect(compose).toContain('./themes:/opt/keycloak/themes:ro');
    expect(configure).toContain('theme)');
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
