import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db';

/**
 * Product notification mail (ADR-018 / 契约 §7). Identity mail — verification, password reset,
 * e-mail change — is sent by the identity service; this outbox only carries this product's own
 * notices (a new device connected, everything signed out). Nothing here contains a password, a
 * token, a sign-in link or note content, and logs never carry a full address.
 */

export class MailSendError extends Error {
  constructor(
    /** Permanent: the provider rejected the message or the address; retrying cannot help. */
    readonly permanent: boolean,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OutgoingMail {
  from: string;
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  /** Lets the provider drop a duplicate if our first attempt's response was lost. */
  idempotencyKey: string;
}

export interface MailProvider {
  readonly name: string;
  send(mail: OutgoingMail): Promise<{ id: string }>;
}

export const recipientHash = (address: string) => createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
const short = (hash: string) => hash.slice(0, 10);

export type Template = 'device-authorized' | 'signed-out-everywhere' | 'signed-out-all-products';

export function render(template: Template, data: Record<string, string>): { subject: string; text: string } {
  switch (template) {
    case 'device-authorized':
      return {
        subject: '新的浏览器扩展已连接到你的 Nexus 账号',
        text: `你的 Nexus 账号刚刚授权了一个新设备：${data.device ?? '浏览器扩展'}（权限：${data.scopes ?? '读取导航'}）。\n\n如果这不是你本人的操作，请登录 Nexus，在「设置 › 账号与同步 › 浏览器扩展」中撤销它，并修改账号密码。\n\n这封邮件由系统自动发送，请勿直接回复。`,
      };
    case 'signed-out-everywhere':
      return {
        subject: '你的 Nexus 账号已在所有设备上退出',
        text: '刚才有人在你的 Nexus 账号中选择了「退出 Nexus 的全部设备」：Nexus 在所有浏览器的登录、已连接的扩展和尚未领取的扩展授权都已失效，需要重新登录或重新连接。账号中心与 LiteSync 的登录不受影响。\n\n如果这不是你本人的操作，请立即修改账号密码。\n\n这封邮件由系统自动发送，请勿直接回复。',
      };
    case 'signed-out-all-products':
      return {
        subject: '你的账号已在所有产品与设备上退出',
        text: '刚才有人在 Nexus 中选择了「退出所有产品与设备」：Nexus 的全部登录与已连接的扩展已失效，账号中心在所有浏览器的登录已结束，LiteSync 也会收到撤销通知（它的网页登录、Obsidian 设备与待领取授权随之失效；LiteSync 暂时连不上时 Nexus 会继续重试，状态可在「设置 › 账号与同步」查看）。\n\n如果这不是你本人的操作，请立即修改账号密码。\n\n这封邮件由系统自动发送，请勿直接回复。',
      };
  }
}

/** Development and tests: records that a message would have gone out, never its content. */
export class LogProvider implements MailProvider {
  readonly name = 'log';
  sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
    console.log(`[nexus] 邮件（log 模式，未真正发送）：${mail.subject} → ${short(recipientHash(mail.to))}`);
    return { id: `log-${randomBytes(6).toString('hex')}` };
  }
}

/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendProvider implements MailProvider {
  readonly name = 'resend';
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(mail: OutgoingMail) {
    let res: Response;
    try {
      res = await this.fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': mail.idempotencyKey },
        // Identity-adjacent notices: no click or open tracking (ADR-018).
        body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.replyTo ? { reply_to: mail.replyTo } : {}) }),
      });
    } catch {
      throw new MailSendError(false, 'network', '无法连接邮件服务商');
    }
    if (res.ok) return { id: String(((await res.json().catch(() => ({}))) as { id?: unknown }).id ?? '') };
    const permanent = res.status === 400 || res.status === 403 || res.status === 422;
    throw new MailSendError(permanent, `http_${res.status}`, `邮件服务商返回 HTTP ${res.status}`);
  }
}

/** Any SMTP relay (the provider's SMTP endpoint), via nodemailer. */
export class SmtpProvider implements MailProvider {
  readonly name = 'smtp';
  private transport: Promise<import('nodemailer').Transporter>;
  constructor(url: string) {
    this.transport = import('nodemailer').then((m) => m.createTransport(url));
  }

  async send(mail: OutgoingMail) {
    try {
      const info = await (await this.transport).sendMail({ from: mail.from, to: mail.to, replyTo: mail.replyTo ?? undefined, subject: mail.subject, text: mail.text, headers: { 'X-Nexus-Message': mail.idempotencyKey } });
      return { id: String(info.messageId ?? '') };
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode;
      throw new MailSendError(typeof code === 'number' && code >= 500, code ? `smtp_${code}` : 'network', '邮件发送失败');
    }
  }
}

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

interface Row {
  id: string;
  idempotency_key: string;
  template: Template;
  recipient: string;
  recipient_hash: string;
  data: string;
  attempts: number;
}

export type EnqueueResult = 'queued' | 'duplicate' | 'suppressed';

/**
 * Durable outbox: a message is stored before anything is sent, so a provider outage or a restart
 * never loses it, and the idempotency key means a retried trigger never sends it twice. Temporary
 * failures back off (1 min … 6 h); permanent ones stop at once and suppress the address.
 */
export class Outbox {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private db: DB,
    private provider: MailProvider,
    private sender: { from: string; replyTo: string | null },
    private now: () => number = Date.now,
  ) {}

  get providerName() {
    return this.provider.name;
  }

  async enqueue(idempotencyKey: string, template: Template, to: string, data: Record<string, string>): Promise<EnqueueResult> {
    const hash = recipientHash(to);
    if (await this.db.get('select 1 as x from mail_suppression where recipient_hash = ?', [hash])) return 'suppressed';
    const t = this.now();
    const r = await this.db.run(
      'insert into mail_outbox (id, idempotency_key, template, recipient, recipient_hash, data, status, attempts, next_attempt_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) on conflict (idempotency_key) do nothing',
      [`m-${randomBytes(10).toString('hex')}`, idempotencyKey, template, to.trim(), hash, JSON.stringify(data), 'queued', t, t, t],
    );
    return r.changes ? 'queued' : 'duplicate';
  }

  /** Sends what is due; returns how many were handled. Concurrent calls share one run. */
  runDue(limit = 20): Promise<number> {
    this.running ??= this.process(limit).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async process(limit: number): Promise<number> {
    const due = await this.db.all<Row>("select id, idempotency_key, template, recipient, recipient_hash, data, attempts from mail_outbox where status = 'queued' and next_attempt_at <= ? order by next_attempt_at limit ?", [this.now(), limit]);
    let handled = 0;
    for (const m of due) {
      // Claim it: another process (or a second instance) must not send the same message.
      const claim = await this.db.run("update mail_outbox set status = 'sending', updated_at = ? where id = ? and status = 'queued'", [this.now(), m.id]);
      if (!claim.changes) continue;
      handled++;
      const { subject, text } = render(m.template, JSON.parse(m.data) as Record<string, string>);
      const attempts = Number(m.attempts) + 1;
      try {
        const { id } = await this.provider.send({ ...this.sender, to: m.recipient, subject, text, idempotencyKey: m.idempotency_key });
        await this.db.run("update mail_outbox set status = 'sent', attempts = ?, provider_message_id = ?, last_error_code = null, updated_at = ? where id = ?", [attempts, id, this.now(), m.id]);
      } catch (e) {
        const err = e instanceof MailSendError ? e : new MailSendError(false, 'error', String(e));
        if (err.permanent || attempts >= MAX_ATTEMPTS) {
          await this.db.run("update mail_outbox set status = 'failed', attempts = ?, last_error_code = ?, updated_at = ? where id = ?", [attempts, err.code, this.now(), m.id]);
          if (err.permanent) await this.suppress(m.recipient_hash, `bounce:${err.code}`);
          // Administrator alert: the code and a short hash only.
          console.error(`[nexus] 邮件发送失败（${err.permanent ? '永久' : '多次重试后'}）：${m.template} → ${short(m.recipient_hash)}，${err.code}`);
        } else {
          await this.db.run("update mail_outbox set status = 'queued', attempts = ?, last_error_code = ?, next_attempt_at = ?, updated_at = ? where id = ?", [attempts, err.code, this.now() + BACKOFF_MS[attempts - 1]!, this.now(), m.id]);
        }
      }
    }
    return handled;
  }

  /** Hard bounce or complaint: stop writing to this address. */
  async suppress(hash: string, reason: string) {
    await this.db.run('insert into mail_suppression (recipient_hash, reason, created_at) values (?, ?, ?) on conflict (recipient_hash) do nothing', [hash, reason.slice(0, 80), this.now()]);
  }

  start(intervalMs = 30_000) {
    this.timer ??= setInterval(() => void this.runDue().catch((e) => console.error('[nexus] 邮件队列处理出错', e)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createProvider(cfg: { provider: 'log' | 'smtp' | 'resend'; smtpUrl: string | null; resendKey: string | null }): MailProvider {
  if (cfg.provider === 'resend' && cfg.resendKey) return new ResendProvider(cfg.resendKey);
  if (cfg.provider === 'smtp' && cfg.smtpUrl) return new SmtpProvider(cfg.smtpUrl);
  return new LogProvider();
}
