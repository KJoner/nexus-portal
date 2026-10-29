import type { PairPollResponse } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import { pair, PairError } from './pair';

function server(answers: (PairPollResponse | 'offline')[]) {
  const seen: string[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    seen.push(`${path} ${init?.body ?? ''}`);
    if (path === '/api/pair/start') return Response.json({ pairId: 'p1', secret: 's3cret', code: 'ABCD-EFGH', expiresIn: 600, interval: 2 }, { status: 201 });
    const next = answers.shift() ?? { status: 'pending' };
    if (next === 'offline') throw new TypeError('Failed to fetch');
    return Response.json(next);
  }) as typeof globalThis.fetch;
  return { fetch: fake, seen };
}

const opts = (fetch: typeof globalThis.fetch, onCode: (code: string, url: string) => void = () => {}) => {
  let t = 0;
  return { fetch, signal: new AbortController().signal, onCode, now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe('pair', () => {
  it('shows the code, waits for approval (riding out a network blip) and returns the device', async () => {
    const s = server([{ status: 'pending' }, 'offline', { status: 'approved', token: 'nxd_tok', device: { id: 'd1', name: 'Chrome · Windows', createdAt: '2026-10-29T00:00:00.000Z', lastUsedAt: null } }]);
    const codes: string[] = [];
    const r = await pair('https://nexus.example.com', 'Chrome · Windows', opts(s.fetch, (code: string, url: string) => void codes.push(code, url)));
    expect(codes).toEqual(['ABCD-EFGH', 'https://nexus.example.com/settings/data?pair=ABCD-EFGH']);
    expect(r).toMatchObject({ origin: 'https://nexus.example.com', token: 'nxd_tok', deviceId: 'd1' });
    expect(s.seen.filter((x) => x.startsWith('/api/pair/poll')).every((x) => x.includes('"secret":"s3cret"'))).toBe(true);
  });

  it('a refusal or an expired request ends with a clear reason', async () => {
    await expect(pair('https://n.example.com', 'x', opts(server([{ status: 'denied' }]).fetch))).rejects.toMatchObject({ reason: 'denied' });
    await expect(pair('https://n.example.com', 'x', opts(server([{ status: 'expired' }]).fetch))).rejects.toBeInstanceOf(PairError);
    // Never approved within ten minutes.
    await expect(pair('https://n.example.com', 'x', opts(server([]).fetch))).rejects.toMatchObject({ reason: 'expired' });
  });

  it('an address that is not a Nexus Portal (no pairing endpoint) says so', async () => {
    const notNexus = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await expect(pair('https://example.com', 'x', opts(notNexus))).rejects.toMatchObject({ kind: 'incompatible' });
  });
});
