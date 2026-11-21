import { describe, expect, it } from 'vitest';
import { LEGACY_ADMIN_ID, openDb } from '../db';
import { DIALECTS, testDb } from '../db/testing';
import { Devices, Pairings } from './devices';

const DAY = 86_400_000;
const ADMIN = LEGACY_ADMIN_ID;

describe('Devices', () => {
  it('stores only a hash and records use at most hourly', async () => {
    let t = 1_000_000;
    const db = openDb(':memory:');
    const devices = new Devices(db, () => t);
    const { token, device } = await devices.create(ADMIN, 'Chrome', 'UA');
    expect(JSON.stringify(db.prepare('select * from devices').all())).not.toContain(token.slice(4));
    expect((await devices.validate(token))?.id).toBe(device.id);
    const used = (await devices.list(ADMIN))[0]!.lastUsedAt;
    t += 10 * 60_000;
    await devices.validate(token);
    expect((await devices.list(ADMIN))[0]!.lastUsedAt).toBe(used);
    t += 60 * 60_000;
    await devices.validate(token);
    expect((await devices.list(ADMIN))[0]!.lastUsedAt).not.toBe(used);
  });

  it('a device idle for 180 days loses access', async () => {
    let t = 0;
    const devices = new Devices(openDb(':memory:'), () => t);
    const { token } = await devices.create(ADMIN, 'Chrome', '');
    t = 181 * DAY;
    expect(await devices.validate(token)).toBeNull();
    expect(await devices.list(ADMIN)).toEqual([]);
  });
});

describe('Pairings', () => {
  it('expire after ten minutes and cap the number waiting', async () => {
    let t = 0;
    const pairings = new Pairings(new Devices(openDb(':memory:'), () => t), () => t);
    const s = pairings.start('A', '1.1.1.1', '');
    expect(pairings.peek(s.code)?.name).toBe('A');
    t = 10 * 60_000 + 1;
    expect(pairings.peek(s.code)).toBeNull();
    expect(pairings.decide(s.code, true, ADMIN)).toBe(false);
    expect(await pairings.poll(s.pairId, s.secret)).toEqual({ status: 'expired' });
    for (let i = 0; i < 10; i++) pairings.start(`n${i}`, `10.0.0.${i}`, '');
    expect(() => pairings.start('one more', '10.0.1.1', '')).toThrow(/过多/);
  });

  it('an answered code cannot be answered again', async () => {
    const pairings = new Pairings(new Devices(openDb(':memory:')));
    const s = pairings.start('A', 'ip', '');
    expect(pairings.decide(s.code, false)).toBe(true);
    expect(pairings.decide(s.code, true, ADMIN)).toBe(false);
    expect(await pairings.poll(s.pairId, s.secret)).toEqual({ status: 'denied' });
  });
});

describe.each(DIALECTS)('accounts and scopes (v0.4, %s)', (dialect) => {
  const addUser = async (db: Awaited<ReturnType<typeof testDb>>, id: string) => db.run('insert into users (id, issuer, subject, created_via, created_at) values (?, ?, ?, ?, ?)', [id, 'https://id.example', id, 'oidc', Date.now()]);

  it('a device belongs to the account that approved it, with no more than it asked for', async () => {
    const db = await testDb(dialect);
    await addUser(db, 'u-a');
    const devices = new Devices(db);
    const pairings = new Pairings(devices);
    const s = pairings.start('Edge', 'ip', 'UA', ['items:read', 'items:write']);
    expect(pairings.peek(s.code)?.scopes).toEqual(['items:read', 'items:write']);
    // The user grants less than asked; nothing beyond the request can be granted.
    expect(pairings.decide(s.code, true, 'u-a', ['items:read', 'pins:write'])).toBe(true);
    const r = await pairings.poll(s.pairId, s.secret);
    expect(r.status).toBe('approved');
    const auth = await devices.validate((r as { token: string }).token);
    expect(auth).toMatchObject({ ownerId: 'u-a', scopes: ['items:read'] });
    await db.close();
  });

  it('old and unspecified requests stay read-only; approving needs an account', async () => {
    const db = await testDb(dialect);
    const devices = new Devices(db);
    const pairings = new Pairings(devices);
    const s = pairings.start('Chrome', 'ip', '');
    expect(pairings.decide(s.code, true)).toBe(false);
    expect(pairings.decide(s.code, true, ADMIN)).toBe(true);
    const r = (await pairings.poll(s.pairId, s.secret)) as { token: string };
    expect((await devices.validate(r.token))?.scopes).toEqual(['config:read']);
    await db.close();
  });

  it('lists and revokes only the account’s own devices; a disabled account’s tokens stop working', async () => {
    const db = await testDb(dialect);
    await addUser(db, 'u-a');
    await addUser(db, 'u-b');
    const devices = new Devices(db);
    const a = await devices.create('u-a', 'A phone', '');
    const b = await devices.create('u-b', 'B laptop', '');
    expect((await devices.list('u-a')).map((d) => d.name)).toEqual(['A phone']);
    expect(await devices.revoke('u-a', b.device.id)).toBe(false);
    expect(await devices.validate(b.token)).not.toBeNull();
    await db.run('update users set disabled = 1 where id = ?', ['u-a']);
    expect(await devices.validate(a.token)).toBeNull();
    expect(await devices.revoke('u-b', b.device.id)).toBe(true);
    expect(await devices.validate(b.token)).toBeNull();
    await db.close();
  });
});
