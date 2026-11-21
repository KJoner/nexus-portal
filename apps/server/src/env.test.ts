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
    expect(readEnv(base).quotas).toEqual({ wallpapers: 50, icons: 200, storageBytes: 200 * 1048576 });
    expect(readEnv({ ...base, NEXUS_QUOTA_WALLPAPERS: '10', NEXUS_QUOTA_STORAGE_MB: '1024' }).quotas).toMatchObject({ wallpapers: 10, storageBytes: 1024 * 1048576 });
    for (const bad of ['0', '-3', '1.5', 'lots']) expect(() => readEnv({ ...base, NEXUS_QUOTA_ICONS: bad })).toThrow(/NEXUS_QUOTA_ICONS/);
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
