import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { Devices, Pairings } from './devices';

const DAY = 86_400_000;

describe('Devices', () => {
  it('stores only a hash and records use at most hourly', () => {
    let t = 1_000_000;
    const db = openDb(':memory:');
    const devices = new Devices(db, () => t);
    const { token, device } = devices.create('Chrome', 'UA');
    expect(JSON.stringify(db.prepare('select * from devices').all())).not.toContain(token.slice(4));
    expect(devices.validate(token)?.id).toBe(device.id);
    const used = devices.list()[0]!.lastUsedAt;
    t += 10 * 60_000;
    devices.validate(token);
    expect(devices.list()[0]!.lastUsedAt).toBe(used);
    t += 60 * 60_000;
    devices.validate(token);
    expect(devices.list()[0]!.lastUsedAt).not.toBe(used);
  });

  it('a device idle for 180 days loses access', () => {
    let t = 0;
    const devices = new Devices(openDb(':memory:'), () => t);
    const { token } = devices.create('Chrome', '');
    t = 181 * DAY;
    expect(devices.validate(token)).toBeNull();
    expect(devices.list()).toEqual([]);
  });
});

describe('Pairings', () => {
  it('expire after ten minutes and cap the number waiting', () => {
    let t = 0;
    const pairings = new Pairings(new Devices(openDb(':memory:'), () => t), () => t);
    const s = pairings.start('A', '1.1.1.1', '');
    expect(pairings.peek(s.code)?.name).toBe('A');
    t = 10 * 60_000 + 1;
    expect(pairings.peek(s.code)).toBeNull();
    expect(pairings.decide(s.code, true)).toBe(false);
    expect(pairings.poll(s.pairId, s.secret)).toEqual({ status: 'expired' });
    for (let i = 0; i < 10; i++) pairings.start(`n${i}`, `10.0.0.${i}`, '');
    expect(() => pairings.start('one more', '10.0.1.1', '')).toThrow(/过多/);
  });

  it('an answered code cannot be answered again', () => {
    const pairings = new Pairings(new Devices(openDb(':memory:')));
    const s = pairings.start('A', 'ip', '');
    expect(pairings.decide(s.code, false)).toBe(true);
    expect(pairings.decide(s.code, true)).toBe(false);
    expect(pairings.poll(s.pairId, s.secret)).toEqual({ status: 'denied' });
  });
});
