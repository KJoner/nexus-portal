import { randomBytes, scrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { EnvError, readEnv } from '../env';
import { hashPassword, isArgon2Hash, needsRehash, verifyPassword } from './password';
import { Auth } from './sessions';

/** A hash exactly as v0.1–v0.2.0 stored it. */
async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((res, rej) => scrypt(password.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
  return ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

describe('password hashing (v0.2.1)', () => {
  it('uses salted Argon2id PHC strings', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(isArgon2Hash(a)).toBe(true);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('wrong horse battery', a)).toBe(false);
    expect(needsRehash(a)).toBe(false);
  });

  it('still verifies the scrypt hashes of older releases', async () => {
    const old = await legacyHash('correct horse battery');
    expect(await verifyPassword('correct horse battery', old)).toBe(true);
    expect(needsRehash(old)).toBe(true);
  });

  it('rejects malformed or absurdly expensive configured hashes', () => {
    expect(isArgon2Hash('plain-text-password')).toBe(false);
    expect(isArgon2Hash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g')).toBe(false);
    expect(isArgon2Hash('$argon2id$v=19$m=9999999,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g')).toBe(false);
  });
});

describe('configured password', () => {
  const setup = () => {
    const db = openDb(':memory:');
    return { db, auth: new Auth(db, 30) };
  };
  const sessions = (db: ReturnType<typeof openDb>) => (db.prepare('select count(*) n from sessions').get() as { n: number }).n;

  it('NEXUS_PASSWORD_HASH is stored as is; a different one revokes every session', async () => {
    const { db, auth } = setup();
    const h1 = await hashPassword('first long password');
    expect(await auth.ensurePassword({ hash: h1, plain: null })).toBe('set');
    expect(await auth.ensurePassword({ hash: h1, plain: null })).toBe('unchanged');
    expect(await auth.checkPassword('first long password')).toBe(true);
    auth.createSession('test');
    expect(await auth.ensurePassword({ hash: await hashPassword('second long password'), plain: null })).toBe('set');
    expect(sessions(db)).toBe(0);
    expect(await auth.checkPassword('first long password')).toBe(false);
  });

  it('a plain password from an old .env upgrades the old hash in place and keeps sessions', async () => {
    const { db, auth } = setup();
    db.prepare("insert into auth (id, password_hash, updated_at) values (1, ?, 'x')").run(await legacyHash('old long password'));
    auth.createSession('test');
    expect(await auth.ensurePassword({ hash: null, plain: 'old long password' })).toBe('upgraded');
    expect(sessions(db)).toBe(1);
    expect((db.prepare('select password_hash h from auth').get() as { h: string }).h).toMatch(/^\$argon2id\$/);
    expect(await auth.ensurePassword({ hash: null, plain: 'old long password' })).toBe('unchanged');
  });

  it('migrating .env to a hash of the same password keeps working logins possible', async () => {
    const { auth } = setup();
    await auth.ensurePassword({ hash: null, plain: 'same long password' });
    expect(await auth.ensurePassword({ hash: await hashPassword('same long password'), plain: null })).toBe('set');
    expect(await auth.checkPassword('same long password')).toBe(true);
  });

  it('an old scrypt hash restored from a backup is upgraded at the next login', async () => {
    const { db, auth } = setup();
    db.prepare("insert into auth (id, password_hash, updated_at) values (1, ?, 'x')").run(await legacyHash('restored password'));
    expect(await auth.ensurePassword({ hash: null, plain: null })).toBe('unchanged');
    expect(await auth.checkPassword('restored password')).toBe(true);
    expect((db.prepare('select password_hash h from auth').get() as { h: string }).h).toMatch(/^\$argon2id\$/);
  });

  it('nothing configured and nothing stored is reported', async () => {
    expect(await setup().auth.ensurePassword({ hash: null, plain: null })).toBe('missing');
  });

  it('readEnv accepts a hash without a plain password and refuses a malformed one', async () => {
    const hash = await hashPassword('production password');
    const env = readEnv({ NODE_ENV: 'production', NEXUS_PASSWORD_HASH: hash });
    expect(env).toMatchObject({ passwordHash: hash, password: null, generatedPassword: false });
    expect(() => readEnv({ NODE_ENV: 'production', NEXUS_PASSWORD_HASH: 'not-a-hash' })).toThrow(EnvError);
    expect(readEnv({ NODE_ENV: 'development', NEXUS_PASSWORD_HASH: hash }).generatedPassword).toBe(false);
  });
});
