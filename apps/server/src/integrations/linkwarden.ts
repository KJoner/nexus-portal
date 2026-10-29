import type { Bookmark, LinkwardenStatus } from '@nexus/shared';
import type { DB } from '../db';
import type { NetPolicy } from '../net/ip';
import { getJson, UpstreamError } from '../net/http';
import type { SecretBox } from './secret';

/**
 * Response of Linkwarden `GET /api/v1/search` (checked against linkwarden/linkwarden source:
 * apps/web/lib/api/controllers/search/searchLinks.ts). With no hits, `data` may be `[]`.
 */
interface SearchResponse {
  data?: { links?: { id: number; name?: string; url?: string | null; description?: string; collection?: { name?: string } | null }[] } | unknown[];
}

const MAX_RESULTS = 8;

export class LinkwardenError extends Error {
  constructor(
    readonly code: 'not_configured' | 'unauthorized' | 'unreachable' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  base_url: string;
  token_enc: string;
  token_last4: string;
  last_ok_at: string | null;
  last_error: string | null;
}

export function normalizeBaseUrl(input: string): string {
  const u = new URL(input.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LinkwardenError('invalid', '地址只能是 http 或 https');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Read-only Linkwarden access. The token never leaves the server; only its last 4 characters do. */
export class Linkwarden {
  constructor(
    private db: DB,
    private box: SecretBox,
    private policy: NetPolicy,
    private fetchJson: typeof getJson = getJson,
  ) {}

  private row(): Row | undefined {
    return this.db.prepare("select * from integrations where id = 'linkwarden'").get() as Row | undefined;
  }

  status(): LinkwardenStatus {
    const r = this.row();
    return r ? { configured: true, baseUrl: r.base_url, tokenLast4: r.token_last4, lastOkAt: r.last_ok_at, lastError: r.last_error } : { configured: false, baseUrl: '', tokenLast4: '', lastOkAt: null, lastError: null };
  }

  private async query(baseUrl: string, token: string, q: string): Promise<Bookmark[]> {
    const url = new URL(`${baseUrl}/api/v1/search`);
    url.searchParams.set('sort', '0');
    url.searchParams.set('searchQueryString', q);
    let body: SearchResponse;
    try {
      body = (await this.fetchJson(url, { authorization: `Bearer ${token}` }, this.policy)) as SearchResponse;
    } catch (e) {
      if (e instanceof UpstreamError && (e.status === 401 || e.status === 403)) {
        const msg = (e.body as { response?: string } | null)?.response;
        throw new LinkwardenError('unauthorized', `令牌无效或已过期${msg ? `：${msg}` : ''}`);
      }
      throw new LinkwardenError('unreachable', e instanceof Error ? e.message : '无法连接 Linkwarden');
    }
    const data = body?.data;
    if (Array.isArray(data)) return [];
    if (!data || !Array.isArray(data.links)) throw new LinkwardenError('invalid', 'Linkwarden 返回的格式无法识别，请确认地址与版本');
    return data.links
      .filter((l) => typeof l.url === 'string' && /^https?:\/\//i.test(l.url))
      .slice(0, MAX_RESULTS)
      .map((l) => ({ id: String(l.id), title: (l.name || l.url!).slice(0, 200), url: l.url!, collection: l.collection?.name }));
  }

  /** Verifies the address and token with a real search before storing anything. */
  async connect(baseUrlInput: string, tokenInput: string | undefined): Promise<LinkwardenStatus> {
    const baseUrl = normalizeBaseUrl(baseUrlInput);
    const existing = this.row();
    const token = tokenInput?.trim() || (existing ? this.box.open(existing.token_enc) : '');
    if (!token) throw new LinkwardenError('invalid', '请填写访问令牌');
    await this.query(baseUrl, token, '');
    const now = new Date().toISOString();
    this.db
      .prepare("insert into integrations (id, base_url, token_enc, token_last4, last_ok_at, last_error, updated_at) values ('linkwarden', ?, ?, ?, ?, null, ?) on conflict(id) do update set base_url = excluded.base_url, token_enc = excluded.token_enc, token_last4 = excluded.token_last4, last_ok_at = excluded.last_ok_at, last_error = null, updated_at = excluded.updated_at")
      .run(baseUrl, this.box.seal(token), token.slice(-4), now, now);
    return this.status();
  }

  disconnect() {
    this.db.prepare("delete from integrations where id = 'linkwarden'").run();
  }

  async search(q: string): Promise<Bookmark[]> {
    const r = this.row();
    if (!r) throw new LinkwardenError('not_configured', '尚未连接 Linkwarden');
    try {
      const result = await this.query(r.base_url, this.box.open(r.token_enc), q.slice(0, 200));
      if (r.last_error) this.db.prepare("update integrations set last_error = null, last_ok_at = ? where id = 'linkwarden'").run(new Date().toISOString());
      return result;
    } catch (e) {
      if (e instanceof LinkwardenError) this.db.prepare("update integrations set last_error = ? where id = 'linkwarden'").run(e.message);
      throw e;
    }
  }
}
