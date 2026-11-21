import { defaultConfig, type Op } from '@nexus/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginIntents } from './auth/intents';
import { ConfigRepo } from './config/repo';
import { LEGACY_ADMIN_ID, type DB } from './db';
import { DIALECTS, lockStep, PG_TARGET, testDb } from './db/testing';
import { Users } from './users/users';

/**
 * Guarantees that must hold when requests really run at the same time. SQLite (exclusive
 * transactions) and PGlite (one connection) serialize everything, so there these pass by
 * construction; with NEXUS_TEST_PG_URL the `pg` half runs on a real PostgreSQL server, where
 * concurrent transactions interleave and each guarantee needs its lock or conditional write.
 */
// PGlite under a loaded test run is slow; the guarantees are about outcomes, not speed.
vi.setConfig({ testTimeout: 30_000 });
const ISSUER = 'https://id.example.test/realms/accounts';
let db: DB | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

describe.each(DIALECTS)('concurrency (%s)', (dialect) => {
  it('concurrent batches for one account all land, each with its own revision (no lost update)', async () => {
    db = await testDb(dialect);
    const repo = new ConfigRepo(db);
    const pins = defaultConfig().pins;
    const results = await Promise.all(pins.map((appId, i) => repo.apply(LEGACY_ADMIN_ID, `batch-${i}`, 'client', [{ type: 'pin.remove', appId } satisfies Op], { admin: true })));
    expect(results.every((r) => r.changed)).toBe(true);
    expect(results.map((r) => r.snapshot.revision).sort((a, b) => a - b)).toEqual(pins.map((_, i) => i + 2));
    const final = await repo.snapshot(LEGACY_ADMIN_ID);
    expect(final.revision).toBe(pins.length + 1);
    expect(final.config.pins).toEqual([]);
  });

  it('a batch retried while the first attempt is still running is applied exactly once', async () => {
    db = await testDb(dialect);
    const repo = new ConfigRepo(db);
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => repo.apply(LEGACY_ADMIN_ID, 'same-batch', 'client', [{ type: 'pin.remove', appId: 'github' }], { admin: true })));
    expect(outcomes.map((o) => o.status)).toEqual(Array(5).fill('fulfilled'));
    const values = outcomes.map((o) => (o as PromiseFulfilledResult<Awaited<ReturnType<ConfigRepo['apply']>>>).value);
    expect(values.filter((v) => v.changed)).toHaveLength(1);
    expect(values.filter((v) => v.duplicate)).toHaveLength(4);
    expect((await repo.version(LEGACY_ADMIN_ID)).revision).toBe(2);
  });

  it('a sign-in attempt (state) can be redeemed once, even by two racing callbacks', async () => {
    db = await testDb(dialect);
    const intents = new LoginIntents(db);
    const i = await intents.create('login', { returnTo: '/' });
    const redeemed = await Promise.all([intents.consume(i.token, i.state), intents.consume(i.token, i.state), intents.consume(i.token, i.state)]);
    expect(redeemed.filter(Boolean)).toHaveLength(1);
  });

  it('two first sign-ins of the same new identity create one account and both succeed', async () => {
    db = await testDb(dialect);
    const users = new Users(db);
    const claims = { issuer: ISSUER, subject: 'sub-new', email: 'new@example.test', emailVerified: true };
    const results = await Promise.all([users.signIn(claims, 'open'), users.signIn(claims, 'open'), users.signIn(claims, 'open')]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.user.id : '')))).toHaveProperty('size', 1);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(await db.all('select id from users where issuer = ? and subject = ?', [ISSUER, 'sub-new'])).toHaveLength(1);
  });

  it('an invite admits exactly one new account when two people use it at once', async () => {
    db = await testDb(dialect);
    const users = new Users(db);
    const { code } = await users.createInvite(LEGACY_ADMIN_ID);
    const [a, b] = await Promise.all([users.signIn({ issuer: ISSUER, subject: 'sub-a' }, 'invite', code), users.signIn({ issuer: ISSUER, subject: 'sub-b' }, 'invite', code)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ reason: 'invite_invalid' });
  });

  it('of two identities racing to claim the legacy administrator, exactly one binds it', async () => {
    db = await testDb(dialect);
    const users = new Users(db);
    const results = await Promise.all([users.link(LEGACY_ADMIN_ID, { issuer: ISSUER, subject: 'sub-x' }), users.link(LEGACY_ADMIN_ID, { issuer: ISSUER, subject: 'sub-y' })]);
    expect([...results].sort()).toEqual(['account_linked_elsewhere', 'linked']);
    const winner = results[0] === 'linked' ? 'sub-x' : 'sub-y';
    expect((await users.get(LEGACY_ADMIN_ID))?.subject).toBe(winner);
  });
});

/**
 * The same guarantees with the race forced, not hoped for: a separate session holds the contested
 * row (or table) until every attempt has read its state and is queued on the write, then releases
 * them together. Each of these fails on the code before the 0.4 locking fixes.
 */
describe.runIf(PG_TARGET === 'postgresql')('forced interleavings (real PostgreSQL)', () => {
  const values = <T,>(r: PromiseSettledResult<T>[]) => r.map((x) => (x.status === 'fulfilled' ? x.value : Promise.reject(x.reason)));

  it('two batches that both read revision 1 cannot both write revision 2', async () => {
    db = await testDb('pg');
    const repo = new ConfigRepo(db);
    await repo.ensure(LEGACY_ADMIN_ID);
    const r = await lockStep(db, 'select 1 from user_config where owner_id = $1 for update', [LEGACY_ADMIN_ID], [
      () => repo.apply(LEGACY_ADMIN_ID, 'a', 'c', [{ type: 'pin.remove', appId: 'github' }], { admin: true }),
      () => repo.apply(LEGACY_ADMIN_ID, 'b', 'c', [{ type: 'pin.remove', appId: 'gmail' }], { admin: true }),
    ]);
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    const final = await repo.snapshot(LEGACY_ADMIN_ID);
    expect(final.revision).toBe(3);
    expect(final.config.pins).not.toContain('github');
    expect(final.config.pins).not.toContain('gmail');
  });

  it('two callbacks that both read the sign-in attempt: only one may use it', async () => {
    db = await testDb('pg');
    const intents = new LoginIntents(db);
    const i = await intents.create('login', {});
    const r = await lockStep(db, 'select 1 from login_intents for update', [], [() => intents.consume(i.token, i.state), () => intents.consume(i.token, i.state)]);
    expect((await Promise.all(values(r))).filter(Boolean)).toHaveLength(1);
  });

  it('two first sign-ins that both found no account: one creates it, the other finds it', async () => {
    db = await testDb('pg');
    const users = new Users(db);
    const claims = { issuer: ISSUER, subject: 'sub-race' };
    const r = await lockStep(db, 'lock table users in share row exclusive mode', [], [() => users.signIn(claims, 'open'), () => users.signIn(claims, 'open')]);
    const done = await Promise.all(values(r));
    expect(done.every((x) => x.ok)).toBe(true);
    expect(done.filter((x) => x.ok && x.created)).toHaveLength(1);
  });

  it('two claims that both saw an unbound administrator: exactly one binds it', async () => {
    db = await testDb('pg');
    const users = new Users(db);
    const r = await lockStep(db, 'select 1 from users where id = $1 for update', [LEGACY_ADMIN_ID], [() => users.link(LEGACY_ADMIN_ID, { issuer: ISSUER, subject: 'sub-x' }), () => users.link(LEGACY_ADMIN_ID, { issuer: ISSUER, subject: 'sub-y' })]);
    const done = await Promise.all(values(r));
    expect([...done].sort()).toEqual(['account_linked_elsewhere', 'linked']);
    expect((await users.get(LEGACY_ADMIN_ID))?.subject).toBe(done[0] === 'linked' ? 'sub-x' : 'sub-y');
  });
});
