import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type IconSource = 'di' | 'si' | 'fav';

const ORIGIN: Record<IconSource, (key: string) => string> = {
  di: (slug) => `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${slug}.svg`,
  si: (slug) => `https://cdn.simpleicons.org/${slug}`,
  fav: (host) => `https://icons.duckduckgo.com/ip3/${host}.ico`,
};
const ALLOWED_HOSTS = new Set(['cdn.jsdelivr.net', 'cdn.simpleicons.org', 'icons.duckduckgo.com']);
const KEY: Record<IconSource, RegExp> = {
  di: /^[a-z0-9][a-z0-9-]{0,63}$/,
  si: /^[a-z0-9][a-z0-9-]{0,63}$/,
  fav: /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
};
const TYPES = new Set(['image/svg+xml', 'image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp', 'image/jpeg', 'image/gif']);
const MAX_BYTES = 512 * 1024;
const TTL_OK = 7 * 86_400_000;
const TTL_MISS = 86_400_000;

export interface CachedIcon {
  status: 200 | 404;
  type: string;
  body: Buffer;
}

interface Meta {
  status: 200 | 404;
  type: string;
  fetchedAt: number;
}

export const isValidIconKey = (source: IconSource, key: string) => KEY[source].test(key);

/**
 * Brand icons fetched by Nexus from a fixed set of CDNs and kept on disk, so browsers never call
 * third-party icon services and icons keep working when those services are down.
 */
export class IconProxy {
  private inflight = new Map<string, Promise<CachedIcon>>();

  constructor(
    private dir: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async get(source: IconSource, key: string): Promise<CachedIcon> {
    const id = `${source}/${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const p = this.load(source, key, id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async load(source: IconSource, key: string, id: string): Promise<CachedIcon> {
    const file = join(this.dir, id);
    const cached = await this.read(file);
    const fresh = cached && Date.now() - cached.meta.fetchedAt < (cached.meta.status === 200 ? TTL_OK : TTL_MISS);
    if (cached && fresh) return { status: cached.meta.status, type: cached.meta.type, body: cached.body };
    try {
      const icon = await this.fetchOrigin(ORIGIN[source](key));
      await mkdir(join(this.dir, source), { recursive: true });
      await writeFile(file, icon.body);
      await writeFile(`${file}.json`, JSON.stringify({ status: icon.status, type: icon.type, fetchedAt: Date.now() } satisfies Meta));
      return icon;
    } catch (e) {
      // Origin unreachable: a stale icon beats a broken one.
      if (cached) return { status: cached.meta.status, type: cached.meta.type, body: cached.body };
      throw e;
    }
  }

  private async read(file: string): Promise<{ meta: Meta; body: Buffer } | null> {
    try {
      const meta = JSON.parse(await readFile(`${file}.json`, 'utf8')) as Meta;
      return { meta, body: await readFile(file) };
    } catch {
      return null;
    }
  }

  /** Redirects are followed by hand and only within the allow-listed CDN hosts. */
  private async fetchOrigin(url: string, hops = 0): Promise<CachedIcon> {
    const host = new URL(url).host;
    if (!ALLOWED_HOSTS.has(host) || hops > 3) throw new Error('icon origin not allowed');
    const res = await this.fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Nexus-IconCache/1', accept: 'image/*' } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('redirect without location');
      return this.fetchOrigin(new URL(next, url).toString(), hops + 1);
    }
    if (res.status === 404 || res.status === 410) return { status: 404, type: 'text/plain', body: Buffer.alloc(0) };
    if (!res.ok) throw new Error(`origin ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!TYPES.has(type)) throw new Error(`unexpected type ${type}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('icon too large');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error('icon too large');
    return { status: 200, type, body };
  }
}
