import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../db';
import { DIALECTS, testDb } from '../db/testing';
import { LogProvider, MailSendError, Outbox, recipientHash, ResendProvider, type MailProvider, type OutgoingMail } from './outbox';

/** A provider that fails as told, then succeeds. */
class Flaky implements MailProvider {
  readonly name = 'flaky';
  calls: OutgoingMail[] = [];
  constructor(private failures: MailSendError[]) {}
  async send(m: OutgoingMail) {
    this.calls.push(m);
    const f = this.failures.shift();
    if (f) throw f;
    return { id: `ok-${this.calls.length}` };
  }
}

let db: DB | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
  vi.restoreAllMocks();
});

describe.each(DIALECTS)('mail outbox (%s)', (dialect) => {
  const sender = { from: 'Nexus <no-reply@mail.example.org>', replyTo: 'support@example.org' };

  it('stores before sending and never queues the same notice twice', async () => {
    db = await testDb(dialect);
    const provider = new LogProvider();
    const outbox = new Outbox(db, provider, sender);
    expect(await outbox.enqueue('device:d1', 'device-authorized', 'a@example.org', { device: 'Chrome', scopes: '读取' })).toBe('queued');
    expect(await outbox.enqueue('device:d1', 'device-authorized', 'a@example.org', { device: 'Chrome', scopes: '读取' })).toBe('duplicate');
    expect(await outbox.runDue()).toBe(1);
    expect(await outbox.runDue()).toBe(0);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ to: 'a@example.org', idempotencyKey: 'device:d1', from: sender.from, replyTo: sender.replyTo });
    expect(await db.get('select status, attempts from mail_outbox')).toEqual({ status: 'sent', attempts: 1 });
  });

  it('backs off after a temporary failure and sends on a later run', async () => {
    db = await testDb(dialect);
    let t = 1_000_000;
    const provider = new Flaky([new MailSendError(false, 'http_503', 'busy')]);
    const outbox = new Outbox(db, provider, sender, () => t);
    await outbox.enqueue('k', 'signed-out-everywhere', 'b@example.org', {});
    await outbox.runDue();
    expect(await db.get('select status, attempts, last_error_code from mail_outbox')).toEqual({ status: 'queued', attempts: 1, last_error_code: 'http_503' });
    expect(await outbox.runDue()).toBe(0); // not due yet
    t += 61_000;
    await outbox.runDue();
    expect(await db.get('select status from mail_outbox')).toEqual({ status: 'sent' });
    // The provider saw one idempotency key for both attempts.
    expect(new Set(provider.calls.map((c) => c.idempotencyKey))).toEqual(new Set(['k']));
  });

  it('stops at a permanent failure, suppresses the address and alerts without the address', async () => {
    db = await testDb(dialect);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outbox = new Outbox(db, new Flaky([new MailSendError(true, 'http_422', 'bad address')]), sender);
    await outbox.enqueue('k1', 'signed-out-everywhere', 'gone@example.org', {});
    await outbox.runDue();
    expect(await db.get('select status from mail_outbox')).toEqual({ status: 'failed' });
    expect(await db.get('select recipient_hash, reason from mail_suppression')).toEqual({ recipient_hash: recipientHash('gone@example.org'), reason: 'bounce:http_422' });
    expect(await outbox.enqueue('k2', 'signed-out-everywhere', 'GONE@example.org', {})).toBe('suppressed');
    expect(errors.mock.calls.flat().join(' ')).not.toContain('gone@example.org');
  });

  it('gives up after the last backoff step', async () => {
    db = await testDb(dialect);
    let t = 0;
    const outbox = new Outbox(db, new Flaky(Array.from({ length: 10 }, () => new MailSendError(false, 'network', 'down'))), sender, () => t);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await outbox.enqueue('k', 'signed-out-everywhere', 'c@example.org', {});
    for (let i = 0; i < 8; i++) {
      await outbox.runDue();
      t += 7 * 3_600_000;
    }
    expect(await db.get('select status, attempts from mail_outbox')).toEqual({ status: 'failed', attempts: 6 });
    // Temporary failures do not suppress the address.
    expect(await db.get('select count(*) as n from mail_suppression')).toEqual({ n: 0 });
  });
});

describe('Resend provider', () => {
  it('sends text only, with the idempotency key, and tells permanent from temporary failures', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(status === 200 ? { id: 're_1' } : { message: 'x' }), { status });
    }) as unknown as typeof fetch;
    const p = new ResendProvider('re_test_key', fetchFn);
    const mail = { from: 'a@x.org', replyTo: null, to: 'b@x.org', subject: 's', text: 't', idempotencyKey: 'idem-1' };
    expect(await p.send(mail)).toEqual({ id: 're_1' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ from: 'a@x.org', to: ['b@x.org'], subject: 's', text: 't' });
    status = 422;
    await expect(p.send(mail)).rejects.toMatchObject({ permanent: true, code: 'http_422' });
    status = 503;
    await expect(p.send(mail)).rejects.toMatchObject({ permanent: false, code: 'http_503' });
  });
});
