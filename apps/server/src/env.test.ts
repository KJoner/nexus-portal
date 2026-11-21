import { describe, expect, it } from 'vitest';
import { EnvError, readEnv } from './env';

const base = { NODE_ENV: 'development', NEXUS_PASSWORD: 'long enough password' };
const oidc = { NEXUS_OIDC_ISSUER: 'https://id.example.org/realms/accounts', NEXUS_OIDC_CLIENT_ID: 'nexus-web', NEXUS_OIDC_CLIENT_SECRET: 's', NEXUS_PUBLIC_URL: 'https://home.example.org/' };

describe('readEnv (v0.4)', () => {
  it('self-hosted stays as it was: SQLite, password, private-network checks allowed', () => {
    const env = readEnv(base);
    expect(env).toMatchObject({ databaseUrl: null, oidc: null, allowPrivate: true, registration: 'invite', legacyPasswordLogin: 'auto' });
    expect(readEnv({ ...base, NEXUS_HEALTH_ALLOW_PRIVATE: '' }).allowPrivate).toBe(true);
  });

  it('a public deployment does not reach into private networks unless told to', () => {
    expect(readEnv({ ...base, ...oidc }).allowPrivate).toBe(false);
    expect(readEnv({ ...base, ...oidc, NEXUS_HEALTH_ALLOW_PRIVATE: 'true' }).allowPrivate).toBe(true);
    expect(readEnv({ ...base, NEXUS_HEALTH_ALLOW_PRIVATE: 'false' }).allowPrivate).toBe(false);
  });

  it('OIDC needs the client credentials and this deployment’s own address (https in production)', () => {
    expect(readEnv({ ...base, ...oidc })).toMatchObject({ oidc: { issuer: oidc.NEXUS_OIDC_ISSUER, clientId: 'nexus-web' }, publicUrl: 'https://home.example.org' });
    expect(() => readEnv({ ...base, ...oidc, NEXUS_OIDC_CLIENT_SECRET: '' })).toThrow(EnvError);
    expect(() => readEnv({ ...base, ...oidc, NEXUS_PUBLIC_URL: '' })).toThrow(/NEXUS_PUBLIC_URL/);
    expect(() => readEnv({ NODE_ENV: 'production', NEXUS_SECRET: 'x'.repeat(16), ...oidc, NEXUS_PUBLIC_URL: 'http://home.example.org' })).toThrow(/https/);
  });

  it('account limits (TN-07): defaults, overrides, and nonsense refused at start', () => {
    expect(readEnv(base).quotas).toEqual({ items: 5000, wallpapers: 50, icons: 200, storageBytes: 200 * 1048576 });
    expect(readEnv({ ...base, NEXUS_QUOTA_WALLPAPERS: '10', NEXUS_QUOTA_STORAGE_MB: '1024' }).quotas).toMatchObject({ wallpapers: 10, storageBytes: 1024 * 1048576 });
    for (const bad of ['0', '-3', '1.5', 'lots']) expect(() => readEnv({ ...base, NEXUS_QUOTA_ICONS: bad })).toThrow(/NEXUS_QUOTA_ICONS/);
  });

  it('ADR-019: cross-product revocation needs both the address and a 32-byte secret, and unified sign-in', () => {
    const secret = 'a'.repeat(32);
    expect(readEnv({ ...base, ...oidc }).peerRevocation).toBeNull();
    expect(readEnv({ ...base, ...oidc, NEXUS_PEER_REVOCATION_URL: 'http://litesync:8080/', NEXUS_PEER_REVOCATION_SECRET: secret }).peerRevocation).toEqual({ url: 'http://litesync:8080', secret });
    expect(() => readEnv({ ...base, ...oidc, NEXUS_PEER_REVOCATION_URL: 'http://litesync:8080' })).toThrow(/同时设置/);
    expect(() => readEnv({ ...base, ...oidc, NEXUS_PEER_REVOCATION_SECRET: secret })).toThrow(/同时设置/);
    expect(() => readEnv({ ...base, ...oidc, NEXUS_PEER_REVOCATION_URL: 'http://litesync:8080', NEXUS_PEER_REVOCATION_SECRET: 'short' })).toThrow(/32 字节/);
    expect(() => readEnv({ ...base, ...oidc, NEXUS_PEER_REVOCATION_URL: 'litesync:8080', NEXUS_PEER_REVOCATION_SECRET: secret })).toThrow(/http/);
    expect(() => readEnv({ ...base, NEXUS_PEER_REVOCATION_URL: 'http://litesync:8080', NEXUS_PEER_REVOCATION_SECRET: secret })).toThrow(/NEXUS_OIDC_ISSUER/);
  });

  it('ADR-019: the central status check derives the admin API from the issuer, may be overridden, and needs OIDC', () => {
    expect(readEnv({ ...base, ...oidc }).identityStatus).toBeNull();
    expect(readEnv({ ...base, ...oidc, NEXUS_IDENTITY_STATUS_CHECK: 'on' }).identityStatus).toEqual({ adminUrl: 'https://id.example.org/admin/realms/accounts' });
    expect(readEnv({ ...base, ...oidc, NEXUS_IDENTITY_STATUS_CHECK: 'on', NEXUS_IDENTITY_ADMIN_URL: 'https://kc.internal.example/admin/realms/accounts/' }).identityStatus).toEqual({ adminUrl: 'https://kc.internal.example/admin/realms/accounts' });
    expect(() => readEnv({ ...base, ...oidc, NEXUS_OIDC_ISSUER: 'https://id.example.org/oauth', NEXUS_IDENTITY_STATUS_CHECK: 'on' })).toThrow(/NEXUS_IDENTITY_ADMIN_URL/);
    expect(() => readEnv({ ...base, NEXUS_IDENTITY_STATUS_CHECK: 'on' })).toThrow(/统一身份/);
    expect(() => readEnv({ ...base, ...oidc, NEXUS_IDENTITY_STATUS_CHECK: 'yes' })).toThrow(/on \/ off/);
  });

  it('rejects unknown modes and malformed connection strings instead of guessing', () => {
    expect(() => readEnv({ ...base, NEXUS_REGISTRATION_MODE: 'everyone' })).toThrow(/REGISTRATION_MODE/);
    expect(() => readEnv({ ...base, NEXUS_LEGACY_PASSWORD_LOGIN: 'maybe' })).toThrow(/LEGACY_PASSWORD_LOGIN/);
    expect(() => readEnv({ ...base, NEXUS_DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
    expect(readEnv({ ...base, NEXUS_DATABASE_URL: 'postgres://nexus_app:pw@db:5432/nexus' }).databaseUrl).toBe('postgres://nexus_app:pw@db:5432/nexus');
    expect(() => readEnv({ ...base, NEXUS_MAIL_PROVIDER: 'smtp' })).toThrow(/NEXUS_SMTP_URL/);
    expect(() => readEnv({ ...base, NEXUS_MAIL_PROVIDER: 'resend' })).toThrow(/NEXUS_RESEND_API_KEY/);
    expect(() => readEnv({ ...base, NEXUS_MAIL_PROVIDER: 'pigeon' })).toThrow(/NEXUS_MAIL_PROVIDER/);
  });
});
